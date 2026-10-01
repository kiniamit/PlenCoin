# PlenCoin — product overview

Source of truth for anything user-facing: intro videos, demos, screenshots,
landing copy. The other docs in this folder are engineering notes; use this one
for describing the tool to a person.

## In one line

**PlenCoin reads your Coinbase account and tells you what your open sell orders
will actually cost you in tax.**

## Who it is for

Someone who holds crypto on Coinbase long enough to care about tax, and who
manages positions with a ladder of resting limit orders rather than trading
in and out.

## The problem

Three systems each hold part of the answer, and none of them talk:

- **Coinbase** knows your open orders and your balances — but says nothing
  about tax.
- **Tax tools** (Koinly, CoinTracker) know your cost basis — but only look
  backwards at trades that already happened.
- **Nobody** looks at an order that has *not* filled yet and tells you what it
  will do to you.

PlenCoin sits in that gap.

---

## Feature 1 — Portfolio dashboard

**One line:** Your whole Coinbase position on one page, staking included.

**What you see:** Total value and 24h change, a sortable holdings table, an
allocation donut.

**Why it matters:** Coinbase reports staked coins as separate positions, so
naive tools miss them. PlenCoin reconciles to the cent against Coinbase's own
total.

**Demo beat:** The Staked figure in the summary bar — money that simpler
dashboards leave out entirely.

---

## Feature 2 — Upcoming orders

**One line:** Every resting buy and sell across every coin, ranked by how close
it is to filling.

**What you see:** Two columns — buys left, sells right — sorted by the price
move needed to reach each one. A running total, a coin filter, and value
highlighting for unusually small or large orders.

**Why it matters:** Exchanges list open orders by pair or date. Nobody shows
them by *distance from filling*, which is the only ordering that answers "what
happens next?"

**Demo beat:** Scroll the sell column — from an order 2% away to one needing a
2,400% rally — and the running total climbing alongside.

---

## Feature 3 — Sell planner

**One line:** What your lifetime profit becomes at every rung of your sell
ladder.

**What you see:** One row per open sell order, cheapest first. Each shows the
price, what it books, and **lifetime P/L at that price** — assuming everything
below it has filled and the coins you still hold are worth that much too.

**Why it matters:** It answers the question a ladder is really asking: *if this
plays out, where do I end up?* Cost basis is rebuilt from the full transaction
ledger — every trade, conversion, transfer and staking reward — so the answer
is grounded in real history, not an estimate.

**Demo beat:** A position deep in the red at the top of the ladder crossing
into profit partway down, with the exact rung where it happens.

**Also:** add hypothetical rows to test a price before placing anything. Fully
read-only — PlenCoin never places, edits or cancels an order.

---

## Feature 4 — Holding-period signals

**One line:** Which orders are about to change tax treatment, and whether
acting is worth it.

**What you see:** A badge on each rung, and a cross-asset list of every order
with a deadline:

- **hold 13d** — a short-term gain that becomes long-term if you wait.
- **sell by 4d** — a short-term loss that stops being short-term if you don't.

**Why it matters:** This is the piece nothing else does. Tax tools are
retrospective; exchanges are tax-blind. PlenCoin watches orders that have not
filled and tells you when the clock is running.

**The honest bit, and the best demo beat:** a deadline alone is misleading.
Selling a specific lot means selling everything ahead of it first. So every
signal carries what that costs:

| Signal | At stake | To reach it |
| --- | --- | --- |
| LPT, sell by 33d | $220 short-term loss | **nothing ahead of it** |
| DOGE, hold 13d | $67 | sell 9,700 first, booking −$530 |

Same badge, opposite conclusions. A tool that only flagged the deadline would
have recommended both.

**Also:** scans in the background on startup and hourly, so the list is ready
when you open it.

---

## Suggested arc for a short intro

1. The gap — exchange, tax tool, neither answers the question. *(~10s)*
2. Dashboard — everything, staking included. *(~10s)*
3. Upcoming orders — what is closest to filling. *(~15s)*
4. Sell planner — where the ladder lands you. *(~25s)*
5. Signals — the deadline, and the cost of acting on it. *(~25s)*
6. Read-only, runs on your own machine, your keys never leave it. *(~10s)*

## Vocabulary — use consistently

| Term | Means |
| --- | --- |
| **rung** | one order in the sell ladder |
| **ladder** | your open sell orders, ordered by price |
| **lot** | a batch of coins bought at one time and price |
| **lifetime P/L** | realized on past sells + unrealized on what is still held |
| **short / long term** | held one year or less / more than a year |

## Claims we can make

- Reconciles to the cent against Coinbase's reported portfolio total.
- Rebuilds cost basis from the complete transaction ledger, reconciling to
  0.000% on every holding.
- Read-only: never places, edits or cancels an order.
- Runs on your own machine; API keys never leave it.
- No dependencies, no account, no subscription.

## Claims we must not make

- **Not tax advice, and not a tax return.** It reports holding periods, not tax
  owed. It knows nothing of your bracket, your other gains, or wash sales.
  Coinbase's own gain/loss documents remain the record.
- **Not a price forecast.** Every figure answers "if the price reaches this",
  never "the price will reach this".
- **Not trading advice** and not automated trading.
- Do not imply it works beyond Coinbase, or with non-USD pairs.
- Do not imply signals arrive while the app is closed — nothing runs then.

## Recording the demo

Use mock mode — `npm run mock` — for anything that will be seen publicly. It
serves realistic sample data with no credentials, so no real balances, order
sizes or cost basis are exposed. The **mock data** badge in the header makes it
obvious the figures are illustrative.
