import { fetchFills, fetchOpenOrders, fetchV2Accounts, fetchV2Transactions } from './coinbase.js';
import { getPortfolio } from './portfolio.js';
import { effectiveFeeRate, extractSellOrders, longTermFrom, normaliseLedger, walkLedgerHifo } from './pnl.js';

const QUOTE = 'USD';
// Above this the rebuilt quantity disagrees with the position enough that cost
// basis should be treated as an estimate rather than a fact.
const RECONCILE_TOLERANCE = 0.005; // 0.5%

let accountCache = { at: 0, accounts: null };
const ACCOUNTS_TTL_MS = 5 * 60 * 1000;

async function getV2Accounts() {
  if (accountCache.accounts && Date.now() - accountCache.at < ACCOUNTS_TTL_MS) {
    return accountCache.accounts;
  }
  const accounts = await fetchV2Accounts();
  accountCache = { at: Date.now(), accounts };
  return accounts;
}

/**
 * Every ledger entry for one asset, across all of its wallets. An asset can
 * have several - a spot wallet and a staking wallet, for instance - and the
 * staking wallet is where rewards land.
 */
async function fetchAssetLedger(currency) {
  const accounts = (await getV2Accounts()).filter(
    (account) => (account.currency?.code ?? account.currency) === currency,
  );

  const transactions = [];
  for (const account of accounts) {
    // Tag the wallet: staked coins cannot be sold, so their lots are kept
    // in a separate pool the sell ladder never draws from.
    const stakedWallet = /stake/i.test(account.name ?? '');
    for (const tx of await fetchV2Transactions(account.id)) {
      transactions.push({ ...tx, stakedWallet });
    }
  }

  return { transactions, walletCount: accounts.length };
}

/**
 * Everything the sell planner needs for one asset: the position as Coinbase
 * reports it, lifetime P/L rebuilt from the transaction ledger, and the
 * resting sell orders.
 */
export async function getAssetDetail(symbol) {
  const currency = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,15}$/.test(currency)) {
    const error = new Error(`Invalid asset symbol: ${symbol}`);
    error.status = 400;
    throw error;
  }

  const warnings = [];
  const portfolio = await getPortfolio();
  const holding = portfolio.holdings.find((h) => h.currency === currency);

  if (!holding) {
    const error = new Error(`No ${currency} position found in your portfolio.`);
    error.status = 404;
    throw error;
  }

  if (currency === QUOTE) {
    const error = new Error('Cash has nothing to plan a sell against.');
    error.status = 400;
    throw error;
  }

  const productId = `${currency}-${QUOTE}`;
  const [ledger, openOrders, feeSample] = await Promise.all([
    fetchAssetLedger(currency).catch((e) => {
      warnings.push(`Could not load the transaction ledger: ${e.message}`);
      return { transactions: [], walletCount: 0 };
    }),
    fetchOpenOrders(productId).catch((e) => {
      warnings.push(`Could not load open orders: ${e.message}`);
      return [];
    }),
    // One page is plenty to blend a fee rate, and keeps the page responsive.
    fetchFills(productId, { maxPages: 1 }).catch(() => []),
  ]);

  const entries = normaliseLedger(ledger.transactions);
  const walk = walkLedgerHifo(entries);

  const heldQty = holding.amount;
  const currentPrice = holding.price;
  const value = holding.value;

  const drift = heldQty > 0 ? Math.abs(walk.remainingQty - heldQty) / heldQty : 0;
  const reconciled = entries.length > 0 && drift <= RECONCILE_TOLERANCE;

  // Even when the rebuild drifts, an average-cost estimate beats showing zero.
  const costBasis = reconciled ? walk.remainingBasis : walk.avgEntry * heldQty;
  const avgEntry = walk.avgEntry || null;
  const realizedPL = entries.length > 0 ? walk.realized : 0;
  const unrealizedPL = entries.length > 0 ? value - costBasis : 0;
  const lifetimePL = realizedPL + unrealizedPL;

  if (entries.length === 0) {
    warnings.push(
      `No ${currency} transaction history found, so there is no cost basis to work from. ` +
        'Lifetime P/L is shown as 0; the sell ladder below is still meaningful.',
    );
  } else if (!reconciled) {
    warnings.push(
      `Ledger rebuilds ${walk.remainingQty.toFixed(8)} ${currency} but you hold ${heldQty.toFixed(8)} ` +
        `(${(drift * 100).toFixed(2)}% apart). Cost basis is estimated from the average entry price, ` +
        'so lifetime P/L is approximate.',
    );
  }

  if (walk.sendCount > 0) {
    warnings.push(
      `${walk.sendCount} withdrawal${walk.sendCount === 1 ? '' : 's'} (${walk.sentQty.toFixed(8)} ${currency}) ` +
        'left the account. Those remove cost basis without realizing a gain, so realized P/L covers sales only.',
    );
  }

  const sellOrders = extractSellOrders(openOrders);
  const buyOrderCount = openOrders.filter((o) => o.side === 'BUY').length;

  const laddered = sellOrders.reduce((sum, o) => sum + o.size, 0);
  if (entries.length > 0 && laddered > walk.spotQty + 1e-8) {
    warnings.push(
      `Sell orders total ${laddered.toFixed(8)} ${currency} but only ${walk.spotQty.toFixed(8)} is ` +
        'unstaked and sellable. The rungs past that point have no cost basis to draw on.',
    );
  }

  // Lots go to the browser so what-if rows get the same tax treatment as real
  // orders. Counts are small - tens, not thousands.
  const now = new Date();
  const decorate = (lot) => ({
    qty: lot.qty,
    price: lot.price,
    acquiredAt: lot.acquiredAt,
    longTermOn: longTermFrom(lot.acquiredAt).toISOString(),
  });
  // Only sellable lots go to the ladder; staked ones are reported separately.
  const lots = walk.lots.map(decorate);
  const stakedLots = walk.stakedLots.map(decorate);
  const isLong = (l) => now >= new Date(l.longTermOn);
  const longTermQty = [...lots, ...stakedLots].reduce((sum, l) => sum + (isLong(l) ? l.qty : 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    currency,
    productId,
    quoteCurrency: QUOTE,

    heldQty,
    currentPrice,
    value,
    staked: holding.staked,
    hold: holding.hold,

    costBasis,
    avgEntry,
    realizedPL,
    unrealizedPL,
    lifetimePL,
    reconciled,

    // Rewards are acquisitions with no purchase behind them.
    rewardQty: walk.incomeQty,
    rewardValue: walk.incomeValue,

    feeRate: effectiveFeeRate(feeSample),
    ledgerEntries: entries.length,
    walletCount: ledger.walletCount,
    firstTrade: entries[0]?.time ?? null,
    lastTrade: entries.at(-1)?.time ?? null,

    lots,
    lotCount: lots.length,
    stakedLotCount: stakedLots.length,
    // What the ladder can actually draw on, versus what is locked away.
    sellableQty: walk.spotQty,
    sellableBasis: walk.spotBasis,
    stakedQty: walk.stakedQty,
    stakedBasis: walk.stakedBasis,
    longTermQty,
    longTermShare: heldQty > 0 ? longTermQty / heldQty : 0,

    sellOrders,
    buyOrderCount,
    warnings,
  };
}
