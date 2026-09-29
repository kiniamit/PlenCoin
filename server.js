import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './src/env.js';
import { hasCredentials } from './src/coinbase.js';
import { getPortfolio } from './src/portfolio.js';
import { getMockPortfolio } from './src/mock.js';
import { getAssetDetail } from './src/asset.js';
import { getUpcomingOrders } from './src/orders.js';
import { readDigest, scanSignals, writeDigest } from './src/signals.js';
import {
  clearFailures,
  clientKey,
  hasValidSession,
  isEnabled as authEnabled,
  issueSessionCookie,
  lockoutRemaining,
  passphraseMatches,
  recordFailure,
} from './src/auth.js';
import { getMockAsset, getMockOrders, getMockSignals } from './src/mock.js';

loadEnvFile();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const MOCK = process.env.MOCK === '1' || process.env.MOCK === 'true' || process.argv.includes('--mock');
const CACHE_MS = Number.parseInt(process.env.CACHE_MS ?? '15000', 10);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

let cache = { at: 0, payload: null };
// Rebuilding cost basis costs several paginated calls, so hold it longer.
const assetCache = new Map();
const ASSET_CACHE_MS = Number.parseInt(process.env.ASSET_CACHE_MS ?? '60000', 10);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function servePortfolio(res, { refresh }) {
  if (MOCK) return sendJson(res, 200, getMockPortfolio());

  if (!refresh && cache.payload && Date.now() - cache.at < CACHE_MS) {
    return sendJson(res, 200, { ...cache.payload, cached: true });
  }

  try {
    const payload = await getPortfolio();
    cache = { at: Date.now(), payload };
    sendJson(res, 200, payload);
  } catch (error) {
    const status = error.status === 401 || error.status === 403 ? 502 : (error.status ?? 500);
    console.error('[portfolio]', error.message);
    sendJson(res, status >= 400 && status < 600 ? status : 500, {
      error: error.message,
      hint: error.status === 401 || error.status === 403
        ? 'Coinbase rejected the key. Check COINBASE_API_KEY_NAME / COINBASE_API_PRIVATE_KEY and that the key has View permission.'
        : undefined,
    });
  }
}

async function serveAsset(res, symbol, { refresh }) {
  if (MOCK) return sendJson(res, 200, getMockAsset(symbol));

  const key = String(symbol).toUpperCase();
  const hit = assetCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < ASSET_CACHE_MS) {
    return sendJson(res, 200, { ...hit.payload, cached: true });
  }

  try {
    const payload = await getAssetDetail(symbol);
    assetCache.set(key, { at: Date.now(), payload });
    sendJson(res, 200, payload);
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status >= 500) console.error('[asset]', error.message);
    sendJson(res, status, { error: error.message });
  }
}

let ordersCache = { at: 0, payload: null };

const SCAN_INTERVAL_MS = Number.parseInt(process.env.SCAN_INTERVAL_MS ?? String(60 * 60_000), 10);
let digest = null;
let scanning = null;

/**
 * A sweep costs ~150 paginated calls, so only one runs at a time and callers
 * share the in-flight promise rather than queueing another.
 */
function runScan(reason) {
  if (scanning) return scanning;

  scanning = (async () => {
    const startedAt = Date.now();
    console.log(`[signals] scan started (${reason})`);
    try {
      const result = await scanSignals();
      digest = result;
      await writeDigest(result);
      console.log(
        `[signals] ${result.signals.length} signal(s) across ${result.assetsScanned.length} assets ` +
          `in ${Math.round((Date.now() - startedAt) / 1000)}s`,
      );
      return result;
    } catch (error) {
      console.error('[signals] scan failed:', error.message);
      throw error;
    } finally {
      scanning = null;
    }
  })();

  return scanning;
}

async function serveSignals(res, { rescan }) {
  if (MOCK) return sendJson(res, 200, getMockSignals());

  try {
    if (rescan) {
      return sendJson(res, 200, { ...(await runScan('manual')), scanning: false });
    }

    if (!digest) digest = await readDigest();
    if (!digest) {
      // Nothing on disk yet and the boot scan is still going.
      runScan('on demand');
      return sendJson(res, 200, {
        generatedAt: null,
        signals: [],
        assetsScanned: [],
        warnings: [],
        scanning: true,
      });
    }

    sendJson(res, 200, { ...digest, scanning: Boolean(scanning) });
  } catch (error) {
    console.error('[signals]', error.message);
    sendJson(res, 500, { error: error.message });
  }
}

