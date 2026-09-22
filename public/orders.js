const el = (id) => document.getElementById(id);
const ALL_COINS = '__all__';
const state = { data: null, loading: false, coin: ALL_COINS };

const AUTO_REFRESH_KEY = 'plencoin.orders.autoRefresh';
const INTERVAL_KEY = 'plencoin.orders.refreshSeconds';
const DEFAULT_SECONDS = 15;
const MIN_SECONDS = 5;
const MAX_SECONDS = 600;
const STEP_SECONDS = 5;
let autoRefreshTimer = null;
let refreshSeconds = DEFAULT_SECONDS;

const money = (value, currency = 'USD') =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  }).format(value);

function price(value, currency = 'USD') {
  if (!value) return '—';
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits }).format(value);
}

const qty = (value) =>
  new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(value);

/** A non-JSON body (a proxy error, a stale server) must not surface as a parse error. */
async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: `Server returned ${response.status} ${response.statusText || ''}`.trim() +
        (text ? ` — ${text.slice(0, 120)}` : ''),
      hint: response.status === 404 ? 'If you just changed files under src/, restart the server.' : undefined,
    };
  }
}

function showBanner(title, html, variant = 'error') {
  const banner = el('banner');
  banner.className = `banner ${variant === 'warn' ? 'warn' : ''}`;
  banner.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = title;
  const body = document.createElement('div');
  body.innerHTML = html;
  banner.append(h, body);
  banner.hidden = false;
}

/** How far the market must travel, and which way. */
function moveLabel(row) {
  if (row.requiredMovePercent === null) return { text: '—', className: 'muted' };
  const pct = row.requiredMovePercent;
  const arrow = pct >= 0 ? '▲' : '▼';
  return {
    text: `${arrow} ${Math.abs(pct).toFixed(1)}%`,
    // Direction, not good or bad: a buy waits for a fall, a sell for a rise.
    className: pct >= 0 ? 'up' : 'down',
  };
}

function renderBook(rows, bodyId, summaryId, emptyText) {
  const body = el(bodyId);
  body.replaceChildren();

  const cur = state.data.quoteCurrency;
  const total = rows.reduce((sum, r) => sum + r.notional, 0);
  el(summaryId).textContent = rows.length === 0
    ? 'none open'
    : `${rows.length} order${rows.length === 1 ? '' : 's'} · ${money(total, cur)}`;

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = emptyText;
    tr.append(td);
    body.append(tr);
    return;
  }

  const cell = (text, className = '') => {
    const td = document.createElement('td');
    td.className = className;
    td.textContent = text;
    return td;
  };

  // Running total walks down the list in the order shown: nearest first, so
  // each figure is "everything that fills before this, plus this".
  let running = 0;

  for (const [index, row] of rows.entries()) {
    const tr = document.createElement('tr');
    running += row.notional;

    const asset = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'asset-link ticker';
    link.href = `/asset.html?symbol=${encodeURIComponent(row.currency)}`;
    link.textContent = row.currency;
    asset.append(link);
    if (row.currentPrice) {
      const note = document.createElement('span');
      note.className = 'sub';
      note.textContent = price(row.currentPrice, row.quoteCurrency);
      asset.append(note);
    }

    const move = moveLabel(row);
    tr.append(
      cell(String(index + 1), 'num sr'),
      asset,
      cell(move.text, `num strong ${move.className}`),
      cell(price(row.limitPrice, row.quoteCurrency), 'num'),
      cell(qty(row.size), 'num'),
      cell(money(row.notional, row.quoteCurrency), 'num'),
      cell(money(running, row.quoteCurrency), 'num running'),
    );
    body.append(tr);
  }
}

/** One chip per coin that actually has orders, busiest first. */
function renderFilters() {
  const d = state.data;
  const counts = new Map();
  for (const row of [...d.buys, ...d.sells]) {
    counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1);
  }

  // A coin can disappear between refreshes once its last order fills.
  if (state.coin !== ALL_COINS && !counts.has(state.coin)) state.coin = ALL_COINS;

  const coins = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const container = el('filters');
  container.replaceChildren();

  const chip = (value, label, count) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.setAttribute('aria-pressed', String(state.coin === value));
    button.textContent = label;

    const badge = document.createElement('span');
    badge.className = 'chip-count';
    badge.textContent = String(count);
    button.append(badge);

    button.addEventListener('click', () => {
      state.coin = value;
      render();
    });
    return button;
  };

  container.append(chip(ALL_COINS, 'All coins', d.buys.length + d.sells.length));
  for (const [currency, count] of coins) container.append(chip(currency, currency, count));
}

const forCoin = (rows) => (state.coin === ALL_COINS ? rows : rows.filter((r) => r.currency === state.coin));

