#!/usr/bin/env node
/**
 * Smoke test for the Coinbase credentials. Prints a summary and exits non-zero
 * on failure, so it works as a CI step that only needs the env vars set.
 */
import { loadEnvFile } from '../src/env.js';
import { getCredentials, signedGet } from '../src/coinbase.js';

loadEnvFile();

try {
  const { keyName } = getCredentials();
  console.log(`Key: ${keyName}`);

  const body = await signedGet('/api/v3/brokerage/accounts', { limit: 1 });
  const accounts = body?.accounts ?? [];

  console.log(`Authenticated. Read ${accounts.length} account${accounts.length === 1 ? '' : 's'} (limit 1).`);
  if (accounts[0]) {
    console.log(`Sample: ${accounts[0].currency} — ${accounts[0].available_balance?.value ?? '0'} available`);
  }
  console.log('OK');
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  if (error.status === 401 || error.status === 403) {
    console.error('Check the key name, the private key formatting, and that the key has View permission.');
  }
  process.exit(1);
}
