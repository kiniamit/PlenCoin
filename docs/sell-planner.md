# Feature: Sell planner

Status: built · First shipped 2026-09-22 · Owner: akini

## Brief

As given by the requester, verbatim:

> First feature I want to build is for a user to plan his sells. Say I want to
> plan my strategy to sell an asset. I want to see how much lifetime profit or
> loss would I be sitting on after each sell order. Say my current lifetime
> profit (or loss) on TRB is 3232.7 $. I want to see a number right next to my
> each sell order as to how much would the lifetime profit (or loss) would be at
> that point. Let's also create a feature documentation. And add the
> requirements I just gave as brief for this feature. We can open orders page
> when I click on an asset from holdings table.

In short:

1. Clicking an asset in the holdings table opens a page for that asset.
2. That page lists the asset's sell orders.
3. Beside each order, show what lifetime profit/loss would be **at that point** —
   i.e. once that order and everything before it has filled.

## Decisions

Two questions came out of the brief. Both were put to the requester and
answered before the build.

**1. What does "lifetime P/L" mean?** → *Realized + unrealized, HIFO.*

It is the whole history of the asset, not just the open position:

```
lifetime P/L = realized P/L on every past sell
             + unrealized P/L on what is still held
```

The alternative considered and rejected was unrealized-only, which is what the
Coinbase app shows per asset. For TRB the two disagree in sign: −$3,232.74
lifetime versus +$1,415.62 unrealized, because past sells lost considerably more
than the remaining position has gained.

**2. Which orders appear in the ladder?** → *Open Coinbase sell orders, plus
what-if rows the user adds.*

What-if rows are local to the browser session and clearly tagged. Nothing on
this page ever places, edits or cancels a real order.

## How lifetime P/L is computed

### The ledger, not the fills

The first implementation rebuilt cost basis from the Advanced Trade fills
endpoint. That is structurally incapable of being correct. For SOL:

| Source | SOL | Seen by the old code? |
| --- | --- | --- |
| `SOL-USD` fills | +100.417 | yes |
| `SOL-USDC` fill — one 13.24 SOL sale | −13.244 | **no**, wrong pair |
| `trade` (Convert), 2 entries | +2.146 | **no**, not a fill |
| `staking_reward`, 80 payouts | +1.105 | **no**, not a fill |
| **Total** | **90.424** | vs 90.424 held |

Querying only `{ASSET}-USD` missed a real 13.24 SOL sale on `SOL-USDC`, and
Converts and staking rewards are not fills at all. The gap surfaced as
"incomplete history" and a nonsense unrealized figure of $0.00.

Cost basis is therefore rebuilt from the **v2 transaction ledger**
(`/v2/accounts/{id}/transactions`), which records every movement with a signed
crypto `amount` and the USD `native_amount` at the time. It is the only
complete record.

### Lot matching

`walkLedgerHifo()` in `src/pnl.js`. Acquisitions open a lot priced at the USD
value of the movement; disposals consume the **highest-priced** lots first.

Three classes of entry need special handling:

- **Internal transfers** (`staking_transfer`, `vault_transfer`, `pro_deposit`, …)
  are skipped. Moving coins between your own wallets is not a purchase or a
  sale; counting it would fabricate realized P/L and reset cost basis.
- **Income** (`staking_reward`, `inflation_reward`, `interest`) opens a lot at
  its value on receipt. There is no purchase behind it, so its basis is what it
  was worth when it landed.
- **Sends** remove lots at cost without realizing a gain. The coins left the
  account but were not sold. A warning reports the quantity involved.

### Why HIFO

The method had to be inferred, since Coinbase's `realized_pl` field on fills is
always `0` for spot. Rebuilding TRB and comparing the remaining basis against
Coinbase's own reported `cost_basis` of $4,284.79:

| Method | Remaining basis | Error |
| --- | --- | --- |
| FIFO | $5,001.40 | 17% |
| LIFO | $13,890.06 | 224% |
| **HIFO** | **$4,276.91** | **0.18%** |

HIFO, matching Coinbase's documented retail default.

### Where we deliberately differ from Coinbase

For **staked** assets, Coinbase re-marks cost basis at the moment of staking.
SOL shows an average entry of $63.10 in the spot wallet and $136.61 in the
staking wallet — the same coins, repriced on transfer.

Staking is not a disposal, so for a lifetime figure the original basis has to
carry through, which is what skipping internal transfers achieves. The
consequence is that per-position cost basis on a staked asset will not match
what the Coinbase app displays. Assets that have never been staked match it to
within 0.2%.

### Validation

- Every non-dust holding reconciles: rebuilt quantity versus held quantity
  drifts **0.000%** across all 15 assets.
- TRB comes out at **−$3,232.74**, reproducing the requester's own independently
  known figure of 3,232.7 to the cent.

### Projecting the ladder

A rung only fills because the price got there. At that moment spot **is** that
rung's limit price, so the coins still held are worth that price too. Each row
is therefore two parts:

```
lifetime(k) = lifetimeNow
            + Σ_{i≤k} (limit_i − spot) × size_i − fees     ← banked by then
            + (limit_k − spot) × remaining_k               ← the rest, revalued
```

which reduces to `realized + Σ proceeds − fees + limit_k × remaining − basis`.
Lot matching cancels out of the total — the cost consumed by a sell and the
basis left behind always sum to the same number — so the browser can recompute
the whole ladder instantly as what-if rows are added, with no further API calls.

