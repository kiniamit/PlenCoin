const el = (id) => document.getElementById(id);
const symbol = (new URLSearchParams(location.search).get('symbol') || '').toUpperCase();

const state = { data: null, whatIfs: [], feeRate: 0 };

const money = (value, currency = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

const signedMoney = (value, currency = 'USD') =>
  `${value >= 0 ? '+' : '−'}${money(Math.abs(value), currency)}`;

function price(value, currency = 'USD') {
  if (!value) return '—';
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits }).format(value);
}

const qty = (value) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: Math.abs(value) >= 1000 ? 2 : 8 }).format(value);

const signClass = (value) => (value > 0 ? 'up' : value < 0 ? 'down' : 'muted');

const EPS = 1e-12;
/** A short-term gain this close to the one-year mark is worth waiting out. */
const NEAR_LONG_TERM_DAYS = 45;

const SIGNALS = {
  wait:     { label: 'hold for LT', tone: 'act',  hint: 'Short-term gain, but the lots turn long-term soon.' },
  'lt-gain': { label: 'LT gain',    tone: 'good', hint: 'Already long-term.' },
  'st-gain': { label: 'ST gain',    tone: 'warn', hint: 'Short-term gain; the one-year mark is still a way off.' },
  'st-loss': { label: 'ST loss',    tone: 'good', hint: 'Loss booked short-term.' },
  'st-loss-expiring': { label: 'sell by', tone: 'act', hint: 'Short-term loss, but a lot turns long-term soon. Book it before then.' },
  'lt-loss': { label: 'LT loss',    tone: 'warn', hint: 'Loss booked long-term.' },
  unknown:  { label: 'no lots',     tone: 'muted', hint: 'No cost basis left to match this against.' },
  none:     { label: '—',           tone: 'muted', hint: '' },
};

const LONG_TERM_MS = 86400000;

function longTermFrom(acquiredAt) {
  const date = new Date(acquiredAt);
  date.setFullYear(date.getFullYear() + 1);
  date.setDate(date.getDate() + 1);
  return date;
}

/**
 * Walks the ladder consuming lots HIFO and splits what each order books into
 * short- and long-term. Mirrors classifyLadderTax() in src/pnl.js.
 */
