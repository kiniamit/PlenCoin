# Feature: Trade timing — holding period

Status: **draft v1, built.** Requirements still in progress.
Raised 2026-09-22 · Owner: akini

## Brief

Original, verbatim:

> feature number 2: I want to optimize when I buy or sell to optimize short and
> long term gain.

Refined, verbatim:

> let's create a draft version of feature 2. I want it by short and long term
> sells. I want to see if one of my upcoming sell order is going to be profit or
> loss booking. If booking profit and if it is close to being a long term gain I
> can hold selling for a few days. If an upcoming order is going to book loss
> then I would rather sell it as short term loss.

The rule being encoded:

| Order books | Holding period | Read |
| --- | --- | --- |
| Profit | long-term | good, nothing to do |
| Profit | short-term, crossover soon | **wait** — a few days turns it long-term |
| Profit | short-term, crossover far | short-term gain, taxed higher |
| Loss | short-term | good — the useful kind of loss |
| Loss | short-term, crossover soon | **deadline** — book it before it turns long-term |
| Loss | long-term | you would rather have booked this short-term |

## Where it lives

On the **sell planner** (`/asset.html?symbol=…`), as two extra ladder columns.

That is a deliberate choice, and partly forced: the analysis needs the
individual tax lots, which come from rebuilding an asset's whole transaction
ledger — around 14 paginated calls for an asset like SOL. Doing that for all 13
assets to annotate the Upcoming orders page would take far too long for a page
that auto-refreshes every 15 seconds. Surfacing a summary there is the obvious
next step, but it needs a different data strategy.

## How it works

`classifyLadderTax()` in `src/pnl.js`, mirrored in `public/asset.js` so what-if
rows get the same treatment.

The ladder is walked **in fill order**, consuming lots HIFO, so order N only
sees what its predecessors left behind. For each order:

- lots are consumed by cost, dearest first, exactly as the cost-basis rebuild
  does — acquisition date does not influence which lot is picked, only how the
  resulting gain is classified;
- each consumed slice is classified by its own acquisition date;
- the gain is split into `shortGain` / `longGain` with matching quantities;
- two crossover dates are tracked, because gains and losses need opposite ends
  of the range:
  - `daysToLongTerm` — from the **newest** short-term lot, since a *gain* only
    becomes fully long-term once the last lot crosses. Drives `hold Nd`.
  - `daysToFirstLongTerm` — from the **oldest** short-term lot, since a *loss*
    starts losing short-term treatment as soon as the first lot crosses.
    Drives `sell by Nd`.

**Long-term** follows the US rule: held *more* than one year, so the crossover
is acquisition date + 1 year + 1 day.

A single order routinely books both, because HIFO picks lots by price and not
by date. Where that happens the split is shown under the total.

The closing "sell the rest" row is part of the same walk rather than classified
separately, so it consumes whatever the ladder leaves.

## The finding that matters most

**Cost-basis method decides the holding period.** HIFO consumes lots strictly
by cost — the most expensive coins you hold go first, whenever you bought them.
Age plays no part in the choice.

But when an asset's price has risen over the years, cost and age end up
correlated in a way that matters: the coins bought long ago are also the cheap
ones, so they sit at the *bottom* of the HIFO stack and a ladder never reaches
them. What gets sold is the recent, expensive, short-term inventory.

SOL shows this starkly. 26% of the position is long-term, yet **every one of
its 23 sell orders books a short-term gain**:

| | long-term | short-term |
| --- | --- | --- |
| 20 dearest lots (sold first) | 0 | 20 |
| 20 cheapest lots (sold last) | 11 | 9 |

Note that this is about *cheap versus dear*, not *old versus new*. Cost and
recency correlate only weakly here — Spearman 0.35, with the dearest lots
ranging from 1 to 228 days old. It is the coincidence of cheap-and-old that
buries the long-term lots, not any tendency for expensive lots to be recent.

This analysis is only valid for the cost-basis method Coinbase is actually
applying. HIFO was inferred by matching Coinbase's reported cost basis (see
[sell-planner.md](sell-planner.md)); changing the method in Coinbase's settings
would change these numbers completely.

## What it surfaces today

Across the whole book: 200 short-term gains, 16 long-term gains, 4 short-term
losses, 6 long-term losses, **7 orders worth waiting on** and **6 with a
deadline**.

- **DOGE** is the standout — 7 rungs flagged `hold`, and 4 short-term losses
  crossing to long-term, the soonest in just **4 days**. It also carries 5
  long-term losses of the kind the brief says to avoid.
- **LPT** has 2 expiring short-term losses, soonest 40 days.
- **SHIB** and **XRP** are largely long-term already.

The `sell by` case came out of the data rather than the brief: DOGE row 5 was
a short-term loss four days from turning long-term, which the first cut
labelled a plain `ST loss` — the same as one with a year to run. Under the
brief's own rule that is backwards, so a near crossover on a loss is now a
deadline, not something to wait out.

## UI

Two columns on the ladder:

- **Age** — quantity-weighted average age in days of the lots that order
  consumes. Underlined where the lots differ in age; hovering gives the oldest
  and newest.
- **Books** — what that order realizes, with a `ST … · LT …` split underneath
  when it straddles both.
- **Term** — a badge: `hold 20d`, `sell by 4d`, `LT gain`, `ST gain`,
  `ST loss`, `LT loss`. Hovering gives the reasoning. A legend sits above the
  table.

Plus a **Long-term** stat in the summary bar: how much of the position is
already past one year, and the lot count.

The near-crossover threshold is 45 days (`NEAR_LONG_TERM_DAYS`).

## Verified

- Quantity accounted for by the classifier equals the quantity ordered, exactly.
- `shortGain + longGain === gain` on every row of every asset.
- Average age always falls between the newest and oldest lot consumed; every
  purely long-term row averages over 365 days and every purely short-term row
  under it.
- Lot counts are small (3–113 per asset), so shipping them to the browser is
  cheap and what-if rows classify instantly.

## Not done yet

- **Buys are untouched.** The original brief said "when I buy or sell"; this
  draft only covers sells.
- **No tax rates.** It reports the holding period, not the tax owed. Nothing
  here knows your bracket, your other gains, or wash-sale rules.
- **Not tax advice, and not a tax report.** Coinbase's own gain/loss documents
  remain the record.
- **Upcoming orders page is not annotated** — see "Where it lives".
- **45 days is a guess** at what "close to long term" means. Worth setting.
- **USDC** shows `no lots` on most rungs: its ladder sells far more than the
  history accounts for. Harmless, but it shows the edge case works.

## Open questions

- Should the near-crossover threshold be configurable, and what is the right
  default?
- For a loss the brief prefers short-term. Should the planner actively suggest
  selling *before* a lot turns long-term, i.e. a "sell by" date?
- Should buys be scored at all, and on what?
