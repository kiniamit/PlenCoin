# PlenCoin

A local, read-only dashboard for a Coinbase portfolio: total value, 24h change,
allocation donut, and a holdings table with per-asset price and value.
Click any column header to sort; click it again to reverse. Assets with no
24h data always sort to the bottom.

No dependencies — just Node 18.17+ and the standard library.

## Quick look, no keys

```bash
npm run mock
```

Opens on <http://127.0.0.1:3000> with sample data. Coinbase is never contacted.

### Where to run it

Node is installed on the Windows side only, so run this from **PowerShell or
CMD**, not from a WSL shell. The simplest form skips npm entirely:

```powershell
cd "C:\AK\Docs\My Projects\PlenCoin"
node server.js --mock
```

`npm` from PowerShell may fail with *"npm.ps1 cannot be loaded because running
scripts is disabled on this system"*. That is the execution policy blocking
npm's PowerShell shim, not a problem with this project. Either call the batch
shim directly:

```powershell
npm.cmd run mock
```

or allow local scripts once, for your user only:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

From a WSL shell there is no `node` on `PATH`, and bash cannot execute
`npm.cmd`. Go through `cmd.exe`:

```bash
cd "/mnt/c/AK/Docs/My Projects/PlenCoin"
cmd.exe /c "npm run mock"
```

Either way the server listens on the Windows side, so open
<http://127.0.0.1:3000> in a normal Windows browser.

## Real data

1. Create a **CDP API key** at <https://portal.cdp.coinbase.com/access/api> with
   **View** permission only. Download the JSON — it contains the key name and the
   private key.
2. `cp .env.example .env` and fill in:

   ```
   COINBASE_API_KEY_NAME=organizations/<org-uuid>/apiKeys/<key-uuid>
   COINBASE_API_PRIVATE_KEY=-----BEGIN EC PRIVATE KEY-----\nMHc...\n-----END EC PRIVATE KEY-----\n
   ```

   Keep the private key on one line with the `\n` escapes intact. Base64 Ed25519
   keys (the newer format, a single ~88-character string) work too.
3. Verify the key, then start:

   ```bash
   npm run check
   npm start
   ```

## Features

| Page | What it does |
| --- | --- |
| `/` | Portfolio dashboard — total value, 24h change, sortable holdings, allocation. Staked funds included. |
| `/orders.html` | [Upcoming orders](docs/upcoming-orders.md) — every resting buy and sell, ranked by how far the price must move. |
| `/asset.html?symbol=X` | [Sell planner](docs/sell-planner.md) — lifetime P/L rebuilt from your full ledger, projected across the sell ladder. |
| `/signals.html` | [Holding-period signals](docs/trade-timing.md) — orders whose tax treatment changes on a date. Scanned on startup and hourly. |

## How it works

```
server.js            static file server + JSON API, no framework
src/coinbase.js      CDP JWT signing (ES256 / EdDSA) and the API calls
src/portfolio.js     groups positions by asset, prices them, computes totals
src/asset.js         per-asset detail: cost basis, lifetime P/L, open orders
src/orders.js        every open order, ranked by distance from spot
src/signals.js       background sweep for holding-period deadlines
src/pnl.js           HIFO lot matching and the sell-ladder projection
src/mock.js          sample payloads for MOCK=1
public/              index.html (dashboard), asset.html (planner), orders.html (order book)
docs/                feature documentation
scripts/             npm run check
```

The browser never sees the API key. The page calls `/api/portfolio`, and the
server signs a fresh 2-minute JWT per Coinbase request.

Data sources:

- `GET /api/v3/brokerage/portfolios` then `/portfolios/{uuid}` — the portfolio
  breakdown, which is the source of truth. Its `spot_positions` include
  `ACCOUNT_TYPE_STAKED_FUNDS` entries and carry Coinbase's own fiat valuation,
  so the total matches the Coinbase app to the cent.
