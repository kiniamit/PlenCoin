import { fetchAllOpenOrders, fetchProducts } from './coinbase.js';
import { extractOrder } from './pnl.js';

const QUOTE = 'USD';

/**
 * Every resting order across every coin, annotated with how far the market has
 * to travel to reach it. Buys and sells are returned separately, each sorted
 * by that distance so the ones closest to filling come first.
 */
export async function getUpcomingOrders() {
  const warnings = [];
  const { orders: raw, limit } = await fetchAllOpenOrders();

  if (raw.length >= limit) {
    warnings.push(
      `Coinbase returned ${raw.length} orders, the maximum this request can ask for, so some may be missing.`,
    );
  }

  const parsed = raw.map(extractOrder).filter(Boolean);
  const skipped = raw.length - parsed.length;
  if (skipped > 0) {
    warnings.push(`${skipped} order${skipped === 1 ? '' : 's'} had no limit price and were left out.`);
  }

  const productIds = [...new Set(parsed.map((o) => o.productId))];
  const prices = new Map();
  try {
    for (const product of await fetchProducts(productIds)) {
      const price = Number(product?.price) || 0;
      if (product?.product_id && price > 0) {
        prices.set(product.product_id, {
          price,
          change24h: Number(product.price_percentage_change_24h) || 0,
        });
      }
    }
  } catch (error) {
    warnings.push(`Could not load current prices: ${error.message}`);
  }

  const unpriced = new Set();
  const rows = parsed.map((order) => {
    const quote = prices.get(order.productId);
    const currentPrice = quote?.price ?? null;
    if (!currentPrice) unpriced.add(order.productId);

    return {
      ...order,
      currency: order.productId.split('-')[0],
      quoteCurrency: order.productId.split('-')[1] ?? QUOTE,
      currentPrice,
      change24hPercent: quote?.change24h ?? null,
      // Signed: positive means the price has to rise, negative that it has to fall.
      requiredMovePercent: currentPrice ? ((order.limitPrice - currentPrice) / currentPrice) * 100 : null,
      notional: order.size * order.limitPrice,
    };
  });

  if (unpriced.size > 0) {
    warnings.push(`No current price for ${[...unpriced].join(', ')}; those orders sort last.`);
  }

  // Nearest to filling first; anything unpriced drops to the bottom.
  const byDistance = (a, b) => {
    if (a.requiredMovePercent === null) return 1;
    if (b.requiredMovePercent === null) return -1;
    return Math.abs(a.requiredMovePercent) - Math.abs(b.requiredMovePercent);
  };

  const buys = rows.filter((r) => r.side === 'BUY').sort(byDistance);
  const sells = rows.filter((r) => r.side === 'SELL').sort(byDistance);
  const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);

  return {
    generatedAt: new Date().toISOString(),
    quoteCurrency: QUOTE,
    buys,
    sells,
    totals: {
      buyCount: buys.length,
      sellCount: sells.length,
      buyNotional: sum(buys, 'notional'),
      sellNotional: sum(sells, 'notional'),
      assetCount: new Set(rows.map((r) => r.currency)).size,
    },
    warnings,
  };
}
