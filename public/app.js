const SLICE_COLORS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
const MAX_SLICES = 8;

const el = (id) => document.getElementById(id);
const state = { data: null, hideDust: true, sort: { key: 'value', dir: 'desc' } };

// Numbers start high-to-low, the ticker starts A-Z.
const SORT_COLUMNS = {
  currency: 'text',
  amount: 'number',
  price: 'number',
  change24hPercent: 'number',
  value: 'number',
  allocation: 'number',
};

const money = (value, currency = 'USD') =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2,
  }).format(value);

const moneyExact = (value, currency = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

function price(value, currency = 'USD') {
  if (!value) return '—';
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: digits,
  }).format(value);
}

const amount = (value) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: value >= 1000 ? 2 : 8 }).format(value);

const percent = (value, withSign = true) =>
  `${withSign && value > 0 ? '+' : ''}${value.toFixed(2)}%`;

function signClass(value) {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'muted';
}

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

function showBanner(title, message, variant = 'error') {
  const banner = el('banner');
  banner.className = `banner ${variant === 'warn' ? 'warn' : ''}`;
  banner.innerHTML = `<h3></h3><div></div>`;
  banner.querySelector('h3').textContent = title;
  banner.querySelector('div').innerHTML = message;
  banner.hidden = false;
}

function renderSummary(data) {
  const { quoteCurrency: cur } = data;
  el('total-value').textContent = moneyExact(data.totalValue, cur);

  const change = data.change24h;
  const changeEl = el('total-change');
  changeEl.className = `delta ${signClass(change.percent)}`;
  changeEl.textContent = `${change.absolute >= 0 ? '+' : '−'}${money(Math.abs(change.absolute), cur)} (${percent(change.percent)}) · 24h`;

  const visible = data.holdings.filter((h) => !h.isDust);
  el('asset-count').textContent = String(visible.length);
  el('account-note').textContent =
    `${data.positionCount} position${data.positionCount === 1 ? '' : 's'}` +
    (data.holdings.length > visible.length ? ` · ${data.holdings.length - visible.length} dust` : '');

  const stakedStat = el('staked-stat');
  if (data.stakedValue > 0) {
    el('staked-value').textContent = moneyExact(data.stakedValue, cur);
    el('staked-note').textContent = `${((data.stakedValue / data.totalValue) * 100).toFixed(1)}%`;
    stakedStat.hidden = false;
  } else {
    stakedStat.hidden = true;
  }

  const top = data.holdings[0];
  el('top-asset').textContent = top ? top.currency : '—';
  el('top-asset-note').textContent = top ? `${(top.allocation * 100).toFixed(1)}%` : 'no balances';

  el('updated').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
  el('mode-badge').hidden = !data.mock;
}

/** Top assets get their own slice; the rest are folded into "Other". */
function buildSlices(holdings) {
  const priced = holdings.filter((h) => h.value > 0);
  const head = priced.slice(0, MAX_SLICES);
  const tail = priced.slice(MAX_SLICES);

  const slices = head.map((h, i) => ({
    label: h.currency,
    value: h.value,
    allocation: h.allocation,
    color: `var(${SLICE_COLORS[i]})`,
  }));

  if (tail.length > 0) {
    slices.push({
      label: `Other (${tail.length})`,
      value: tail.reduce((sum, h) => sum + h.value, 0),
      allocation: tail.reduce((sum, h) => sum + h.allocation, 0),
      color: 'var(--text-muted)',
    });
  }

  return slices;
}

function renderDonut(slices, data) {
  const svg = el('donut');
  const NS = 'http://www.w3.org/2000/svg';
  const radius = 70;
  const circumference = 2 * Math.PI * radius;

  svg.replaceChildren(svg.querySelector('title'));

  if (slices.length === 0) {
    const empty = document.createElementNS(NS, 'circle');
    empty.setAttribute('cx', '100');
    empty.setAttribute('cy', '100');
    empty.setAttribute('r', String(radius));
    empty.setAttribute('fill', 'none');
    empty.setAttribute('stroke', 'var(--border)');
    empty.setAttribute('stroke-width', '24');
    svg.append(empty);
    return;
  }

  let offset = 0;
  for (const slice of slices) {
    const length = slice.allocation * circumference;
    const arc = document.createElementNS(NS, 'circle');
    arc.setAttribute('cx', '100');
    arc.setAttribute('cy', '100');
    arc.setAttribute('r', String(radius));
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', slice.color);
    arc.setAttribute('stroke-width', '24');
    // Hairline gap between slices so neighbours stay distinguishable.
    arc.setAttribute('stroke-dasharray', `${Math.max(length - 1.5, 0)} ${circumference}`);
    arc.setAttribute('stroke-dashoffset', String(-offset));
    arc.setAttribute('transform', 'rotate(-90 100 100)');
    arc.append(Object.assign(document.createElementNS(NS, 'title'), {
      textContent: `${slice.label}: ${(slice.allocation * 100).toFixed(1)}%`,
    }));
    svg.append(arc);
    offset += length;
  }

  const total = document.createElementNS(NS, 'text');
  total.setAttribute('x', '100');
  total.setAttribute('y', '98');
  total.setAttribute('text-anchor', 'middle');
  total.setAttribute('fill', 'currentColor');
  total.setAttribute('font-size', '17');
  total.setAttribute('font-weight', '600');
  total.textContent = money(data.totalValue, data.quoteCurrency);

  const caption = document.createElementNS(NS, 'text');
  caption.setAttribute('x', '100');
  caption.setAttribute('y', '116');
  caption.setAttribute('text-anchor', 'middle');
  caption.setAttribute('fill', 'var(--text-muted)');
  caption.setAttribute('font-size', '11');
  caption.textContent = 'total';

  svg.append(total, caption);
}