function classifyLadderTax(orders) {
  const asOf = new Date();
  const pool = (state.data.lots ?? []).map((lot) => ({ ...lot }));

  return orders.map((order) => {
    const netPerUnit = order.limitPrice * (1 - state.feeRate);
    let left = order.size;
    let shortGain = 0;
    let longGain = 0;
    let shortQty = 0;
    let longQty = 0;
    let crossover = null;
    let firstCrossover = null;
    let ageWeighted = 0;
    let oldestAge = null;
    let newestAge = null;

    while (left > EPS && pool.length > 0) {
      let idx = 0;
      for (let i = 1; i < pool.length; i += 1) {
        if (pool[i].price > pool[idx].price) idx = i;
      }
      const lot = pool[idx];
      const take = Math.min(left, lot.qty);
      const gain = take * (netPerUnit - lot.price);
      const turns = lot.longTermOn ? new Date(lot.longTermOn) : longTermFrom(lot.acquiredAt);

      const age = (asOf - new Date(lot.acquiredAt)) / LONG_TERM_MS;
      ageWeighted += take * age;
      if (oldestAge === null || age > oldestAge) oldestAge = age;
      if (newestAge === null || age < newestAge) newestAge = age;

      if (asOf >= turns) {
        longGain += gain;
        longQty += take;
      } else {
        shortGain += gain;
        shortQty += take;
        if (!crossover || turns > crossover) crossover = turns;
        if (!firstCrossover || turns < firstCrossover) firstCrossover = turns;
      }

      lot.qty -= take;
      left -= take;
      if (lot.qty <= EPS) pool.splice(idx, 1);
    }

    const gain = shortGain + longGain;
    const matchedQty = shortQty + longQty;
    const avgAgeDays = matchedQty > EPS ? ageWeighted / matchedQty : null;
    const daysToLongTerm = crossover ? Math.max(0, Math.ceil((crossover - asOf) / LONG_TERM_MS)) : 0;
    const daysToFirstLongTerm = firstCrossover ? Math.max(0, Math.ceil((firstCrossover - asOf) / LONG_TERM_MS)) : 0;
    const uncoveredQty = left > EPS ? left : 0;

    let signal = 'none';
    if (uncoveredQty > EPS && shortQty + longQty <= EPS) signal = 'unknown';
    else if (gain > 0) signal = shortQty <= EPS ? 'lt-gain' : daysToLongTerm <= NEAR_LONG_TERM_DAYS ? 'wait' : 'st-gain';
    else if (gain < 0) {
      if (shortQty <= EPS) signal = 'lt-loss';
      else signal = daysToFirstLongTerm <= NEAR_LONG_TERM_DAYS ? 'st-loss-expiring' : 'st-loss';
    }

    return {
      gain, shortGain, longGain, shortQty, longQty, uncoveredQty,
      avgAgeDays, oldestAgeDays: oldestAge, newestAgeDays: newestAge,
      daysToLongTerm, daysToFirstLongTerm, signal,
    };
  });
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

/**
 * A rung only fills because the price got there, so at that moment the coins
 * still held are worth that price too. Each row is therefore the realized part
 * plus the remainder marked at this rung's price. Mirrors buildLadder() in
 * src/pnl.js; see docs/sell-planner.md.
 */
function buildLadder(orders) {
  const { currentPrice, heldQty, lifetimePL } = state.data;
  let soldQty = 0;
  let proceeds = 0;
  let realizedDelta = 0;

  return orders.map((order, index) => {
    const gross = order.size * order.limitPrice;
    const fee = gross * state.feeRate;

    soldQty += order.size;
    proceeds += gross - fee;
    realizedDelta += (order.limitPrice - currentPrice) * order.size - fee;

    const remainingQty = heldQty - soldQty;
    const markToRung = (order.limitPrice - currentPrice) * Math.max(remainingQty, 0);

    return {
      ...order,
      step: index + 1,
      cumulativeSold: soldQty,
      net: gross - fee,
      vsSpotPercent: currentPrice > 0 ? ((order.limitPrice - currentPrice) / currentPrice) * 100 : 0,
      cumulativeProceeds: proceeds,
      remainingQty,
      markToRung,
      oversold: soldQty > heldQty + 1e-12,
      lifetimePL: lifetimePL + realizedDelta + markToRung,
    };
  });
}

/**
 * The closing row: everything the ladder leaves behind, sold at the last
 * rung's price. Mirrors projectFullExit() in src/pnl.js.
 */
function projectFullExit(rows) {
  const { currentPrice, heldQty } = state.data;
  const last = rows.at(-1);
  if (!last) return null;

  const size = heldQty - last.cumulativeSold;
  if (size <= 1e-12) return null;

  const gross = size * last.limitPrice;
  const fee = gross * state.feeRate;

  return {
    size,
    limitPrice: last.limitPrice,
    net: gross - fee,
    vsSpotPercent: currentPrice > 0 ? ((last.limitPrice - currentPrice) / currentPrice) * 100 : 0,
    // The last rung already values the remainder at this price, so selling it
    // only costs the fee - it moves P/L from unrealized to banked.
    lifetimePL: last.lifetimePL - fee,
  };
}

function renderFullExit(exit) {
  const foot = el('ladder-foot');
  foot.replaceChildren();
  if (!exit) return;

  const cur = state.data.quoteCurrency;
  const tr = document.createElement('tr');
  tr.className = 'full-exit';

  const cell = (text, className = '') => {
    const td = document.createElement('td');
    td.className = className;
    td.textContent = text;
    return td;
  };

  const label = document.createElement('td');
  label.className = 'exit-label';
  label.textContent = 'Sell the rest';
  const note = document.createElement('span');
  note.className = 'sub';
  note.textContent = `banked at ${price(exit.limitPrice, cur)}, less fees`;
  label.append(note);

  tr.append(
    label,
    cell(qty(exit.size), 'num'),
    cell(price(exit.limitPrice, cur), 'num'),
    cell(`${exit.vsSpotPercent >= 0 ? '+' : ''}${exit.vsSpotPercent.toFixed(1)}%`, `num ${signClass(exit.vsSpotPercent)}`),
    cell(money(exit.net, cur), 'num'),
    cell('0', 'num muted'),
    cell(exit.tax?.avgAgeDays != null ? `${Math.round(exit.tax.avgAgeDays)}d` : '—', 'num muted'),
    cell(exit.tax ? signedMoney(exit.tax.gain, cur) : '—', `num ${exit.tax ? signClass(exit.tax.gain) : 'muted'}`),
    cell(''),
    cell(signedMoney(exit.lifetimePL, cur), `num strong ${signClass(exit.lifetimePL)}`),
    cell(''),
  );

  foot.append(tr);
}

function allOrders() {
  return [...state.data.sellOrders, ...state.whatIfs].sort((a, b) => a.limitPrice - b.limitPrice);
}

function renderSummary() {
  const d = state.data;
  const cur = d.quoteCurrency;

  el('title').textContent = `${d.currency} sell planner`;
  document.title = `${d.currency} sell planner — PlenCoin`;
  el('mode-badge').hidden = !d.mock;
  el('updated').textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString()}`;

  const lifetime = el('lifetime-pl');
  lifetime.textContent = signedMoney(d.lifetimePL, cur);
  lifetime.className = `value ${signClass(d.lifetimePL)}`;
  el('lifetime-note').textContent = d.reconciled ? 'realized + unrealized' : 'approximate basis';

  const realized = el('realized-pl');
  realized.textContent = signedMoney(d.realizedPL, cur);
  realized.className = `value ${signClass(d.realizedPL)}`;

  const unrealized = el('unrealized-pl');
  unrealized.textContent = signedMoney(d.unrealizedPL, cur);
  unrealized.className = `value ${signClass(d.unrealizedPL)}`;
  el('unrealized-note').textContent = d.costBasis === null ? '' : `basis ${money(d.costBasis, cur)}`;

  el('held-qty').textContent = qty(d.heldQty);
  el('held-note').textContent = `${money(d.value, cur)}${d.staked > 0 ? ` · ${qty(d.staked)} staked` : ''}`;

  el('longterm-qty').textContent = qty(d.longTermQty ?? 0);
  el('longterm-note').textContent = d.heldQty > 0
    ? `${((d.longTermShare ?? 0) * 100).toFixed(0)}% of position · ${d.lotCount ?? 0} lots`
    : '';

  el('avg-entry').textContent = d.avgEntry === null ? '—' : price(d.avgEntry, cur);
  el('spot-note').textContent = `spot ${price(d.currentPrice, cur)}`;

  el('explainer').textContent =
    `Each row is the moment the price reaches that limit: every order at or below it has filled, ` +
    `and the coins still held are valued at that same price. ` +
    `Lifetime P/L starts at ${signedMoney(d.lifetimePL, cur)} at today's spot of ${price(d.currentPrice, cur)}` +
    (d.ledgerEntries > 0 ? `, rebuilt from ${d.ledgerEntries} ledger entries on a HIFO cost basis` : '') +
    `.`;
}

