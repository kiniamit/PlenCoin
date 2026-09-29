/** Sample payload for `npm run mock` - same shape as getPortfolio(), no credentials needed. */
const SAMPLE = [
  { currency: 'BTC', amount: 0.41235, price: 64210.55, change24h: 1.84 },
  { currency: 'ETH', amount: 5.2, price: 3120.4, change24h: -0.92, staked: 2.0 },
  { currency: 'SOL', amount: 62.5, price: 148.2, change24h: 4.31, staked: 24.5 },
  { currency: 'USDC', amount: 4210.12, price: 1, change24h: 0 },
  { currency: 'LINK', amount: 310, price: 16.05, change24h: 2.17 },
  { currency: 'MATIC', amount: 1250, price: 0.71, change24h: -3.4 },
  { currency: 'USD', amount: 812.44, price: 1, change24h: 0 },
];

export function getMockPortfolio() {
  const holdings = SAMPLE.map((row) => {
    const value = row.amount * row.price;
    return {
      currency: row.currency,
      amount: row.amount,
      staked: row.staked ?? 0,
      hold: 0,
      positions: row.staked ? 2 : 1,
      price: row.price,
      value,
      change24hPercent: row.change24h,
      value24hAgo: value / (1 + row.change24h / 100),
      priceSource: 'mock',
      isDust: false,
    };
  }).sort((a, b) => b.value - a.value);

  const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const totalValue24hAgo = holdings.reduce((sum, h) => sum + h.value24hAgo, 0);
  for (const holding of holdings) holding.allocation = holding.value / totalValue;

  return {
    generatedAt: new Date().toISOString(),
    quoteCurrency: 'USD',
    totalValue,
    change24h: {
      absolute: totalValue - totalValue24hAgo,
      percent: ((totalValue - totalValue24hAgo) / totalValue24hAgo) * 100,
    },
    stakedValue: holdings.reduce((sum, h) => sum + (h.staked / h.amount) * h.value, 0),
    includesStaked: true,
    positionCount: holdings.length + 2,
    holdings,
    warnings: [],
    mock: true,
  };
}

/** Sample asset detail for MOCK=1, mirroring getAssetDetail(). */
export function getMockAsset(symbol) {
  const currency = String(symbol || 'SOL').toUpperCase();
  const heldQty = 62.5;
  const currentPrice = 148.2;
  const value = heldQty * currentPrice;
  const costBasis = 5480.25;
  const realizedPL = -1240.5;
  const unrealizedPL = value - costBasis;

  const sellOrders = [
    { orderId: 'mock-1', size: 5, limitPrice: 165, kind: 'limit', source: 'coinbase', createdTime: '2026-08-01T10:00:00Z' },
    { orderId: 'mock-2', size: 7.5, limitPrice: 180, kind: 'limit', source: 'coinbase', createdTime: '2026-08-03T10:00:00Z' },
    { orderId: 'mock-3', size: 10, limitPrice: 210, kind: 'limit', source: 'coinbase', createdTime: '2026-08-05T10:00:00Z' },
    { orderId: 'mock-4', size: 12, limitPrice: 265, kind: 'limit', source: 'coinbase', createdTime: '2026-08-09T10:00:00Z' },
  ];

  return {
    generatedAt: new Date().toISOString(),
    currency,
    productId: `${currency}-USD`,
    quoteCurrency: 'USD',
    heldQty,
    currentPrice,
    value,
    staked: 24.5,
    hold: 0,
    costBasis,
    avgEntry: costBasis / heldQty,
    realizedPL,
    unrealizedPL,
    lifetimePL: realizedPL + unrealizedPL,
    reconciled: true,
    feeRate: 0.006,
    ledgerEntries: 128,
    walletCount: 2,
    rewardQty: 1.1,
    rewardValue: 142.3,
    firstTrade: '2024-02-11T08:14:00Z',
    lastTrade: '2026-09-18T16:41:00Z',
    lots: [
      { qty: 20, price: 96.4, acquiredAt: '2024-03-02T00:00:00Z', longTermOn: '2025-03-03T00:00:00Z' },
      { qty: 25, price: 88.1, acquiredAt: '2026-08-15T00:00:00Z', longTermOn: '2027-08-16T00:00:00Z' },
      { qty: 17.5, price: 74.2, acquiredAt: '2026-09-01T00:00:00Z', longTermOn: '2027-09-02T00:00:00Z' },
    ],
    lotCount: 3,
    longTermQty: 20,
    longTermShare: 20 / 62.5,

    sellOrders,
    buyOrderCount: 2,
    warnings: [],
    mock: true,
  };
}

