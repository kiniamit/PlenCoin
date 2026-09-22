import crypto from 'node:crypto';
import { env } from './env.js';

const HOST = 'api.coinbase.com';
const BASE = `https://${HOST}`;

export class CoinbaseError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'CoinbaseError';
    this.status = status;
    this.body = body;
  }
}

export function getCredentials() {
  const keyName = env('COINBASE_API_KEY_NAME', 'COINBASE_API_KEY', 'CDP_API_KEY_NAME');
  const privateKey = env('COINBASE_API_PRIVATE_KEY', 'COINBASE_API_SECRET', 'CDP_API_KEY_PRIVATE_KEY');

  if (!keyName || !privateKey) {
    const missing = [
      !keyName && 'COINBASE_API_KEY_NAME',
      !privateKey && 'COINBASE_API_PRIVATE_KEY',
    ].filter(Boolean);
    throw new CoinbaseError(`Missing credentials: ${missing.join(', ')}. See .env.example.`, { status: 503 });
  }

  return { keyName, privateKey };
}

export function hasCredentials() {
  try {
    getCredentials();
    return true;
  } catch {
    return false;
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * CDP keys come in two shapes: an EC P-256 PEM (signed ES256) or a base64
 * Ed25519 keypair, where the first 32 bytes are the seed (signed EdDSA).
 */
function loadPrivateKey(raw) {
  const normalized = raw.replace(/\\n/g, '\n').trim();

  if (normalized.includes('-----BEGIN')) {
    return { key: crypto.createPrivateKey(normalized), alg: 'ES256' };
  }

  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new CoinbaseError(
      'Unrecognised private key. Expected an EC private key PEM or a base64 Ed25519 key.',
      { status: 503 },
    );
  }

  const seed = bytes.subarray(0, 32);
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return { key: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }), alg: 'EdDSA' };
}

function sign(signingInput, key, alg) {
  const data = Buffer.from(signingInput);
  return alg === 'EdDSA'
    ? crypto.sign(null, data, key)
    : crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
}

/**
 * Builds the short-lived JWT Coinbase expects. `uri` is method + host + path,
 * deliberately without the query string.
 */
export function buildJwt({ method, path, credentials = getCredentials() }) {
  const { key, alg } = loadPrivateKey(credentials.privateKey);
  const now = Math.floor(Date.now() / 1000);

  const header = {
    typ: 'JWT',
    alg,
    kid: credentials.keyName,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const payload = {
    iss: 'cdp',
    sub: credentials.keyName,
    nbf: now,
    exp: now + 120,
    uri: `${method.toUpperCase()} ${HOST}${path}`,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  return `${signingInput}.${sign(signingInput, key, alg).toString('base64url')}`;
}

/** Authenticated GET against the Advanced Trade API. `path` excludes the query string. */
export async function signedGet(path, query = {}, { credentials, timeoutMs = 15000 } = {}) {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }

  const token = buildJwt({ method: 'GET', path, credentials });
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const detail = body?.message || body?.error_details || body?.error || response.statusText;
    throw new CoinbaseError(`Coinbase ${response.status} on ${path}: ${detail}`, {
      status: response.status,
      body,
    });
  }

  return body;
}