- `GET /api/v3/brokerage/market/products` — 24h change for each asset held.
- `GET /v2/exchange-rates` — unauthenticated fallback for anything without a USD
  spot pair. Those rows show `—` for 24h change.
- `GET /api/v3/brokerage/accounts` — fallback only, used if the breakdown call
  fails. It returns wallet balances exclusively, so staked funds are missing and
  the page shows a warning banner saying so.

**Staking.** Staked assets live in separate positions that `/accounts` does not
return at all, which is why the breakdown is the primary source. Each row shows
the combined quantity with a `N staked` note underneath, and the summary bar
carries a Staked total. Note that a wallet's `hold` is unrelated to staking — it
is funds locked by open orders.

Quantities come back from the breakdown as JSON floats (~8 significant digits)
rather than the exact decimal strings `/accounts` uses, so a displayed quantity
can differ from the Coinbase app in the last digit or two. Fiat values are
unaffected.

Portfolio 24h change is derived from each asset's 24h move, so it reflects price
movement only — deposits and withdrawals in the last day will skew it.

Responses are cached for 15s (`CACHE_MS`); the page auto-refreshes every 60s and
**Refresh** bypasses the cache. Per-asset detail is cached for 60s
(`ASSET_CACHE_MS`), since rebuilding cost basis costs one call per 100 fills.

## Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `COINBASE_API_KEY_NAME` | yes | — | Also accepts `COINBASE_API_KEY` |
| `COINBASE_API_PRIVATE_KEY` | yes | — | Also accepts `COINBASE_API_SECRET` |
| `PORT` | no | `3000` | |
| `HOST` | no | `127.0.0.1` | Set to `0.0.0.0` only behind something that authenticates |
| `MOCK` | no | — | `1` serves sample data |
| `APP_PASSPHRASE` | no | — | Set it to require a passphrase; see below |
| `SESSION_DAYS` | no | `30` | How long a sign-in lasts |
| `CACHE_MS` | no | `15000` | Server-side cache window |
| `ASSET_CACHE_MS` | no | `60000` | Cache window for per-asset detail |
| `SCAN_INTERVAL_MS` | no | `3600000` | How often the signals sweep re-runs |

Real environment variables always win over `.env`, so CI secrets need no extra
wiring. In GitHub Actions:

```yaml
- run: npm run check
  env:
    COINBASE_API_KEY_NAME: ${{ secrets.COINBASE_API_KEY_NAME }}
    COINBASE_API_PRIVATE_KEY: ${{ secrets.COINBASE_API_PRIVATE_KEY }}
```

## Reaching it from another device

By default the server binds to `127.0.0.1`, so only this machine can reach it.
To use it from a phone on the same network:

1. Set a passphrase in `.env` — `APP_PASSPHRASE=something long`. Without one the
   pages expose your entire portfolio, cost basis and trade history to anything
   on the network.
2. Set `HOST=0.0.0.0` in `.env`.
3. Allow the port through the firewall. On Windows, in an **Administrator**
   PowerShell, and only for a network you have marked Private:

   ```powershell
   New-NetFirewallRule -DisplayName "PlenCoin 3000" -Direction Inbound `
     -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
   ```

4. Browse to `http://<your-lan-ip>:3000` and enter the passphrase.

The gate is a shared secret over plain HTTP. It keeps casual eyes off a home
network; it is not authentication for anything hostile. The server warns at
startup if it is bound beyond localhost with no passphrase set.

**How it works.** A correct passphrase sets an HttpOnly, SameSite=Lax cookie
holding `<expiry>.<hmac>`, signed with the passphrase itself — so sessions
survive a restart but die the instant the passphrase changes. Comparisons are
timing-safe. Five wrong attempts locks that address out for 30s, doubling to a
15 minute cap.

## Notes

- `.env` is gitignored. Keep it that way — the private key signs API requests.
- View-only keys cannot trade or withdraw; this app only ever issues GETs.