/** Sample upcoming-orders payload for MOCK=1. */
export function getMockOrders() {
  const spot = { SOL: 148.2, ETH: 3120.4, BTC: 64210.55, LINK: 16.05 };
  const make = (currency, side, size, limitPrice) => {
    const currentPrice = spot[currency];
    return {
      orderId: `mock-${currency}-${side}-${limitPrice}`,
      productId: `${currency}-USD`,
      currency,
      quoteCurrency: 'USD',
      side,
      size,
      limitPrice,
      kind: 'limit',
      source: 'coinbase',
      createdTime: '2026-08-01T10:00:00Z',
      currentPrice,
      change24hPercent: 1.2,
      requiredMovePercent: ((limitPrice - currentPrice) / currentPrice) * 100,
      notional: size * limitPrice,
    };
  };

  const byDistance = (a, b) => Math.abs(a.requiredMovePercent) - Math.abs(b.requiredMovePercent);
  const buys = [
    make('SOL', 'BUY', 5, 140),
    make('ETH', 'BUY', 0.5, 2900),
    make('BTC', 'BUY', 0.01, 58000),
  ].sort(byDistance);
  const sells = [
    make('SOL', 'SELL', 4, 165),
    make('LINK', 'SELL', 50, 17.5),
    make('ETH', 'SELL', 1, 3600),
    make('BTC', 'SELL', 0.05, 82000),
  ].sort(byDistance);
  const sum = (list) => list.reduce((t, r) => t + r.notional, 0);

  return {
    generatedAt: new Date().toISOString(),
    quoteCurrency: 'USD',
    buys,
    sells,
    totals: {
      buyCount: buys.length,
      sellCount: sells.length,
      buyNotional: sum(buys),
      sellNotional: sum(sells),
      assetCount: 4,
    },
    warnings: [],
    mock: true,
  };
}

/** Sample signals digest for MOCK=1. */
export function getMockSignals() {
  const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString();

  return {
    generatedAt: new Date().toISOString(),
    durationMs: 1200,
    nearDays: 45,
    assetsScanned: ['BTC', 'ETH', 'LINK', 'SOL'],
    orderIds: ['mock-1', 'mock-2'],
    signals: [
      {
        key: 'SOL:mock-1:st-loss-expiring',
        currency: 'SOL',
        orderId: 'mock-1',
        signal: 'st-loss-expiring',
        step: 2,
        size: 5,
        limitPrice: 132,
        notional: 660,
        deadline: inDays(4),
        gain: -184.2,
        atStake: -122.4,
        shortQty: 3.1,
        longQty: 1.9,
        avgAgeDays: 351,
        aheadQty: 4,
        aheadGain: -60.5,
        aheadLongGain: -48.1,
      },
      {
        key: 'ETH:mock-2:wait',
        currency: 'ETH',
        orderId: 'mock-2',
        signal: 'wait',
        step: 1,
        size: 1,
        limitPrice: 3600,
        notional: 3600,
        deadline: inDays(19),
        gain: 742.5,
        atStake: 742.5,
        shortQty: 1,
        longQty: 0,
        avgAgeDays: 347,
        aheadQty: 0,
        aheadGain: 0,
        aheadLongGain: 0,
      },
    ],
    warnings: [],
    mock: true,
  };
}