/** Public endpoint, no auth: every rate quoted against one base currency. */
export async function fetchExchangeRates(currency = 'USD', { timeoutMs = 15000 } = {}) {
  const response = await fetch(`${BASE}/v2/exchange-rates?currency=${encodeURIComponent(currency)}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new CoinbaseError(`Coinbase ${response.status} on /v2/exchange-rates`, { status: response.status });
  }
  const body = await response.json();
  return body?.data?.rates ?? {};
}

/** Walks the cursor until Coinbase stops handing out pages. */
export async function fetchAllAccounts(options = {}) {
  const accounts = [];
  let cursor;

  for (let page = 0; page < 20; page += 1) {
    const body = await signedGet('/api/v3/brokerage/accounts', { limit: 250, cursor }, options);
    accounts.push(...(body?.accounts ?? []));
    cursor = body?.cursor;
    if (!body?.has_next || !cursor) break;
  }

  return accounts;
}

export async function fetchPortfolios(options = {}) {
  const body = await signedGet('/api/v3/brokerage/portfolios', {}, options);
  return body?.portfolios ?? [];
}

/**
 * The breakdown is the only place staked funds show up: /accounts returns
 * wallet balances only, so anything staked is invisible there.
 */
export async function fetchPortfolioBreakdown(uuid, options = {}) {
  const body = await signedGet(`/api/v3/brokerage/portfolios/${uuid}`, {}, options);
  return body?.breakdown ?? null;
}

/**
 * The v2 account list. Unlike the Advanced Trade accounts endpoint this one
 * carries the per-wallet ids the transaction ledger is keyed by.
 */
export async function fetchV2Accounts(options = {}) {
  const body = await signedGet('/v2/accounts', { limit: 100 }, options);
  return body?.data ?? [];
}

/**
 * The full transaction ledger for one wallet: trades, converts, staking
 * rewards, transfers and sends, each with a signed crypto amount and the USD
 * value at the time. This is the only complete record of what moved.
 */
export async function fetchV2Transactions(accountId, options = {}) {
  const transactions = [];
  let path = `/v2/accounts/${accountId}/transactions`;
  let query = { limit: 100 };

  for (let page = 0; page < 60; page += 1) {
    const body = await signedGet(path, query, options);
    transactions.push(...(body?.data ?? []));

    const next = body?.pagination?.next_uri;
    if (!next) break;
    const [nextPath, nextQuery] = next.split('?');
    path = nextPath;
    query = Object.fromEntries(new URLSearchParams(nextQuery ?? ''));
  }

  return transactions;
}

/** Fills for one product. `maxPages` caps the walk when a sample is enough. */
export async function fetchFills(productId, options = {}) {
  const { maxPages = 100 } = options;
  const fills = [];
  let cursor;

  for (let page = 0; page < maxPages; page += 1) {
    const body = await signedGet(
      '/api/v3/brokerage/orders/historical/fills',
      { product_ids: productId, limit: 100, cursor },
      options,
    );
    fills.push(...(body?.fills ?? []));
    cursor = body?.cursor;
    if (!cursor) break;
  }

  return fills;
}

/**
 * Every resting order, all products at once.
 *
 * The endpoint's pagination is unusable here: without a product filter it caps
 * at 100 and still reports `has_next: false` with an empty cursor. A large
 * `limit` is the only way to get the full set, so the caller must check
 * whether the result came back at the cap.
 */
export async function fetchAllOpenOrders(options = {}) {
  const { limit = 1000 } = options;
  const body = await signedGet(
    '/api/v3/brokerage/orders/historical/batch',
    { order_status: 'OPEN', limit },
    options,
  );
  return { orders: body?.orders ?? [], limit };
}

/** Resting orders for one product. */
export async function fetchOpenOrders(productId, options = {}) {
  const orders = [];
  let cursor;

  for (let page = 0; page < 20; page += 1) {
    const body = await signedGet(
      '/api/v3/brokerage/orders/historical/batch',
      { product_ids: productId, order_status: 'OPEN', limit: 100, cursor },
      options,
    );
    orders.push(...(body?.orders ?? []));
    cursor = body?.cursor;
    if (!cursor || !body?.has_next) break;
  }

  return orders;
}

/** Spot products for the assets actually held, for price + 24h change in one call. */
export async function fetchProducts(productIds, options = {}) {
  if (productIds.length === 0) return [];

  const products = [];
  for (let i = 0; i < productIds.length; i += 50) {
    const chunk = productIds.slice(i, i + 50);
    const body = await signedGet(
      '/api/v3/brokerage/market/products',
      { product_ids: chunk, product_type: 'SPOT', limit: chunk.length },
      options,
    );
    products.push(...(body?.products ?? []));
  }

  return products;
}
