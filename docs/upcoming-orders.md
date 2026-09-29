# Feature: Upcoming orders

Built · `/orders.html`

## Brief

> Upcoming order page. This shoud show upcoming sell and buy order sorted by
> how far in % terms are they from current price. We can show buys on left and
> sells on the right. It will have order from all coins

## What it shows

Every resting order across every coin, buys left, sells right, each annotated
with the move required to reach it:

```
requiredMovePercent = (limit − spot) / spot × 100
```

Both sides sort by the absolute size of that move, nearest first. The arrow is
direction, not judgement: ▼ a buy waiting on a fall, ▲ a sell waiting on a
rise. Unpriced orders sort last.

Each table is numbered, with a **Running** column of cumulative value — read
as "how much fills in total if the price travels this far". The last row equals
the side's total.

Current book: 271 orders over 13 assets, 33 buys worth $9,255 and 238 sells
worth $63,278.

## Controls

All four tunables sit in one cluster in the header; it wraps on narrow screens.

- **Auto-refresh**, on by default, with a −/+ stepper for the interval
  (5s default 15s, clamped 5–600). Each tick passes `refresh=1` to bypass the
  15s server cache, since polling through it would mean data up to 30s old.
  A tick is skipped while a request is in flight.
- **Highlight thresholds**, default $290 and $450. The **Value cell** is shaded
  grey below the low line and accent above it — only that cell, since banding
  whole rows drowned the table, and colouring the text alone was too faint.

Every setting persists in `localStorage`.

Distribution, for tuning: mean $273, median $286, p75 $339, p90 $428, max $683.
A $290 low line marks about half the book; $450 is roughly the top 8%.

## Coin filter

A chip per coin with orders, busiest first, **All coins** by default. Picking
one narrows both tables and the summary, so the running totals stay true to
what is shown. The selection survives auto-refresh, and falls back to All if
that coin's last order fills.

## A Coinbase quirk

`GET /api/v3/brokerage/orders/historical/batch?order_status=OPEN` **silently
truncates**. Without a product filter it returns 100 orders and reports
`has_next: false` with an empty cursor, so cursor pagination stops believing it
is done. The real count is 271.

The workaround is a large `limit` — at `limit=1000` it returns everything in
one call, and the code warns if a result comes back at the cap. Verified
against per-product queries for all 13 products.

## API

`GET /api/orders` → `{ buys[], sells[], totals, warnings[] }`, cached 15s
(`CACHE_MS`), `&refresh=1` bypasses.

Per order: `currency`, `productId`, `side`, `size`, `limitPrice`,
`currentPrice`, `requiredMovePercent`, `notional`, `kind`, `createdTime`.

Prices come from `GET /api/v3/brokerage/market/products`, one call for all
products. Limit and stop-limit configurations are both read; an order without
a limit price is skipped and counted in a warning.

## Limits

- Quote currency is taken from the product; totals add notionals regardless,
  which is only right while every order is USD-quoted — currently true.
- Partial fills are not netted out; size is the original `base_size`.
- The two columns can be very uneven (238 sells against 33 buys).
