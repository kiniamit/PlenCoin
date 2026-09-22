import { readFileSync } from 'node:fs';

/**
 * Minimal .env loader so local dev works on Node 18 (no --env-file, no dotenv).
 * Values already present in process.env win, which is what CI wants.
 */
export function loadEnvFile(path = '.env') {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);

    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Reads a var, accepting a couple of aliases so existing CI names keep working. */
export function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}
