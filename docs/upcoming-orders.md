# Feature: Upcoming orders

Status: built · First shipped 2026-09-22 · Owner: akini

## Brief

As given by the requester, verbatim:

> feature 3: Upcoming order page. This shoud show upcoming sell and buy order
> sorted by how far in % terms are they from current price. We can show buys on
> left and sells on the right. It will have order from all coins

## What it does

`/orders.html` — every resting order across every coin, in two columns: buys on
the left, sells on the right.

Each order is annotated with the **move** required for the market to reach it:

```
requiredMovePercent = (limit price − current price) / current price × 100
```

Both columns are sorted by the absolute size of that move, nearest first, so
whatever is closest to filling sits at the top of each side. The arrow shows
direction rather than good or bad — ▼ for a buy waiting on a fall, ▲ for a sell
waiting on a rise. Orders with no available price sort last and show `—`.

Each table is numbered, and a **Running** column carries the cumulative value
down the list. Because the list is ordered nearest-first, that figure reads as
"how much fills in total if the price travels this far" — the last row equals
the side's total.

The summary bar carries total open orders, the buy and sell counts with their
notional value, and the single nearest order across both sides. Each ticker
links through to that asset's [sell planner](sell-planner.md).

Current state of the book: 271 open orders over 13 assets — 33 buys worth
$9,255 and 238 sells worth $63,278. The nearest is a UNI buy 1.1% below spot.

## Coin filter

A row of chips above the books, one per coin that currently has orders, each
with its order count and sorted busiest first. **All coins** is selected by
default.

Picking a coin narrows both tables and the summary bar — counts, notionals,
nearest order and the running totals all recompute for that coin alone, and a
side with nothing open says so rather than going blank.

The selection survives auto-refresh. If the chosen coin's last order fills and
it drops out of the data, the filter falls back to All rather than showing an
empty page.

## Auto-refresh

On by default, every 15 seconds, with a toggle in the header and a stepper to
change the interval — type a value or use −/+, which move in 5-second steps.
Input is clamped to 5–600 seconds, and changing it restarts the timer straight
away rather than waiting out the old one.

Both the toggle and the interval are remembered in `localStorage` (guarded —
storage can throw in a private window, and the controls still work without it).

Each tick passes `refresh=1` so it bypasses the 15s server cache; polling
through the cache would mean data up to 30 seconds old on a page whose whole
point is how close orders are to filling. A tick is skipped while a request is
already in flight, so slow responses cannot stack up.

## A Coinbase quirk worth knowing

`GET /api/v3/brokerage/orders/historical/batch?order_status=OPEN` **silently
truncates**. Without a product filter it returns 100 orders and reports
`has_next: false` with an empty cursor, so ordinary cursor pagination stops
after the first page believing it is done. The real count is 271.

The workaround is a large `limit` — at `limit=1000` the endpoint returns all
271 in one call. `fetchAllOpenOrders()` therefore asks for 1000 and warns if
the result comes back at the cap, since that is the only signal that anything
was cut off.

Verified by cross-checking the bulk result against a per-product query for each
of the 13 products; all 13 counts matched.

## Data sources

| Endpoint | Used for |
| --- | --- |
| `GET /api/v3/brokerage/orders/historical/batch?order_status=OPEN&limit=1000` | Every resting order |
| `GET /api/v3/brokerage/market/products` | Current price per product, one call for all of them |

Limit and stop-limit configurations are both read. An order without a limit
price is skipped and counted in a warning.

## API

`GET /api/orders` → `{ buys[], sells[], totals, warnings[] }`, cached 15s
(`CACHE_MS`); `&refresh=1` bypasses it.

Per order: `currency`, `productId`, `side`, `size`, `limitPrice`,
`currentPrice`, `requiredMovePercent`, `notional`, `kind`, `createdTime`.

## Limitations

- **Quote currency is taken from the product**, so a non-USD pair shows its own
  quote. Totals add the notionals together regardless, which is only right
  while every order is USD-quoted — currently true.
- **Partial fills are not netted out**; size is the order's original
  `base_size`.
- **No price means no position in the sort.** Those orders are listed last.

## Possible next steps

- The two columns can be very different lengths (238 sells against 33 buys).
  A max height with internal scroll would keep them level.
- Filter or group by asset.
- Show what each order would do to lifetime P/L, reusing the sell planner's
  projection.