function renderLegend(slices, data) {
  const legend = el('legend');
  legend.replaceChildren();

  for (const slice of slices) {
    const li = document.createElement('li');

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = slice.color;

    const label = document.createElement('span');
    label.textContent = slice.label;

    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent = moneyExact(slice.value, data.quoteCurrency);

    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = `${(slice.allocation * 100).toFixed(1)}%`;

    li.append(swatch, label, amt, pct);
    legend.append(li);
  }
}

/** Rows with no 24h data sort to the bottom whichever direction is active. */
function sortRows(rows) {
  const { key, dir } = state.sort;
  const factor = dir === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    if (SORT_COLUMNS[key] === 'text') return factor * a[key].localeCompare(b[key]);

    const left = a[key];
    const right = b[key];
    if (left === null && right === null) return a.currency.localeCompare(b.currency);
    if (left === null) return 1;
    if (right === null) return -1;

    return factor * (left - right) || a.currency.localeCompare(b.currency);
  });
}

function renderSortIndicators() {
  for (const th of document.querySelectorAll('#holdings-head th.sortable')) {
    const key = th.querySelector('button').dataset.key;
    const active = key === state.sort.key;
    th.setAttribute('aria-sort', active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    th.classList.toggle('sorted', active);
    th.querySelector('.caret').textContent = active ? (state.sort.dir === 'asc' ? '▲' : '▼') : '';
  }
}

function toggleSort(key) {
  if (!(key in SORT_COLUMNS)) return;
  state.sort = state.sort.key === key
    ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: SORT_COLUMNS[key] === 'text' ? 'asc' : 'desc' };
  render();
}

function renderTable(data) {
  const body = el('holdings-body');
  const rows = sortRows(state.hideDust ? data.holdings.filter((h) => !h.isDust) : data.holdings);
  body.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = 'No balances to show.';
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const holding of rows) {
    const tr = document.createElement('tr');

    const asset = document.createElement('td');
    // Cash has no cost basis, so it gets no planner link.
    const plannable = holding.currency !== data.quoteCurrency;
    const href = `/asset.html?symbol=${encodeURIComponent(holding.currency)}`;
    const ticker = document.createElement(plannable ? 'a' : 'span');
    ticker.className = plannable ? 'ticker asset-link' : 'ticker';
    if (plannable) ticker.href = href;
    ticker.textContent = holding.currency;
    asset.append(ticker);
    const notes = [];
    if (holding.staked > 0) notes.push(`${amount(holding.staked)} staked`);
    if (holding.hold > 0) notes.push(`${amount(holding.hold)} on hold`);
    if (notes.length > 0) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = notes.join(' · ');
      asset.append(sub);
    }

    const amountCell = document.createElement('td');
    amountCell.className = 'num';
    amountCell.textContent = amount(holding.amount);

    const priceCell = document.createElement('td');
    priceCell.className = 'num';
    priceCell.textContent = price(holding.price, data.quoteCurrency);

    const changeCell = document.createElement('td');
    changeCell.className = `num ${holding.change24hPercent === null ? 'muted' : signClass(holding.change24hPercent)}`;
    changeCell.textContent = holding.change24hPercent === null ? '—' : percent(holding.change24hPercent);

    const valueCell = document.createElement('td');
    valueCell.className = 'num';
    valueCell.textContent = moneyExact(holding.value, data.quoteCurrency);

    const allocCell = document.createElement('td');
    allocCell.className = 'num';
    const bar = document.createElement('span');
    bar.className = 'bar';
    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.max(holding.allocation * 100, holding.value > 0 ? 1 : 0)}%`;
    track.append(fill);
    const pct = document.createElement('span');
    pct.textContent = `${(holding.allocation * 100).toFixed(1)}%`;
    bar.append(track, pct);
    allocCell.append(bar);

    tr.append(asset, valueCell, amountCell, priceCell, changeCell, allocCell);

    // The whole row is a target too, but the anchor keeps it keyboard-reachable.
    if (plannable) {
      tr.className = 'clickable';
      tr.addEventListener('click', (event) => {
        if (event.target.closest('a')) return;
        location.href = href;
      });
    }
    body.append(tr);
  }
}

function render() {
  const data = state.data;
  if (!data) return;

  renderSummary(data);
  renderSortIndicators();
  const slices = buildSlices(data.holdings);
  renderDonut(slices, data);
  renderLegend(slices, data);
  renderTable(data);

  if (data.warnings?.length > 0) {
    showBanner('Partial data', data.warnings.map((w) => `<div>${w}</div>`).join(''), 'warn');
  } else {
    el('banner').hidden = true;
  }
}

async function load({ refresh = false } = {}) {
  const button = el('refresh');
  button.disabled = true;

  try {
    const response = await fetch(`/api/portfolio${refresh ? '?refresh=1' : ''}`);
    const payload = await readJson(response);

    if (!response.ok) {
      const hint = payload.hint ? `<div class="sub">${payload.hint}</div>` : '';
      showBanner('Could not load your portfolio', `<div>${payload.error ?? response.statusText}</div>${hint}`);
      el('holdings-body').replaceChildren();
      return;
    }

    state.data = payload;
    render();
  } catch (error) {
    showBanner('Could not reach the server', `<div>${error.message}</div>`);
  } finally {
    button.disabled = false;
  }
}

el('holdings-head').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-key]');
  if (button) toggleSort(button.dataset.key);
});

el('refresh').addEventListener('click', () => load({ refresh: true }));
el('hide-dust').addEventListener('change', (event) => {
  state.hideDust = event.target.checked;
  render();
});

load();
setInterval(() => load(), 60_000);
