const el = (id) => document.getElementById(id);
const state = { data: null, loading: false };

const DAY_MS = 86400_000;

const money = (value, currency = 'USD') =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

const signedMoney = (value) => `${value >= 0 ? '+' : '−'}${money(Math.abs(value))}`;

const qty = (value) => new Intl.NumberFormat(undefined, { maximumSignificantDigits: 6 }).format(value);

/** Sub-dollar limits need more than 2 decimals or $0.115 reads as $0.12. */
function price(value, currency = 'USD') {
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits }).format(value);
}

const signClass = (value) => (value > 0 ? 'up' : value < 0 ? 'down' : 'muted');

/** Derived from the stored date, so a digest from days ago still counts down right. */
const daysLeft = (deadline) => Math.max(0, Math.ceil((new Date(deadline) - Date.now()) / DAY_MS));

const tierOf = (days) => (days <= 7 ? 'urgent' : days <= 30 ? 'soon' : 'watch');

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: `Server returned ${response.status} ${response.statusText || ''}`.trim(),
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

function relativeAge(iso) {
  const minutes = Math.round((Date.now() - new Date(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function render() {
  const d = state.data;
  el('mode-badge').hidden = !d.mock;

  el('updated').textContent = d.scanning
    ? 'Scanning…'
    : d.generatedAt
      ? `Scanned ${relativeAge(d.generatedAt)}`
      : 'Not scanned yet';

  const rows = (d.signals ?? []).map((s) => ({ ...s, days: daysLeft(s.deadline) }));
  rows.sort((a, b) => a.days - b.days || Math.abs(b.atStake) - Math.abs(a.atStake));

  const byTier = (tier) => rows.filter((r) => tierOf(r.days) === tier).length;
  el('count-urgent').textContent = String(byTier('urgent'));
  el('count-soon').textContent = String(byTier('soon'));
  el('count-watch').textContent = String(byTier('watch'));

  const next = rows[0];
  el('next-deadline').textContent = next ? `${next.days}d` : '—';
  el('next-note').textContent = next
    ? `${next.currency} · ${next.signal === 'wait' ? 'hold for long-term' : 'book before it turns'}`
    : 'nothing pending';

  const body = el('signals-body');
  body.replaceChildren();

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = d.scanning
      ? 'Scanning your holdings…'
      : 'No orders are near a holding-period change.';
    tr.append(td);
    body.append(tr);
  }

  const cell = (text, className = '') => {
    const td = document.createElement('td');
    td.className = className;
    td.textContent = text;
    return td;
  };

  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = `tier-${tierOf(row.days)}`;

    const when = document.createElement('td');
    when.className = 'deadline';
    when.textContent = `${row.days}d`;
    const date = document.createElement('span');
    date.className = 'sub';
    date.textContent = new Date(row.deadline).toLocaleDateString();
    when.append(date);

    const asset = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'asset-link ticker';
    link.href = `/asset.html?symbol=${encodeURIComponent(row.currency)}`;
    link.textContent = row.currency;
    asset.append(link);

    const action = document.createElement('td');
    const tag = document.createElement('span');
    const isLoss = row.signal === 'st-loss-expiring';
    tag.className = `signal ${isLoss ? 'act' : 'good'}`;
    tag.textContent = isLoss ? `sell by ${row.days}d` : `hold ${row.days}d`;
    tag.title = isLoss
      ? 'Short-term loss. It stops being short-term after this date.'
      : 'Short-term gain. It becomes long-term after this date.';
    action.append(tag);

    const order = document.createElement('td');
    order.className = 'num';
    order.textContent = `${qty(row.size)} @ ${price(row.limitPrice)}`;
    const step = document.createElement('span');
    step.className = 'sub';
    step.textContent = `rung ${row.step} · ${money(row.notional)}`;
    order.append(step);

    // What it would cost to get there: HIFO forces everything ahead to sell first.
    const reach = document.createElement('td');
    reach.className = 'sub';
    reach.textContent = row.aheadQty > 0
      ? `sell ${qty(row.aheadQty)} first, booking ${signedMoney(row.aheadGain)}` +
        (row.aheadLongGain !== 0 ? ` (${signedMoney(row.aheadLongGain)} long-term)` : '')
      : 'nothing ahead of it';

    tr.append(
      when,
      asset,
      action,
      order,
      cell(signedMoney(row.gain), `num ${signClass(row.gain)}`),
      cell(signedMoney(row.atStake), `num strong ${signClass(row.atStake)}`),
      reach,
    );
    body.append(tr);
  }

  if (d.warnings?.length > 0) {
    showBanner('Some assets could not be scanned', d.warnings.map((w) => `<div>${w}</div>`).join(''), 'warn');
  } else {
    el('banner').hidden = true;
  }
}

async function load({ rescan = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const button = el('rescan');
  button.disabled = true;
  if (rescan) button.textContent = 'Scanning…';

  try {
    const response = await fetch(`/api/signals${rescan ? '?rescan=1' : ''}`);
    const payload = await readJson(response);

    if (!response.ok) {
      const hint = payload.hint ? `<div class="sub">${payload.hint}</div>` : '';
      showBanner('Could not load signals', `<div>${payload.error ?? response.statusText}</div>${hint}`);
      return;
    }

    state.data = payload;
    render();

    // The boot scan may still be running; check back until it lands.
    if (payload.scanning) setTimeout(() => load(), 5000);
  } catch (error) {
    showBanner('Could not reach the server', `<div>${error.message}</div>`);
  } finally {
    state.loading = false;
    button.disabled = false;
    button.textContent = 'Rescan';
  }
}

el('rescan').addEventListener('click', () => load({ rescan: true }));
load();