function renderLadder() {
  const d = state.data;
  const cur = d.quoteCurrency;
  const ordered = allOrders();
  const rows = buildLadder(ordered);

  // The closing row consumes whatever lots the ladder leaves, so it has to be
  // part of the same HIFO walk rather than classified on its own.
  const exit = projectFullExit(rows);
  const taxOrders = exit ? [...ordered, { size: exit.size, limitPrice: exit.limitPrice }] : ordered;
  const tax = classifyLadderTax(taxOrders);
  rows.forEach((row, i) => { row.tax = tax[i]; });
  if (exit) exit.tax = tax.at(-1);
  const body = el('ladder-body');
  body.replaceChildren();

  const whatIfCount = state.whatIfs.length;
  el('ladder-summary').textContent = rows.length === 0
    ? 'no open sell orders'
    : `${d.sellOrders.length} open order${d.sellOrders.length === 1 ? '' : 's'}` +
      (whatIfCount > 0 ? ` · ${whatIfCount} what-if` : '') +
      (d.buyOrderCount > 0 ? ` · ${d.buyOrderCount} open buy${d.buyOrderCount === 1 ? '' : 's'} ignored` : '');

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    const td = document.createElement('td');
    td.colSpan = 11;
    td.textContent = `No open ${d.currency} sell orders. Add a what-if row below to plan one.`;
    tr.append(td);
    body.append(tr);
    el('ladder-foot').replaceChildren();
    return;
  }

  const cell = (text, className = '') => {
    const td = document.createElement('td');
    td.className = className;
    td.textContent = text;
    return td;
  };

  for (const row of rows) {
    const tr = document.createElement('tr');
    if (row.source === 'whatif') tr.className = 'whatif-row';

    const step = document.createElement('td');
    step.textContent = String(row.step);
    if (row.source === 'whatif') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'what-if';
      step.append(' ', tag);
    }

    tr.append(
      step,
      cell(qty(row.size), 'num'),
      cell(price(row.limitPrice, cur), 'num'),
      cell(`${row.vsSpotPercent >= 0 ? '+' : ''}${row.vsSpotPercent.toFixed(1)}%`, `num ${signClass(row.vsSpotPercent)}`),
      cell(money(row.net, cur), 'num'),
      cell(qty(row.remainingQty), `num ${row.oversold ? 'down' : ''}`),
    );

    // How old the coins being sold actually are.
    const age = document.createElement('td');
    age.className = 'num muted';
    if (row.tax.avgAgeDays === null) {
      age.textContent = '—';
    } else {
      age.textContent = `${Math.round(row.tax.avgAgeDays)}d`;
      const spread = Math.round(row.tax.oldestAgeDays) - Math.round(row.tax.newestAgeDays);
      age.title = spread > 0
        ? `Quantity-weighted. Oldest ${Math.round(row.tax.oldestAgeDays)}d, newest ${Math.round(row.tax.newestAgeDays)}d.`
        : 'All from one lot.';
      if (spread > 0) age.classList.add('has-tip');
    }
    tr.append(age);

    // What this order actually books, and under which holding period.
    const books = document.createElement('td');
    books.className = `num ${signClass(row.tax.gain)}`;
    books.textContent = signedMoney(row.tax.gain, cur);
    if (row.tax.shortQty > EPS && row.tax.longQty > EPS) {
      const split = document.createElement('span');
      split.className = 'sub';
      split.textContent = `ST ${signedMoney(row.tax.shortGain, cur)} · LT ${signedMoney(row.tax.longGain, cur)}`;
      books.append(split);
    }
    tr.append(books);

    const meta = SIGNALS[row.tax.signal] ?? SIGNALS.none;
    const term = document.createElement('td');
    const tag = document.createElement('span');
    tag.className = `signal ${meta.tone}`;
    if (row.tax.signal === 'wait') {
      tag.textContent = `hold ${row.tax.daysToLongTerm}d`;
      tag.title = `${meta.hint} Long-term in ${row.tax.daysToLongTerm} day${row.tax.daysToLongTerm === 1 ? '' : 's'}.`;
    } else if (row.tax.signal === 'st-loss-expiring') {
      tag.textContent = `sell by ${row.tax.daysToFirstLongTerm}d`;
      tag.title = `${meta.hint} First lot turns long-term in ${row.tax.daysToFirstLongTerm} day${row.tax.daysToFirstLongTerm === 1 ? '' : 's'}.`;
    } else {
      tag.textContent = meta.label;
      tag.title = meta.hint;
    }
    term.append(tag);
    tr.append(term);

    const pl = cell(signedMoney(row.lifetimePL, cur), `num strong ${signClass(row.lifetimePL)}`);
    tr.append(pl);

    const actions = document.createElement('td');
    if (row.source === 'whatif') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link-button';
      remove.textContent = 'remove';
      remove.addEventListener('click', () => {
        state.whatIfs = state.whatIfs.filter((w) => w.orderId !== row.orderId);
        renderLadder();
      });
      actions.append(remove);
    }
    tr.append(actions);

    body.append(tr);
  }

  renderFullExit(exit);

  const last = rows.at(-1);
  if (last.oversold) {
    showBanner(
      'Ladder oversells the position',
      `<div>These orders total more ${d.currency} than you hold, so the later rows assume a position you do not have.</div>`,
      'warn',
    );
  } else if (d.warnings.length > 0) {
    showBanner('Heads up', d.warnings.map((w) => `<div>${w}</div>`).join(''), 'warn');
  } else {
    el('banner').hidden = true;
  }
}

