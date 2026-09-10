import { formatAmount, capturedStatementLines, forecastSummary } from './presentation.js?v=20260910-audit2';
let activeController;
let refreshTimer;

export function disposeOperations() {
  activeController?.abort();
  clearTimeout(refreshTimer);
}

export async function renderOperations(ctx) {
  const { content, api, state, escapeHtml: esc, money, decimal, fmtDateTime } = ctx;
  const controller = new AbortController();
  activeController = controller;
  const currentRoute = state.route;
  const connection = state.meta?.operations;
  const label = realm => realm === 'entrepreneurs' ? 'Entrepreneurs' : 'Magnates';
  const symbol = String(state.meta?.settings?.['display.currencySymbol'] || '$');
  const cash = value => esc(formatAmount(value, symbol, 2));
  const unitPrice = value => esc(formatAmount(value, symbol, 4));
  const number = value => value == null ? '—' : esc(decimal(value));
  const when = value => value ? esc(fmtDateTime(value)) : 'Not captured';
  const pill = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;
  const table = (headers, rows, empty = 'No captured records yet.') => rows.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="ops-empty">${esc(empty)}</div>`;
  const card = (title, body, note = '') => `<section class="card"><div class="card-header"><div><h3>${esc(title)}</h3>${note ? `<p>${esc(note)}</p>` : ''}</div></div>${body}</section>`;
  const metric = (title, value, note) => `<div class="kpi"><div class="kpi-label">${esc(title)}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${esc(note)}</div></div>`;
  const warning = text => `<div class="callout warn">${esc(text)}</div>`;
  const list = value => Array.isArray(value) ? value : [];

  if (!connection?.enabled || state.realm !== connection.realm) {
    content.innerHTML = `<div class="ops-empty"><h2>${connection?.enabled ? 'No live connection for this realm' : 'Live operations are not connected'}</h2><p>${connection?.enabled ? `Switch to ${label(connection.realm)} to view the connected company. Imported financial statements remain separate for each realm.` : 'Configure the capture service to see current buildings, warehouse, and strategy.'}</p><a class="btn" href="#/dashboard">Open financial overview</a></div>`;
    return;
  }

  content.innerHTML = `<div class="ops-toolbar"><div><span class="ops-eyebrow">${label(state.realm)} · Operations</span><p id="opsUpdated" aria-live="polite">Loading latest capture…</p></div><div class="ops-actions"><a class="btn" href="${esc(connection.consolePath)}">Original console ↗</a><button class="btn primary" id="opsRefresh">Refresh</button></div></div><div id="opsError" role="status"></div><div id="opsBody"><div class="loading-card">Loading ${esc(currentRoute === 'strategy' ? 'strategy' : 'company data')}…</div></div>`;
  const body = content.querySelector('#opsBody');
  const errorBox = content.querySelector('#opsError');
  const updated = content.querySelector('#opsUpdated');
  const button = content.querySelector('#opsRefresh');
  let busy = false;
  let loaded = false;
  const get = endpoint => api(`/api/operations/${endpoint}`, { signal: controller.signal });

  function overview(snapshot, service, live) {
    const buildings = list(snapshot.buildings);
    const warehouses = list(snapshot.warehouse?.rows);
    const status = snapshot.captured_at ? (snapshot.live ? pill('Recent capture', 'good') : pill('Stale capture', 'warn')) : pill('No capture', 'warn');
    const freshness = `${status}<span>Captured ${when(snapshot.captured_at)}</span>${live ? pill(live.active ? 'Agent session active' : 'No active session', live.active ? 'good' : '') : ''}`;
    const buildingCards = buildings.map(b => {
      const progress = typeof b.progress === 'number' ? Math.max(0, Math.min(100, b.progress * 100)) : null;
      return `<article class="ops-building"><div class="ops-building-head"><div><h3>${esc(b.name || b.raw_name || 'Building')}</h3><p>Level ${esc(b.level ?? '—')} · ${esc(b.product || b.likely_product || 'No product recorded')}</p></div>${pill(b.is_idle ? 'Idle' : b.status || 'Active', b.is_idle ? 'warn' : 'good')}</div>${progress === null ? '' : `<progress max="100" value="${progress}" aria-label="${esc(b.name || 'Building')} progress">${Math.round(progress)}%</progress>`}<div class="ops-building-meta"><span>${esc(b.countdown || (b.is_idle ? 'Ready for production' : 'Timing unavailable'))}</span><span>${cash(b.profit_hr)}/hr potential</span></div><div class="ops-building-meta"><span>Batch ${number(b.active_qty)}</span><span>Current stock ${number(b.current_stock)}</span></div></article>`;
    }).join('');
    const health = service ? `<div class="ops-service">${pill(service.agent_enabled ? 'Agent enabled' : 'Agent disabled')}${pill(service.actions_enabled ? 'Actions enabled' : 'Actions disabled')}<span>Last capture cycle ${service.capture_state?.last_run ? when(new Date(service.capture_state.last_run * 1000).toISOString()) : 'unknown'}</span></div>` : warning('Capture service status is temporarily unavailable.');
    const statements = ['income_statement', 'balance_sheet', 'cashflow_statement'].map(key => {
      const statement = snapshot[key] || {};
      const title = { income_statement: 'Captured income statement', balance_sheet: 'Captured balance sheet', cashflow_statement: 'Captured cash flow' }[key];
      return card(title, table(['Line', 'Captured value'], capturedStatementLines(statement.rows, value => formatAmount(value, symbol, 2)).map(row => row.map(esc)), 'No statement captured yet.'), statement.period || statement.as_of || 'Latest captured statement; separate from CSV ledger');
    }).join('');
    return `<div class="ops-freshness">${freshness}</div>${snapshot.captured_at && !snapshot.live ? warning('These figures are from an older capture. Check the original console for capture status before acting.') : ''}<div class="grid kpi-grid ops-kpis">${metric('Cash', cash(snapshot.cash), 'Latest captured balance')}${metric('Company value', cash(snapshot.company?.value), `Captured ${snapshot.company?.at ? fmtDateTime(snapshot.company.at) : 'at an unknown time'}`)}${metric('Potential profit / hr', cash(snapshot.profit_hr), 'Steady-state estimate, including idle buildings')}${metric('Warehouse at market', cash(snapshot.warehouse?.totals?.value_at_market), 'Current captured inventory')}${metric('Idle buildings', snapshot.captured_at ? number(snapshot.idle_buildings) : '—', `${buildings.length} buildings captured`)}${metric('Company level', number(snapshot.level), snapshot.xp_pct == null ? 'Progress unavailable' : `${snapshot.xp_pct}% to next level`)}</div>${health}<div class="ops-columns">${card('Buildings', `<div class="ops-buildings">${buildingCards || '<div class="ops-empty">No buildings captured yet.</div>'}</div>`)}<div class="ops-stack">${card('Warehouse', table(['Product', 'Quantity', 'At cost', 'At market'], warehouses.map(row => [esc(row.name), number(row.quantity), cash(row.value_at_cost), cash(row.value_at_market)])))}${card('Pending exchange sales', table(['Product', 'Quantity', 'Price', 'Value'], list(snapshot.pending_sales).map(row => [esc(row.name), number(row.qty), unitPrice(row.price), cash(row.value)])))}</div></div><details class="ops-statements"><summary>Latest captured financial statements</summary><p>Captured statements show the latest game view. Import CSV exports for the ledger’s historical reports and reconciliation.</p><div class="ops-stack">${statements}</div></details>`;
  }

  function strategy(data) {
    const forecast = data.forecast || {};
    const actual = data.actual || {};
    const coverage = forecastSummary(data);
    const historicalWindow = actual.start_at && actual.end_at ? `${fmtDateTime(actual.start_at)} – ${fmtDateTime(actual.end_at)}` : 'Observation window unavailable';
    const recommendations = list(data.recommendations);
    const recs = recommendations.map(rec => `<article class="ops-recommendation"><div>${pill(rec.priority || 'Recommendation', ['high', 'critical'].includes(rec.priority) ? 'warn' : '')}<h3>${esc(String(rec.action || '').replaceAll('_', ' '))} · ${esc(rec.target || '')}</h3></div><p>${esc(rec.reason || '')}</p></article>`).join('');
    return `<div class="grid kpi-grid ops-strategy-kpis">${metric('Forecast cash change', coverage.available ? cash(forecast.expected_cash_delta) : '—', coverage.available ? `Over ${forecast.horizon_hours ?? '—'} hours; projected` : `${coverage.modeledCount} of ${coverage.actionCount} recommended actions have a cash forecast`)}${metric('Historical cash change', cash(actual.cash_delta), historicalWindow)}${metric('Recommended actions', number(coverage.actionCount), `Current plan ${data.plan_id ?? 'not recorded'}`)}${metric('Forecast horizon', number(forecast.horizon_hours), 'Hours ahead; separate from historical cash')}</div><div class="ops-columns">${card('Recommended actions', `<div class="ops-recommendations">${recs || '<div class="ops-empty">No recommendations available.</div>'}</div>`, 'Use the original console to manage execution.')}${card('Recorded plan comparisons', table(['Plan', 'Created', 'Observed hours', 'Company cash change', 'Linked action events', 'Status'], list(data.accuracy).map(row => [esc(row.plan_id), when(row.created_at), number(row.observed_hours), cash(row.cash_delta), number(row.matched_action_events), pill(row.status || 'Unknown')])), 'Backend comparisons use total company cash, which can include unrelated actions. They do not measure the current plan’s performance.')}</div>${card('Strategy report', `<pre class="ops-report">${esc(data.report || 'No report available.')}</pre>`)}`;
  }

  function activity(events, service, live) {
    return `${service ? `<div class="ops-service">${pill(service.agent_enabled ? 'Agent enabled' : 'Agent disabled')}${pill(service.actions_enabled ? 'Actions enabled' : 'Actions disabled')}${live ? pill(live.active ? 'Live session active' : 'No live session') : ''}</div>` : ''}${card('Recent activity', table(['Time', 'Event', 'Status', 'Message'], list(events).slice().sort((a, b) => String(b.time).localeCompare(String(a.time))).map(row => [when(row.time), esc(row.event), pill(row.status || 'Recorded'), `<span class="ops-event-message">${esc(row.message)}</span>`])), 'Latest 100 events from the capture and strategy service')}`;
  }

  async function refresh() {
    if (busy || controller.signal.aborted) return;
    busy = true;
    button.disabled = true;
    clearTimeout(refreshTimer);
    try {
      let html;
      if (currentRoute === 'live-operations' || currentRoute === 'activity') {
        const [primary, service, live] = await Promise.allSettled([get(currentRoute === 'activity' ? 'events?limit=100' : 'snapshot'), get('state'), get('live')]);
        if (primary.status === 'rejected') throw primary.reason;
        const serviceData = service.status === 'fulfilled' ? service.value : null;
        const liveData = live.status === 'fulfilled' ? live.value : null;
        html = currentRoute === 'activity' ? activity(primary.value, serviceData, liveData) : overview(primary.value, serviceData, liveData);
      } else if (currentRoute === 'strategy') {
        html = strategy(await get('strategy'));
      } else {
        const rows = list(await get('ticker'));
        html = card('Market prices', `<div class="ops-market-filter"><label for="marketSearch">Find a product</label><input class="input" id="marketSearch" type="search" placeholder="Search captured products"></div><div id="marketRows">${table(['Product', 'Price', 'Captured', 'Source'], rows.map(row => [esc(row.product_name || row.product_id), unitPrice(row.price), when(row.captured_at), esc(row.source || 'Capture')]))}</div>`, 'Latest stored quotes. Check the capture time before using a price.');
      }
      if (controller.signal.aborted) return;
      const statementsOpen = content.querySelector('.ops-statements')?.open || false;
      const searchValue = content.querySelector('#marketSearch')?.value || '';
      body.innerHTML = html;
      const statements = content.querySelector('.ops-statements');
      if (statements) statements.open = statementsOpen;
      errorBox.innerHTML = '';
      updated.textContent = `View refreshed ${fmtDateTime(new Date().toISOString())} · every 30 seconds`;
      loaded = true;
      const search = content.querySelector('#marketSearch');
      if (search) {
        search.value = searchValue;
        search.oninput = () => content.querySelectorAll('#marketRows tbody tr').forEach(row => { row.hidden = !row.cells[0].textContent.toLowerCase().includes(search.value.toLowerCase()); });
        search.oninput();
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      errorBox.innerHTML = warning(`${error.message}${loaded ? ' Previously loaded data is shown below.' : ''}`);
      if (!loaded) body.innerHTML = '<div class="ops-empty">Use Refresh to retry, or open the financial overview to work with imported data.</div>';
      updated.textContent = 'Refresh failed';
    } finally {
      busy = false;
      button.disabled = false;
      if (!controller.signal.aborted) refreshTimer = setTimeout(() => {
        if (!document.hidden) void refresh();
        else refreshTimer = setTimeout(refresh, 30_000);
      }, 30_000);
    }
  }

  button.onclick = refresh;
  await refresh();
}