function renderSummary(buys, sells) {
  const d = state.data;
  const cur = d.quoteCurrency;
  const sum = (rows) => rows.reduce((total, r) => total + r.notional, 0);
  const assets = new Set([...buys, ...sells].map((r) => r.currency)).size;

  el('total-count').textContent = String(buys.length + sells.length);
  el('asset-note').textContent =
    state.coin === ALL_COINS ? `across ${assets} asset${assets === 1 ? '' : 's'}` : `${state.coin} only`;
  el('buy-count').textContent = String(buys.length);
  el('buy-notional').textContent = money(sum(buys), cur);
  el('sell-count').textContent = String(sells.length);
  el('sell-notional').textContent = money(sum(sells), cur);

  const nearest = [...buys, ...sells]
    .filter((r) => r.requiredMovePercent !== null)
    .sort((a, b) => Math.abs(a.requiredMovePercent) - Math.abs(b.requiredMovePercent))[0];
  if (nearest) {
    const move = moveLabel(nearest);
    el('nearest').textContent = `${nearest.currency} ${move.text}`;
    el('nearest-note').textContent = `${nearest.side.toLowerCase()} at ${price(nearest.limitPrice, cur)}`;
  } else {
    el('nearest').textContent = '—';
    el('nearest-note').textContent = '';
  }
}

function render() {
  const d = state.data;

  el('mode-badge').hidden = !d.mock;
  el('updated').textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString()}`;

  renderFilters();

  const buys = forCoin(d.buys);
  const sells = forCoin(d.sells);
  const scope = state.coin === ALL_COINS ? '' : ` for ${state.coin}`;

  renderSummary(buys, sells);
  renderBook(buys, 'buy-body', 'buy-summary', `No open buy orders${scope}.`);
  renderBook(sells, 'sell-body', 'sell-summary', `No open sell orders${scope}.`);

  if (d.warnings.length > 0) {
    showBanner('Heads up', d.warnings.map((w) => `<div>${w}</div>`).join(''), 'warn');
  } else {
    el('banner').hidden = true;
  }
}

async function load({ refresh = false } = {}) {
  // A slow request must not stack up behind the 15s tick.
  if (state.loading) return;
  state.loading = true;

  const button = el('refresh');
  button.disabled = true;

  try {
    const response = await fetch(`/api/orders${refresh ? '?refresh=1' : ''}`);
    const payload = await readJson(response);

    if (!response.ok) {
      const hint = payload.hint ? `<div class="sub">${payload.hint}</div>` : '';
      showBanner('Could not load orders', `<div>${payload.error ?? response.statusText}</div>${hint}`);
      return;
    }

    state.data = payload;
    render();
  } catch (error) {
    showBanner('Could not reach the server', `<div>${error.message}</div>`);
  } finally {
    state.loading = false;
    button.disabled = false;
  }
}

// Storage can throw in a private window; every control works without it.
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not persisted */
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function clampSeconds(value) {
  if (!Number.isFinite(value)) return DEFAULT_SECONDS;
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(value)));
}

/**
 * Auto-refresh bypasses the server cache, so every tick is genuinely current
 * rather than up to a cache window stale.
 */
function setAutoRefresh(on) {
  el('auto-refresh').checked = on;

  clearInterval(autoRefreshTimer);
  autoRefreshTimer = on ? setInterval(() => load({ refresh: true }), refreshSeconds * 1000) : null;

  remember(AUTO_REFRESH_KEY, on ? '1' : '0');
}

function setRefreshSeconds(seconds) {
  refreshSeconds = clampSeconds(seconds);
  el('interval').value = String(refreshSeconds);
  remember(INTERVAL_KEY, String(refreshSeconds));
  // Restart the timer so a new interval takes effect immediately.
  if (el('auto-refresh').checked) setAutoRefresh(true);
}

function initialAutoRefresh() {
  // On unless explicitly turned off before.
  return recall(AUTO_REFRESH_KEY) !== '0';
}

el('refresh').addEventListener('click', () => load({ refresh: true }));
el('auto-refresh').addEventListener('change', (event) => setAutoRefresh(event.target.checked));

el('interval').addEventListener('change', (event) => setRefreshSeconds(Number.parseInt(event.target.value, 10)));
el('interval-down').addEventListener('click', () => setRefreshSeconds(refreshSeconds - STEP_SECONDS));
el('interval-up').addEventListener('click', () => setRefreshSeconds(refreshSeconds + STEP_SECONDS));

setRefreshSeconds(Number.parseInt(recall(INTERVAL_KEY) ?? '', 10) || DEFAULT_SECONDS);
setAutoRefresh(initialAutoRefresh());
load();