function render() {
  renderSummary();
  renderLadder();
}

async function load({ refresh = false } = {}) {
  const button = el('refresh');
  button.disabled = true;

  try {
    const response = await fetch(`/api/asset?symbol=${encodeURIComponent(symbol)}${refresh ? '&refresh=1' : ''}`);
    const payload = await readJson(response);

    if (!response.ok) {
      const hint = payload.hint ? `<div class="sub">${payload.hint}</div>` : '';
      showBanner(`Could not load ${symbol || 'the asset'}`, `<div>${payload.error ?? response.statusText}</div>${hint}`);
      el('ladder-body').replaceChildren();
      return;
    }

    state.data = payload;
    if (state.feeRate === 0 && payload.feeRate > 0) {
      state.feeRate = payload.feeRate;
      el('fee-rate').value = (payload.feeRate * 100).toFixed(2);
    }
    render();
  } catch (error) {
    showBanner('Could not reach the server', `<div>${error.message}</div>`);
  } finally {
    button.disabled = false;
  }
}

el('refresh').addEventListener('click', () => load({ refresh: true }));

el('fee-rate').addEventListener('input', (event) => {
  const percent = Number.parseFloat(event.target.value);
  state.feeRate = Number.isFinite(percent) && percent >= 0 ? percent / 100 : 0;
  if (state.data) renderLadder();
});

el('whatif-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const size = Number.parseFloat(el('whatif-size').value);
  const limitPrice = Number.parseFloat(el('whatif-price').value);
  if (!(size > 0) || !(limitPrice > 0)) return;

  state.whatIfs.push({
    orderId: `whatif-${Date.now()}-${state.whatIfs.length}`,
    size,
    limitPrice,
    kind: 'limit',
    source: 'whatif',
  });
  el('whatif-size').value = '';
  el('whatif-price').value = '';
  renderLadder();
});

el('clear-whatif').addEventListener('click', () => {
  state.whatIfs = [];
  renderLadder();
});

if (!symbol) {
  showBanner('No asset selected', '<div>Open this page from an asset row on the <a href="/">portfolio</a>.</div>');
} else {
  load();
}
