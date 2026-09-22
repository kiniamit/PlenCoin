import crypto from 'node:crypto';
import { env } from './env.js';

const COOKIE_NAME = 'plencoin_session';
const SESSION_DAYS = Number.parseInt(process.env.SESSION_DAYS ?? '30', 10);

// Brute-force backoff, per client address.
const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
const attempts = new Map();

export function getPassphrase() {
  return env('APP_PASSPHRASE', 'PLENCOIN_PASSPHRASE');
}

/** No passphrase configured means no gate - localhost-only use stays frictionless. */
export function isEnabled() {
  return Boolean(getPassphrase());
}

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url');
}

function parseCookies(header = '') {
  const jar = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
}

/**
 * Compares digests rather than the raw strings so the check takes the same
 * time regardless of how much of the passphrase is correct.
 */
export function passphraseMatches(candidate) {
  const secret = getPassphrase();
  if (!secret || typeof candidate !== 'string' || candidate.length === 0) return false;
  return crypto.timingSafeEqual(sha256(candidate), sha256(secret));
}

/**
 * The cookie is `<expiry>.<hmac>`, signed with the passphrase itself, so
 * sessions survive a server restart but die the moment the passphrase changes.
 */
export function issueSessionCookie() {
  const secret = getPassphrase();
  const expiresAt = Date.now() + SESSION_DAYS * 86400_000;
  const token = `${expiresAt}.${sign(expiresAt, secret)}`;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function hasValidSession(req) {
  const secret = getPassphrase();
  if (!secret) return true;

  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return false;

  const split = token.lastIndexOf('.');
  if (split === -1) return false;

  const expiresAt = Number(token.slice(0, split));
  const signature = token.slice(split + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const expected = sign(expiresAt, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function clientKey(req) {
  return req.socket.remoteAddress ?? 'unknown';
}

/** Milliseconds this caller must wait, or 0 if it may try now. */
export function lockoutRemaining(key) {
  const record = attempts.get(key);
  if (!record?.until) return 0;
  return Math.max(0, record.until - Date.now());
}

export function recordFailure(key) {
  const record = attempts.get(key) ?? { count: 0, until: 0 };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    const over = record.count - MAX_ATTEMPTS;
    record.until = Date.now() + Math.min(BASE_LOCKOUT_MS * 2 ** over, MAX_LOCKOUT_MS);
  }
  attempts.set(key, record);
  return record;
}

export function clearFailures(key) {
  attempts.delete(key);
}
