import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPortfolio } from './portfolio.js';
import { getAssetDetail } from './asset.js';
import { classifyLadderTax } from './pnl.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(STORE_DIR, 'signals.json');

// Only these two ask the user to do something about a date.
const ACTIONABLE = new Set(['wait', 'st-loss-expiring']);

// A few assets at a time: quick enough, nowhere near Coinbase's 30/s.
const CONCURRENCY = 3;

async function mapLimit(items, limit, worker) {
  const results = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * One flagged order, with enough context to judge it without opening the
 * asset page. Dates are absolute; the countdown is derived at render time.
 */
function toSignal({ currency, row, tax, ladder, index }) {
  // What it would cost to reach this rung: everything ahead of it must sell first.
  const ahead = ladder.slice(0, index);
  const aheadQty = ahead.reduce((sum, r) => sum + r.size, 0);
  const aheadGain = ahead.reduce((sum, r) => sum + r.tax.gain, 0);
  const aheadLongGain = ahead.reduce((sum, r) => sum + r.tax.longGain, 0);

  const isLoss = tax.signal === 'st-loss-expiring';

  return {
    // Stable across scans, so a dismissal can stick to one situation.
    key: `${currency}:${row.orderId}:${tax.signal}`,
    currency,
    orderId: row.orderId,
    signal: tax.signal,
    step: index + 1,

    size: row.size,
    limitPrice: row.limitPrice,
    notional: row.size * row.limitPrice,

    // 'wait' needs every lot long-term, so it watches the last crossover.
    // An expiring loss is spoiled by the first, so it watches that one.
    deadline: isLoss ? tax.firstLongTermOn : tax.longTermOn,

    gain: tax.gain,
    atStake: tax.shortGain,
    shortQty: tax.shortQty,
    longQty: tax.longQty,
    avgAgeDays: tax.avgAgeDays,

    aheadQty,
    aheadGain,
    aheadLongGain,
  };
}

/** Walks every holding and collects the orders with a date attached. */
export async function scanSignals({ nearDays = 45 } = {}) {
  const startedAt = Date.now();
  const warnings = [];
  const signals = [];
  const orderIds = [];

  const portfolio = await getPortfolio();
  const candidates = portfolio.holdings
    .filter((h) => h.currency !== portfolio.quoteCurrency && !h.isDust)
    .map((h) => h.currency);

  const scanned = [];
  await mapLimit(candidates, CONCURRENCY, async (currency) => {
    let detail;
    try {
      detail = await getAssetDetail(currency);
    } catch (error) {
      warnings.push(`${currency}: ${error.message}`);
      return;
    }

    scanned.push(currency);
    if (detail.sellOrders.length === 0 || detail.lots.length === 0) return;

    const orders = [...detail.sellOrders].sort((a, b) => a.limitPrice - b.limitPrice);
    for (const order of orders) orderIds.push(order.orderId);

    const tax = classifyLadderTax({
      lots: detail.lots,
      orders,
      feeRate: detail.feeRate,
      nearDays,
    });
    const ladder = orders.map((row, i) => ({ ...row, tax: tax[i] }));

    ladder.forEach((row, index) => {
      if (!ACTIONABLE.has(row.tax.signal) || !row.tax.firstLongTermOn) return;
      signals.push(toSignal({ currency, row, tax: row.tax, ladder, index }));
    });
  });

  // Soonest deadline first; ties broken by how much is riding on it.
  signals.sort(
    (a, b) =>
      new Date(a.deadline) - new Date(b.deadline) || Math.abs(b.atStake) - Math.abs(a.atStake),
  );

  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    nearDays,
    assetsScanned: scanned.sort(),
    // Lets a later freshness check spot a filled or cancelled order cheaply.
    orderIds: orderIds.sort(),
    signals,
    warnings,
  };
}

export async function readDigest() {
  try {
    return JSON.parse(await readFile(STORE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeDigest(digest) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, `${JSON.stringify(digest, null, 2)}\n`, 'utf8');
}
