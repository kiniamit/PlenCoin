# Feature: Sell planner

Built · `/asset.html?symbol=TRB`, reached by clicking any non-cash holding.

## Brief

> I want to plan my strategy to sell an asset. I want to see how much lifetime
> profit or loss would I be sitting on after each sell order… I want to see a
> number right next to my each sell order as to how much would the lifetime
> profit (or loss) would be at that point. We can open orders page when I click
> on an asset from holdings table.

## What it shows

A ladder of your open sell orders, cheapest limit first — the order they fill
in as price rises. Per rung: size, limit, distance from spot, net proceeds,
remaining position, what it books, holding period, and **lifetime P/L at this
price**. What-if rows can be added to test a plan; nothing is ever sent to
Coinbase.

Lifetime P/L = realized on past sells + unrealized on what is still held.

## Cost basis

Coinbase's `realized_pl` on fills is always `0` for spot, so basis is rebuilt
locally from the **v2 transaction ledger** (`/v2/accounts/{id}/transactions`),
which records every movement with its USD value at the time.

The fills endpoint cannot do this. For SOL it misses a 13.24 sale on `SOL-USDC`
(wrong pair), 2.15 from Converts and 1.11 of staking rewards — none of which
are fills. The ledger reconciles to **0.000% drift on every holding**.

**Lot matching is HIFO**, inferred by matching Coinbase's reported basis:

| Method | TRB remaining basis | Error vs Coinbase's $4,284.79 |
| --- | --- | --- |
| **HIFO** | **$4,276.91** | **0.2%** |
| FIFO | $5,001.40 | 17% |
| LIFO | $13,890.06 | 224% |

Three ledger cases need care:

- **Internal transfers** are not disposals; they move lots between pools.
- **Income** (staking rewards, interest) opens a lot at its value on receipt.
- **Sends** remove lots at cost without realizing a gain.

## Staked coins

A staked coin cannot be sold, so lots are tagged by wallet and held in two
pools. The ladder only draws on the sellable one. Staking moves the **dearest**
lots — again inferred from Coinbase's per-position basis:

| Rule | SOL staked | AVAX staked | ETH staked |
| --- | --- | --- | --- |
| Coinbase reports | $4,379 | $2,508 | $1,109 |
| **move dearest** | **$4,379** | **$2,532** | **$1,110** |
| move cheapest | $1,303 | $1,801 | $1,254 |
| move oldest | $1,400 | $1,925 | $1,266 |

With that, the rebuild matches Coinbase on both pools within 0.3% (AVAX staked,
1%). Coinbase does *not* re-mark basis on staking — HIFO simply sends the dear
lots there.

## The ladder projection

A rung only fills because the price got there, so the coins still held are
worth that price too:

```
lifetime(k) = lifetimeNow
            + Σ_{i≤k} (limit_i − spot) × size_i − fees   ← banked by then
            + (limit_k − spot) × remaining_k             ← the rest, revalued
```

Lot matching cancels out of the total, so the browser recomputes the whole
ladder instantly when a what-if row is added. `buildLadder()` in `src/pnl.js`
is the reference; `public/asset.js` mirrors it.

The closing **"sell the rest"** row liquidates the remainder at the last rung's
price. Because that rung already values it there, the row only differs by the
fee — it moves P/L from unrealized to banked.

Fees default to the account's blended sell rate from one page of recent fills.

## Guards

- **Reconciliation** — if the rebuilt quantity drifts >0.5% from what is held,
  basis is estimated as `average entry × held` and flagged approximate.
- **Oversell** — orders totalling more than the position, or more than the
  unstaked balance, raise a warning rather than inventing basis.
- **No history** — lifetime P/L reports 0 and says so; the ladder still works.

## Traps worth remembering

- Fill `size` is in base **or quote** units, flagged by `size_in_quote`.
  Ignoring it produced a net position of 2,073 TRB against an actual 284.91.
- Quantities from the breakdown are JSON floats (~8 significant digits), so
  derived figures are rounded to 6 significant figures to strip subtraction
  noise like `531.50002`.

## Limits

- Each row is a **price level, not a forecast** — it says nothing about whether
  the price gets there.
- Fill order is assumed to be by price; a partial fill breaks that.
- Open orders are read from the `-USD` pair only. Cost basis is not affected.
- Partial fills are not netted out; size is the order's original `base_size`.