async function serveOrders(res, { refresh }) {
  if (MOCK) return sendJson(res, 200, getMockOrders());

  if (!refresh && ordersCache.payload && Date.now() - ordersCache.at < CACHE_MS) {
    return sendJson(res, 200, { ...ordersCache.payload, cached: true });
  }

  try {
    const payload = await getUpcomingOrders();
    ordersCache = { at: Date.now(), payload };
    sendJson(res, 200, payload);
  } catch (error) {
    console.error('[orders]', error.message);
    sendJson(res, error.status ?? 500, { error: error.message });
  }
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);

  // Refuse anything that escapes public/ via .. or an absolute path.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'Content-Length': file.length,
      // Local dashboard: always revalidate so edits to public/ show on a plain reload.
      'Cache-Control': 'no-store',
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

// Reachable without a session: the gate itself, and what it needs to render.
const PUBLIC_PATHS = new Set(['/login.html', '/styles.css', '/login.js', '/api/login', '/favicon.ico']);

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleLogin(req, res) {
  const key = clientKey(req);
  const wait = lockoutRemaining(key);
  if (wait > 0) {
    return sendJson(res, 429, {
      error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`,
      retryAfterSeconds: Math.ceil(wait / 1000),
    });
  }

  let passphrase;
  try {
    ({ passphrase } = JSON.parse(await readBody(req)));
  } catch {
    return sendJson(res, 400, { error: 'Expected JSON: { "passphrase": "..." }' });
  }

  if (!passphraseMatches(passphrase)) {
    const record = recordFailure(key);
    console.warn(`[auth] failed attempt from ${key} (${record.count})`);
    // A flat delay blunts scripted guessing without annoying a human typo.
    await new Promise((r) => setTimeout(r, 300));
    return sendJson(res, 401, { error: 'Wrong passphrase.' });
  }

  clearFailures(key);
  res.setHeader('Set-Cookie', issueSessionCookie());
  return sendJson(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/login') {
    return handleLogin(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (authEnabled() && !PUBLIC_PATHS.has(url.pathname) && !hasValidSession(req)) {
    // The API answers honestly; a page navigation gets the login screen.
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 401, { error: 'Not signed in.', login: '/login.html' });
    }
    res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url.pathname === '/api/portfolio') {
    return servePortfolio(res, { refresh: url.searchParams.get('refresh') === '1' });
  }

  if (url.pathname === '/api/orders') {
    return serveOrders(res, { refresh: url.searchParams.get('refresh') === '1' });
  }

  if (url.pathname === '/api/signals') {
    return serveSignals(res, { rescan: url.searchParams.get('rescan') === '1' });
  }

  if (url.pathname === '/api/asset') {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) return sendJson(res, 400, { error: 'Missing ?symbol=' });
    return serveAsset(res, symbol, { refresh: url.searchParams.get('refresh') === '1' });
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      mock: MOCK,
      credentials: MOCK ? 'mock' : hasCredentials() ? 'configured' : 'missing',
    });
  }

  // Falling through to the static 404 would hand the page HTML/plain text
  // where it expects JSON, which surfaces as an unreadable parse error.
  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `Unknown API route: ${url.pathname}` });
  }

  return serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`PlenCoin -> http://${HOST}:${PORT}`);
  if (authEnabled()) {
    console.log('Passphrase gate: on.');
  } else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.warn(
      `WARNING: listening on ${HOST} with no passphrase. Anyone on this network can read your ` +
        'portfolio. Set APP_PASSPHRASE in .env, or set HOST=127.0.0.1.',
    );
  }

  if (!MOCK && hasCredentials()) {
    // Kick off in the background so the first page load is not blocked.
    runScan('startup').catch(() => {});
    setInterval(() => runScan('hourly').catch(() => {}), SCAN_INTERVAL_MS).unref();
  }
  if (MOCK) {
    console.log('Mock mode: serving sample data, Coinbase is not contacted.');
  } else if (!hasCredentials()) {
    console.warn('No Coinbase credentials found. Copy .env.example to .env, or run `npm run mock`.');
  }
});
