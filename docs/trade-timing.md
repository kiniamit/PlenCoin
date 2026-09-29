# Feature: Holding-period signals

Draft v1, built · ladder columns on `/asset.html`, cross-asset list on
`/signals.html`. Requirements still open.

## Brief

> I want to optimize when I buy or sell to optimize short and long term gain.

> I want it by short and long term sells. I want to see if one of my upcoming
> sell order is going to be profit or loss booking. If booking profit and if it
> is close to being a long term gain I can hold selling for a few days. If an
> upcoming order is going to book loss then I would rather sell it as short
> term loss.

The rule encoded:

| Books | Holding period | Read |
| --- | --- | --- |
| Profit | long-term | fine, nothing to do |
| Profit | short-term, crossover soon | **hold** — waiting turns it long-term |
| Profit | short-term, crossover far | short-term gain, taxed higher |
| Loss | short-term | good — the useful kind |
| Loss | short-term, crossover soon | **deadline** — book it before it turns |
| Loss | long-term | you would rather have booked this short-term |

## How it works

`classifyLadderTax()` in `src/pnl.js`, mirrored in `public/asset.js` so what-if
rows classify too. The ladder is walked in fill order consuming lots HIFO, so
rung N sees only what its predecessors left. Per rung the gain splits into
short and long term with matching quantities.

**Long-term** is the US rule: held *more* than a year, so the crossover is
acquisition + 1 year + 1 day.

Two crossover dates are tracked, because gains and losses want opposite ends:

- **last** short-term lot to cross → a *gain* is only fully long-term then →
  drives `hold Nd`
- **first** to cross → a *loss* starts losing short-term treatment then →
  drives `sell by Nd`

A rung routinely books both, since HIFO picks by cost, not date. Where it
straddles, the split shows under the total.

## Cost-basis method decides the holding period

HIFO picks strictly by cost; age plays no part in the choice. But when a price
has risen over years, the cheap coins are also the old ones — so they sit at
the bottom of the stack and a ladder never reaches them. What sells is recent,
expensive, short-term inventory.

SOL: 26% of the position is long-term, yet every sell order books short-term.

| | long-term | short-term |
| --- | --- | --- |
| 20 dearest lots (sold first) | 0 | 20 |
| 20 cheapest (sold last) | 11 | 9 |

This is *cheap versus dear*, not old versus new — cost and recency correlate
only weakly (Spearman 0.35). Change the method in Coinbase's settings and every
number here changes.

## Materiality is the whole game

A deadline alone misleads, because HIFO forces everything ahead of an order to
sell first. Both rows below carry the same kind of badge:

| Signal | At stake | To reach it |
| --- | --- | --- |
| LPT, sell by 33d | −$220.35 | **nothing ahead of it** |
| DOGE, hold 13d | +$67.22 | sell 9,700 first, booking −$530.29 |

LPT is free to act on. DOGE asks you to realize $530 of losses to protect $67.
The **to reach it** column carries that arithmetic on every row.

## Notifications

`/signals.html` — every dated order across every coin, soonest first, reached
from the **Signals** link in any header. The link badges red when something is
within 7 days. Tiers: urgent ≤7, soon 8–30, watch 31+, shown as a stripe down
the left edge.

**Scheduling.** A sweep costs ~150 paginated calls, too much for a page load.
It runs on server start and hourly after (`SCAN_INTERVAL_MS`), writing
`data/signals.json` so a restart shows the last digest immediately while a
fresh scan runs behind it. One scan at a time; concurrent callers share the
promise. 16 assets takes ~15s. **Rescan** forces one.

**Why hourly is generous.** A resting limit order's tax character does not move
with the market — gain or loss is `(limit × (1−fee) − lot cost) × qty`, lot
choice is HIFO by cost, and term is acquisition date against today. A signal
only changes when a day passes, an order changes, or you trade.

So the digest stores **absolute dates, never "days left"** — the countdown is
derived at render time, and a digest written days ago still reads correctly.

`data/` is gitignored; the digest holds order sizes and P/L.

## UI notes

Ladder columns: **Age** (quantity-weighted, hover for the spread), **Books**
(with `ST … · LT …` when it straddles), **Term** (`hold 20d`, `sell by 4d`,
`LT gain`, `ST gain`, `ST loss`, `LT loss`). A **Long-term** stat shows how
much of the position is already past a year.

Column tooltips work on hover and on tap (`public/tooltip.js`) — a `title` alone
is invisible on a phone. Near-crossover threshold is 45 days.

## Verified

- Quantity classified equals quantity ordered, exactly.
- `shortGain + longGain === gain` on every row of every asset.
- Average age always between the newest and oldest lot consumed; purely
  long-term rows average >365 days, purely short-term rows under.

## Not done yet

- **Buys are untouched** — the original brief said "buy or sell".
- **No tax rates.** It reports holding period, not tax owed. It knows nothing
  of your bracket, other gains, or wash sales. Not tax advice, and not a
  substitute for Coinbase's own gain/loss documents.
- **Nothing runs while the server is down** — a deadline can pass unseen.
- **No dismissal** — every signal shows on every visit.
- **45 days is a guess** at "close to long term".
- **Upcoming orders is not annotated**; the signals page covers that instead.

## Open questions

- Should the near-crossover threshold be configurable, and what default?
- For a loss, should the planner suggest a "sell by" date actively?
- Should buys be scored at all, and on what?
- Does Coinbase accept `cost_basis_method` per order? Orders carry the field as
  `COST_BASIS_METHOD_UNSPECIFIED`. If specific-ID is possible, the collateral
  cost in "to reach it" largely disappears.
