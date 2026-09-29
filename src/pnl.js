const EPS = 1e-12;

/**
 * Moves between the user's own wallets are not acquisitions or disposals, so
 * they realize nothing. They do relocate cost basis though: staking sends the
 * dearest lots, which is what reproduces Coinbase's own per-position basis
 * (0-1% across SOL, AVAX and ETH, where moving the cheapest is 13-70% out).
 */
const INTERNAL_TYPES = new Set([
  'staking_transfer',
  'unstaking_transfer',
  'vault_transfer',
  'transfer',
  'pro_deposit',
  'pro_withdrawal',
  'exchange_deposit',
  'exchange_withdrawal',
]);

/** Disposals that are not sales: the coins leave, but no gain is realized. */
const NON_SALE_DISPOSALS = new Set(['send']);

/** Acquisitions with no purchase behind them; basis is their value at receipt. */
const INCOME_TYPES = new Set([
  'staking_reward',
  'inflation_reward',
  'interest',
  'reward',
  'earn_payout',
]);

/**
 * v2 ledger entries into a clean, chronological list. `amount` is signed in
 * crypto units, `native_amount` is the USD value of that movement.
 */
export function normaliseLedger(transactions) {
  return transactions
    .filter((tx) => tx.status === 'completed')
    .map((tx) => {
      const qty = Number(tx.amount?.amount) || 0;
      const usd = Math.abs(Number(tx.native_amount?.amount) || 0);
      return {
        time: tx.created_at,
        type: tx.type,
        qty,
        usd,
        // Which wallet it happened in, so staked coins stay unsellable.
        staked: Boolean(tx.stakedWallet),
        internal: INTERNAL_TYPES.has(tx.type),
      };
    })
    .filter((entry) => Math.abs(entry.qty) > EPS)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

/**
 * Highest-in-first-out over the ledger. Acquisitions open a lot priced at the
 * USD value of the movement; disposals consume the dearest lots first.
 *
 * HIFO is not a guess: rebuilt against Coinbase's own reported cost basis it
 * lands within 0.2% on assets that have never been staked, where FIFO is out
 * by 17% and LIFO by 224%.
 */
export function walkLedgerHifo(entries) {
  // Two pools: what you can sell, and what is locked in staking.
  const pools = { spot: [], staked: [] };
  let realized = 0;
  let sendCount = 0;
  let sentQty = 0;
  let incomeQty = 0;
  let incomeValue = 0;

  const dearestIndex = (lots) => {
    let idx = 0;
    for (let i = 1; i < lots.length; i += 1) {
      if (lots[i].price > lots[idx].price) idx = i;
    }
    return idx;
  };

  for (const entry of entries) {
    const here = entry.staked ? pools.staked : pools.spot;

    // A transfer between your own wallets: carry the lots across untouched.
    // Only the receiving leg acts, or the pair would double-count.
    if (entry.internal) {
      if (entry.qty <= 0) continue;
      const from = entry.staked ? pools.spot : pools.staked;
      let left = entry.qty;
      while (left > EPS && from.length > 0) {
        const idx = dearestIndex(from);
        const lot = from[idx];
        const take = Math.min(left, lot.qty);
        here.push({ qty: take, price: lot.price, acquiredAt: lot.acquiredAt });
        lot.qty -= take;
        left -= take;
        if (lot.qty <= EPS) from.splice(idx, 1);
      }
      continue;
    }

    if (entry.qty > 0) {
      here.push({ qty: entry.qty, price: entry.usd / entry.qty, acquiredAt: entry.time });
      if (INCOME_TYPES.has(entry.type)) {
        incomeQty += entry.qty;
        incomeValue += entry.usd;
      }
      continue;
    }

    const disposed = -entry.qty;
    const proceedsPerUnit = entry.usd / disposed;
    const isSale = !NON_SALE_DISPOSALS.has(entry.type);
    if (!isSale) {
      sendCount += 1;
      sentQty += disposed;
    }

    // A disposal can only draw from the wallet it happened in.
    let left = disposed;
    while (left > EPS && here.length > 0) {
      const idx = dearestIndex(here);
      const lot = here[idx];
      const take = Math.min(left, lot.qty);
      if (isSale) realized += take * (proceedsPerUnit - lot.price);
      lot.qty -= take;
      left -= take;
      if (lot.qty <= EPS) here.splice(idx, 1);
    }
  }

  const summarise = (lots) => ({
    qty: lots.reduce((sum, l) => sum + l.qty, 0),
    basis: lots.reduce((sum, l) => sum + l.qty * l.price, 0),
  });
  const spot = summarise(pools.spot);
  const staked = summarise(pools.staked);
  const remainingQty = spot.qty + staked.qty;
  const remainingBasis = spot.basis + staked.basis;
  const byPrice = (a, b) => b.price - a.price;

  return {
    realized,
    remainingQty,
    remainingBasis,
    // Sellable lots only - the ladder cannot reach anything staked.
    lots: pools.spot.slice().sort(byPrice),
    stakedLots: pools.staked.slice().sort(byPrice),
    spotQty: spot.qty,
    spotBasis: spot.basis,
    stakedQty: staked.qty,
    stakedBasis: staked.basis,
    avgEntry: remainingQty > EPS ? remainingBasis / remainingQty : 0,
    sendCount,
    sentQty,
    incomeQty,
    incomeValue,
  };
}

/**
 * Blended taker/maker rate from a sample of recent fills, so the ladder can
 * default to what this account actually pays instead of a guessed tier.
 */
export function effectiveFeeRate(fills) {
  let fees = 0;
  let notional = 0;

  for (const fill of fills) {
    if (fill.side !== 'SELL') continue;
    const price = Number(fill.price) || 0;
    const raw = Number(fill.size) || 0;
    if (price <= 0 || raw <= 0) continue;
    // `size` is in quote units when size_in_quote is set - mixing the two
    // silently corrupts every figure downstream.
    notional += fill.size_in_quote ? raw : raw * price;
    fees += Number(fill.commission) || 0;
  }

  return notional > 0 ? fees / notional : 0;
}

/** One resting order, flattened out of whichever configuration shape it uses. */
export function extractOrder(order) {
  const config = order.order_configuration ?? {};
  const leg = config.limit_limit_gtc ?? config.limit_limit_gtd ?? config.limit_limit_fok ?? null;
  const stop = config.stop_limit_stop_limit_gtc ?? config.stop_limit_stop_limit_gtd ?? null;
  const spec = leg ?? stop;
  if (!spec) return null;

  const size = Number(spec.base_size) || 0;
  const limitPrice = Number(spec.limit_price) || 0;
  if (size <= 0 || limitPrice <= 0) return null;

  return {
    orderId: order.order_id,
    productId: order.product_id,
    side: order.side,
    size,
    limitPrice,
    createdTime: order.created_time,
    kind: stop ? 'stop-limit' : 'limit',
    source: 'coinbase',
  };
}

/** The open sell orders we can plan around, cheapest limit first - fill order. */
export function extractSellOrders(orders) {
  return orders
    .filter((order) => order.side === 'SELL')
    .map(extractOrder)
    .filter(Boolean)
    .sort((a, b) => a.limitPrice - b.limitPrice);
}

/**
 * Lifetime P/L at each rung, in ladder order.
 *
 * A rung only fills because the price got there, so at that moment spot *is*
 * the rung's limit price - and the coins still held are worth that too. Each
 * row therefore has two parts:
 *
 *   realized  : sum over filled orders of (limit_i - spot) * size_i, less fees
 *   unrealized: the remainder marked at this rung's price, (limit_k - spot) * rest
 *
 *   lifetime(k) = lifetimeNow
 *               + Σ_{i<=k} (limit_i - spot) * size_i - fees
 *               + (limit_k - spot) * remaining_k
 *
 * Which reduces to `realized + Σ proceeds + limit_k * remaining - cost basis`,
 * so lot matching still cancels out and the browser can recompute instantly.
 *
 * Marking the remainder at today's spot instead - an earlier mistake - badly
 * understates the upper rungs, because it priced a large unsold position as if
 * the rally that triggered the fills had never happened.
 */
export function buildLadder({ orders, lifetimeNow, currentPrice, heldQty, feeRate = 0 }) {
  let soldQty = 0;
  let proceeds = 0;
  let realizedDelta = 0;

  return orders.map((order, index) => {
    const gross = order.size * order.limitPrice;
    const fee = gross * feeRate;

    soldQty += order.size;
    proceeds += gross - fee;
    realizedDelta += (order.limitPrice - currentPrice) * order.size - fee;

    const remainingQty = heldQty - soldQty;
    // Clamped: an oversold ladder has no remainder left to revalue.
    const markToRung = (order.limitPrice - currentPrice) * Math.max(remainingQty, 0);

    return {
      ...order,
      step: index + 1,
      gross,
      fee,
      net: gross - fee,
      vsSpotPercent: currentPrice > 0 ? ((order.limitPrice - currentPrice) / currentPrice) * 100 : 0,
      cumulativeSold: soldQty,
      cumulativeProceeds: proceeds,
      remainingQty,
      oversold: soldQty > heldQty + EPS,
      lifetimePL: lifetimeNow + realizedDelta + markToRung,
    };
  });
}

/**
 * A closing row for whatever the ladder leaves behind: dump the remainder at
 * the last rung's limit price. Answers "and if the rest went at that price
 * too?", which the ladder alone never reaches because the orders stop short of
 * the full position.
 *
 * Returns null when the ladder is empty or already covers everything.
 */
export function projectFullExit({ ladder, currentPrice, heldQty, feeRate = 0 }) {
  const last = ladder.at(-1);
  if (!last) return null;

  const remainingQty = heldQty - last.cumulativeSold;
  if (remainingQty <= EPS) return null;

  const limitPrice = last.limitPrice;
  const gross = remainingQty * limitPrice;
  const fee = gross * feeRate;

  return {
    size: remainingQty,
    limitPrice,
    gross,
    fee,
    net: gross - fee,
    vsSpotPercent: currentPrice > 0 ? ((limitPrice - currentPrice) / currentPrice) * 100 : 0,
    // The last rung already values the remainder at this price, so actually
    // selling it only costs the fee - it moves P/L from unrealized to banked.
    lifetimePL: last.lifetimePL - fee,
  };
}

/* ---------------------------------------------------------------------------
 * Holding period
 * ------------------------------------------------------------------------- */

/** US rule: the gain is long-term only if held MORE than one year. */
export function longTermFrom(acquiredAt) {
  const date = new Date(acquiredAt);
  date.setFullYear(date.getFullYear() + 1);
  date.setDate(date.getDate() + 1);
  return date;
}

export function daysUntil(date, asOf) {
  return Math.max(0, Math.ceil((date.getTime() - asOf.getTime()) / 86400000));
}

/**
 * Walks the ladder consuming lots HIFO and splits what each order books into
 * short- and long-term.
 *
 * Orders are processed in ladder order, so order N sees only the lots its
 * predecessors left behind. A single order routinely consumes lots of mixed
 * ages, because HIFO picks by price and not by date.
 *
 * `signal` is the suggested read:
 *   wait             - a short-term gain whose lots turn long-term soon
 *   lt-gain          - already long-term
 *   st-gain          - short-term gain with the crossover still far off
 *   st-loss          - a loss booked short-term, which is the useful kind
 *   st-loss-expiring - the same, but a lot crosses soon: book it before then
 *   lt-loss          - a loss booked long-term
 */
export function classifyLadderTax({ lots, orders, asOf = new Date(), feeRate = 0, nearDays = 45 }) {
  const pool = lots.map((lot) => ({ ...lot }));

  return orders.map((order) => {
    const netPerUnit = order.limitPrice * (1 - feeRate);
    let left = order.size;
    let shortGain = 0;
    let longGain = 0;
    let shortQty = 0;
    let longQty = 0;
    // Last short-term lot to cross: when the whole order turns long-term.
    let crossover = null;
    // First to cross: when a short-term LOSS starts losing that treatment.
    let firstCrossover = null;
    let ageWeighted = 0;
    let oldestAge = null;
    let newestAge = null;

    while (left > EPS && pool.length > 0) {
      let idx = 0;
      for (let i = 1; i < pool.length; i += 1) {
        if (pool[i].price > pool[idx].price) idx = i;
      }
      const lot = pool[idx];
      const take = Math.min(left, lot.qty);
      const gain = take * (netPerUnit - lot.price);
      const turns = longTermFrom(lot.acquiredAt);

      const age = (asOf.getTime() - new Date(lot.acquiredAt).getTime()) / 86400000;
      ageWeighted += take * age;
      if (oldestAge === null || age > oldestAge) oldestAge = age;
      if (newestAge === null || age < newestAge) newestAge = age;

      if (asOf >= turns) {
        longGain += gain;
        longQty += take;
      } else {
        shortGain += gain;
        shortQty += take;
        // The order is fully long-term only once its newest lot crosses.
        if (!crossover || turns > crossover) crossover = turns;
        if (!firstCrossover || turns < firstCrossover) firstCrossover = turns;
      }

      lot.qty -= take;
      left -= take;
      if (lot.qty <= EPS) pool.splice(idx, 1);
    }

    const gain = shortGain + longGain;
    const matchedQty = shortQty + longQty;
    // Quantity-weighted, so a big old lot counts for more than a dust one.
    const avgAgeDays = matchedQty > EPS ? ageWeighted / matchedQty : null;
    const daysToLongTerm = crossover ? daysUntil(crossover, asOf) : 0;
    const daysToFirstLongTerm = firstCrossover ? daysUntil(firstCrossover, asOf) : 0;
    // Lots ran out: the ladder is selling more than the history accounts for.
    const uncoveredQty = left > EPS ? left : 0;

    let signal = 'none';
    if (uncoveredQty > EPS && shortQty + longQty <= EPS) signal = 'unknown';
    else if (gain > 0) {
      if (shortQty <= EPS) signal = 'lt-gain';
      else if (daysToLongTerm <= nearDays) signal = 'wait';
      else signal = 'st-gain';
    } else if (gain < 0) {
      if (shortQty <= EPS) signal = 'lt-loss';
      // A short-term loss is the useful kind, so a near crossover is a
      // deadline rather than something to wait for.
      else if (daysToFirstLongTerm <= nearDays) signal = 'st-loss-expiring';
      else signal = 'st-loss';
    }

    return {
      orderId: order.orderId,
      gain,
      shortGain,
      longGain,
      shortQty,
      longQty,
      uncoveredQty,
      avgAgeDays,
      oldestAgeDays: oldestAge,
      newestAgeDays: newestAge,
      daysToLongTerm,
      daysToFirstLongTerm,
      // Absolute dates, so a stored signal still counts down correctly days
      // later instead of freezing at the number it was computed with.
      longTermOn: crossover ? crossover.toISOString() : null,
      firstLongTermOn: firstCrossover ? firstCrossover.toISOString() : null,
      signal,
    };
  });
}
