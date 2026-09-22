import {
  fetchAllAccounts,
  fetchExchangeRates,
  fetchPortfolioBreakdown,
  fetchPortfolios,
  fetchProducts,
} from './coinbase.js';

const QUOTE = 'USD';
const DUST_THRESHOLD = 0.01; // in quote currency
const STAKED = 'ACCOUNT_TYPE_STAKED_FUNDS';

function toNumber(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The breakdown reports quantities as JSON floats (~8 significant digits), so
 * subtracting two of them leaves noise: 986.2275 - 454.72748 = 531.50002.
 */
function trimFloatNoise(n) {
  return n === 0 ? 0 : Number(n.toPrecision(6));
}

/** Every spot position across every portfolio, wallet and staked alike. */
async function fetchPositions(warnings) {
  const portfolios = await fetchPortfolios();
  const positions = [];

  for (const portfolio of portfolios) {
    if (portfolio.deleted) continue;
    try {
      const breakdown = await fetchPortfolioBreakdown(portfolio.uuid);
      positions.push(...(breakdown?.spot_positions ?? []));
    } catch (error) {
      warnings.push(`Could not read portfolio "${portfolio.name}": ${error.message}`);
    }
  }

  return positions;
}

/**
 * One row per asset. An asset can appear several times - a wallet position plus
 * a staked one - and Coinbase already values each in fiat, so we trust its
 * numbers rather than re-pricing the quantities ourselves.
 */
function groupPositions(positions) {
  const byCurrency = new Map();

  for (const position of positions) {
    const currency = position?.asset;
    if (!currency) continue;

    const quantity = toNumber(position.total_balance_crypto);
    const value = toNumber(position.total_balance_fiat);
    if (quantity === 0 && value === 0) continue;

    const isStaked = position.account_type === STAKED;
    const available = toNumber(position.available_to_trade_crypto);

    const row = byCurrency.get(currency) ?? {
      currency,
      amount: 0,
      staked: 0,
      hold: 0,
      value: 0,
      positions: 0,
    };
    row.amount += quantity;
    row.value += value;
    row.positions += 1;
    if (isStaked) {
      row.staked += quantity;
    } else {
      // Anything in the wallet that isn't tradable is on hold (open orders, pending).
      row.hold += trimFloatNoise(Math.max(quantity - available, 0));
    }
    byCurrency.set(currency, row);
  }

  return [...byCurrency.values()];
}

/** Fallback shape when the breakdown is unavailable: no fiat, no staking. */
function groupAccounts(accounts) {
  const byCurrency = new Map();

  for (const account of accounts) {
    const currency = account?.currency;
    if (!currency) continue;

    const available = toNumber(account?.available_balance?.value);
    const hold = toNumber(account?.hold?.value);
    if (available === 0 && hold === 0) continue;

    const row = byCurrency.get(currency) ?? {
      currency,
      amount: 0,
      staked: 0,
      hold: 0,
      value: null,
      positions: 0,
    };
    row.amount += available + hold;
    row.hold += hold;
    row.positions += 1;
    byCurrency.set(currency, row);
  }

  return [...byCurrency.values()];
}

/**
 * Price + 24h change per asset. Advanced Trade products are the good source;
 * exchange rates cover anything without a USD spot pair.
 */
async function buildPriceBook(currencies, warnings) {
  const book = new Map([[QUOTE, { price: 1, change24h: 0, source: 'quote' }]]);
  const needed = currencies.filter((c) => c !== QUOTE);
  if (needed.length === 0) return book;

  try {
    const products = await fetchProducts(needed.map((c) => `${c}-${QUOTE}`));
    for (const product of products) {
      const base = product?.base_currency_id;
      const price = toNumber(product?.price);
      if (!base || price === 0) continue;
      book.set(base, {
        price,
        change24h: toNumber(product?.price_percentage_change_24h),
        source: 'advanced_trade',
      });
    }
  } catch (error) {
    warnings.push(`Falling back to exchange rates for pricing: ${error.message}`);
  }

  const missing = needed.filter((c) => !book.has(c));
  if (missing.length > 0) {
    try {
      const rates = await fetchExchangeRates(QUOTE);
      for (const currency of missing) {
        const rate = toNumber(rates[currency]);
        if (rate === 0) continue;
        book.set(currency, { price: 1 / rate, change24h: null, source: 'exchange_rates' });
      }
    } catch (error) {
      warnings.push(`Could not load exchange rates: ${error.message}`);
    }
  }

  return book;
}

export async function getPortfolio() {
  const warnings = [];

  let rows;
  let positionCount;
  let includesStaked = true;

  try {
    const positions = await fetchPositions(warnings);
    if (positions.length === 0) throw new Error('no spot positions returned');
    rows = groupPositions(positions);
    positionCount = positions.length;
  } catch (error) {
    includesStaked = false;
    warnings.push(
      `Portfolio breakdown unavailable (${error.message}). Falling back to wallet balances, which exclude staked funds.`,
    );
    const accounts = await fetchAllAccounts();
    rows = groupAccounts(accounts);
    positionCount = accounts.length;
  }

  const priceBook = await buildPriceBook(rows.map((r) => r.currency), warnings);

  const holdings = rows.map((row) => {
    const quote = priceBook.get(row.currency);
    const change24h = quote?.change24h ?? null;
    // Coinbase's own fiat valuation wins; derive one only on the fallback path.
    const value = row.value ?? row.amount * (quote?.price ?? 0);
    // With a fiat value in hand, an implied price beats a stale ticker price.
    const price = row.amount > 0 && row.value !== null ? row.value / row.amount : (quote?.price ?? 0);

    return {
      currency: row.currency,
      amount: row.amount,
      staked: row.staked,
      hold: row.hold,
      positions: row.positions,
      price,
      value,
      change24hPercent: change24h,
      value24hAgo: change24h === null ? value : value / (1 + change24h / 100),
      priceSource: quote?.source ?? 'none',
      isDust: value < DUST_THRESHOLD,
    };
  });

  holdings.sort((a, b) => b.value - a.value || a.currency.localeCompare(b.currency));

  const unpriced = holdings.filter((h) => h.priceSource === 'none' && h.value === 0);
  if (unpriced.length > 0) {
    warnings.push(`No ${QUOTE} price found for: ${unpriced.map((h) => h.currency).join(', ')}.`);
  }

  const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const totalValue24hAgo = holdings.reduce((sum, h) => sum + h.value24hAgo, 0);
  const stakedValue = holdings.reduce((sum, h) => sum + (h.amount > 0 ? (h.staked / h.amount) * h.value : 0), 0);

  for (const holding of holdings) {
    holding.allocation = totalValue > 0 ? holding.value / totalValue : 0;
  }

  return {
    generatedAt: new Date().toISOString(),
    quoteCurrency: QUOTE,
    totalValue,
    stakedValue,
    includesStaked,
    change24h: {
      absolute: totalValue - totalValue24hAgo,
      percent: totalValue24hAgo > 0 ? ((totalValue - totalValue24hAgo) / totalValue24hAgo) * 100 : 0,
    },
    positionCount,
    holdings,
    warnings,
  };
}