> **Corrected 2026-09-22.** The first version marked the remainder at *today's*
> spot, which badly understated the upper rungs: it priced a large unsold
> position as though the rally that triggered the fills had never happened. For
> SOL at the $154 rung that read $10,881.65 against a correct $13,202.73, with
> 63.9 SOL still held and valued at $117.64 instead of $154.

`buildLadder()` in `src/pnl.js` is the reference implementation; the identical
formula lives in `public/asset.js` for interactive recomputation. Every rung is
cross-checked against first principles in testing.

### Fees

The fee rate defaults to the account's blended sell rate, derived from one page
of recent fills as `commissions ÷ notional`. It is editable per session, and at
0 it shows gross figures.

## Data sources

| Endpoint | Used for |
| --- | --- |
| `GET /v2/accounts` | Wallet ids per asset — an asset can have a spot wallet and a staking wallet |
| `GET /v2/accounts/{id}/transactions` | The full ledger: trades, converts, rewards, transfers, sends |
| `GET /api/v3/brokerage/orders/historical/batch?order_status=OPEN` | Resting orders; SELL legs become the ladder |
| `GET /api/v3/brokerage/orders/historical/fills` | One page only, to blend a fee rate |
| Portfolio breakdown (see main README) | Held quantity, current value, spot price |

Sells are read from `limit_limit_gtc` / `gtd` / `fok` and stop-limit
configurations. Open **buy** orders are counted and reported but excluded from
the ladder.

## API

`GET /api/asset?symbol=TRB` → the asset detail payload. `&refresh=1` bypasses
the 60s cache (`ASSET_CACHE_MS`), which matters because a full rebuild costs one
paginated call per 100 ledger entries — roughly 14 for an asset like SOL.

Notable fields: `lifetimePL`, `realizedPL`, `unrealizedPL`, `costBasis`,
`avgEntry`, `heldQty`, `currentPrice`, `feeRate`, `ledgerEntries`, `walletCount`,
`rewardQty`, `rewardValue`, `reconciled`, `sellOrders[]`, `buyOrderCount`,
`warnings[]`.

## UI

`/asset.html?symbol=TRB`, reached by clicking any non-cash row in the holdings
table. The ticker is a real link, so it is keyboard-reachable; the rest of the
row is click-through for convenience.

- **Summary bar** — lifetime P/L, realized, unrealized, held, average entry.
- **Ladder** — one row per sell order, cheapest limit first, since that is the
  order they fill in as price rises. Columns: size, limit, vs spot, net
  proceeds, remaining position, and **lifetime P/L after fill**.
- **What-if rows** — add a size and limit price; the row slots into the ladder
  at its price and everything below it recomputes. Tagged, tinted, removable.
- **"Sell the rest"** — a closing row in the table's `<tfoot>`, set apart by a
  heavier rule and a tint because it is not one of the user's orders. The
  ladder normally stops short of the full position (TRB's 33 orders cover 192.3
  of 284.91 held), so this answers "and if the remainder went at the last rung's
  price too?". It tracks the last row of the ladder as displayed, what-if rows
  included, and disappears when the ladder already covers everything.

  Because the last rung already values the remainder at its price, actually
  selling it only costs the fee — the row's job is to move that P/L from
  unrealized to banked and take the position to zero. For SOL: $20,474.57 held
  at $291 versus $20,435.23 sold at $291, a $39.34 fee apart.

  `projectFullExit()` is implemented in both `src/pnl.js` and `public/asset.js`.

## Correctness guards

- **Reconciliation.** If the rebuilt quantity drifts more than 0.5% from the
  held quantity, cost basis is suspect. Rather than zeroing the figure, the page
  estimates basis as `average entry × held quantity`, says the number is
  approximate, and reports `reconciled: false`. An earlier version showed $0.00
  unrealized in this case, which was worse than an approximation.
- **No history.** An asset with no fills for its USD pair reports a lifetime P/L
  of 0 and says so; the ladder itself is still meaningful.
- **Overselling.** If the orders total more than the position, the remaining
  column goes negative and a banner says the ladder oversells.

## Limitations

- **Each row is a price level, not a forecast.** It answers "if the price
  reaches this limit", valuing sold coins at their limits and the rest at the
  rung's price. It says nothing about whether the price gets there, or when.
- **Fill order is assumed by price**, ascending. Real fills depend on the path
  price takes; a spike that clears five rungs at once lands at the same place,
  but a partial fill will not.
- **Coins transferred in** from outside Coinbase carry no purchase to match
  against, so their basis is whatever the ledger valued the receipt at.
- **Cost basis on staked assets will not match the Coinbase app**, by design —
  see "Where we deliberately differ" above.
- **The ladder is USD-pair only.** Open orders are read from `{ASSET}-USD`, so
  a resting order on another quote pair will not appear. Cost basis is not
  affected — the ledger covers every pair.
- **Partial fills** on an open order are not netted out; the ladder uses the
  order's original `base_size`.

## Possible next steps

- Target-price solver: "what limit price on the remaining position gets lifetime
  P/L to zero (or to $X)?"
- Persist what-if ladders per asset so a plan survives a reload.
- Mark the break-even rung explicitly — TRB crosses from red to green at rung 24
  ($73.20).
- Extend to buy orders, for averaging-down plans.
