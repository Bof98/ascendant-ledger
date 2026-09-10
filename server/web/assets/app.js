import { formatAmount, utcDateRange } from './presentation.js?v=20260910-sync1';
import { renderOperations, disposeOperations } from './operations.js?v=20260910-sync1';
import { scopedApiUrl } from './urls.js';
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const content = $('#content');
let pageController = new AbortController();
const OFFICIAL_ATTRIBUTION = 'Created by NullBot | Copyright 2026';
const state = {
  route: location.hash.replace(/^#\/?/, '') || 'dashboard',
  meta: null,
  realm: localStorage.getItem('ledger-realm')||'magnates',
  dates: { preset:'all', from:'', to:'' },
  pendingFiles: [],
  importPreview: null,
  txPage: 1,
  txFilters: {},
  auth: null,
  rawPage: 1,
  rawColumns: {},
  rawFilters: {},
};

const navGroups = [
  ['Overview', [['live-operations','◉','Live overview'],['strategy','◇','Strategy'],['activity','◷','Activity'],['live-market','↗','Live market'],['dashboard','▦','Financial overview']]],
  ['Financials', [['income','≋','Income Statement'],['balance','◫','Balance Sheet'],['cashflow','⇄','Cash Flow']]],
  ['Operations', [['transactions','☷','Transactions'],['products','◆','Products'],['buildings','▤','Buildings'],['market','↗','Market / Exchange'],['fees','%','Fees']]],
  ['Data', [['import','⇧','Import CSV'],['history','◷','Import History'],['raw','⌗','Raw Data'],['quality','✓','Data Quality']]],
  ['System', [['settings','⚙','Settings']]],
];
const routeInfo = {
  'live-operations':['Live overview','Latest captured company state'], strategy:['Strategy','Recommendations and forecast outcomes'], activity:['Activity','Capture and agent activity'], 'live-market':['Live market','Latest captured market prices'],
  dashboard:['Dashboard','Financial overview and company health'], income:['Income Statement','Official Sim Companies performance'], balance:['Balance Sheet','Assets, liabilities, and equity'], cashflow:['Cash Flow','Cash movement and operating flows'],
  transactions:['Transactions','Operational Account History ledger'], products:['Products','Product-level operational analytics'], buildings:['Buildings','Building activity and attribution'], market:['Market / Exchange','Purchases, sales, counterparties, and known profit'], fees:['Fees','Fee analysis by accounting source'], import:['Import CSV','Upload and validate Sim Companies exports'], history:['Import History','Import batches, provenance, and rollback'], raw:['Raw Data','Advanced database inspection and CSV export'], quality:['Data Quality','Reconciliation and validation findings'], settings:['Settings','Company, display, and lookup mappings'],
};

function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function money(v, signed=false){const value=formatAmount(v, String(state.meta?.settings?.['display.currencySymbol']||'$'), 0);return escapeHtml(signed&&Number(v)>0?'+'+value:value);}

function decimal(v,d=2){return v===null||v===undefined||Number.isNaN(Number(v))?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:d});}
function pct(v){return v===null||v===undefined?'—':`${(Number(v)*100).toFixed(1)}%`;}
function clsMoney(v){return Number(v)>0?'positive':Number(v)<0?'negative':'';}
function humanKey(k){return String(k).replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).replace(/Wip/g,'WIP').replace(/Cogs/g,'COGS');}
function displayTimeZone(){const z=state.meta?.settings?.['display.timezone'];return !z||z==='browser'||z==='local' ? undefined : String(z);}
function fmtDate(v){if(!v)return '—'; try{return new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',...(v.length===10?{timeZone:'UTC'}:displayTimeZone()?{timeZone:displayTimeZone()}:{})}).format(new Date(v.length===10?`${v}T12:00:00Z`:v));}catch{return String(v);}}
function fmtDateTime(v){if(!v)return '—'; try{return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',...(displayTimeZone()?{timeZone:displayTimeZone()}:{})}).format(new Date(v));}catch{return String(v);}}
function compact(v){const n=Number(v??0);return Math.abs(n)>=1e6?`${(n/1e6).toFixed(1)}m`:Math.abs(n)>=1e3?`${(n/1e3).toFixed(1)}k`:String(Math.round(n));}
function toast(message,type=''){const el=document.createElement('div');el.className=`toast ${type}`;el.textContent=message;$('#toastRoot').append(el);setTimeout(()=>el.remove(),4200)}
function realmLabel(realm=state.realm){return realm==='entrepreneurs'?'Entrepreneurs':'Magnates';}
function scopedUrl(url){return scopedApiUrl(url,state.realm,import.meta.url);}
function realmHref(url){return scopedUrl(url);}

function enforceAttribution(value=OFFICIAL_ATTRIBUTION){
  const text=String(value||OFFICIAL_ATTRIBUTION);
  let footer=$('#appAttribution');
  if(!footer){
    footer=document.createElement('footer');
    footer.id='appAttribution';
    footer.className='app-attribution';
    footer.setAttribute('aria-label','Creator attribution');
    document.querySelector('.main')?.appendChild(footer);
  }
  if(footer.textContent!==text) footer.textContent=text;
  return footer;
}

function guardAttribution(){
  enforceAttribution();
  const root=document.querySelector('.main');
  if(!root)return;
  const observer=new MutationObserver(()=>enforceAttribution(state.meta?.attribution?.display||OFFICIAL_ATTRIBUTION));
  observer.observe(root,{childList:true,subtree:true,characterData:true});
}

async function api(url, options={}){
  const requestUrl=scopedUrl(url);
  const signal=options.signal||(['/api/meta','/api/health','/api/auth/status'].includes(String(url).split('?')[0])?undefined:pageController.signal);
  const res=await fetch(requestUrl,{signal,headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const type=res.headers.get('content-type')||'';
  const data=type.includes('application/json')?await res.json():await res.text();
  if(!res.ok){if(res.status===401&&!String(url).startsWith('/api/auth/login'))showLogin();throw new Error(data?.error||`Request failed (${res.status})`);}
  return data;
}
function dateQuery(){const p=new URLSearchParams();if(state.dates.from)p.set('from',state.dates.from);if(state.dates.to)p.set('to',state.dates.to);const s=p.toString();return s?`?${s}`:'';}
function setLoading(text='Loading…'){content.innerHTML=`<div class="loading-card">${escapeHtml(text)}</div>`;}

function renderNav(){
  $('#nav').innerHTML=navGroups.map(([group,items])=>`<div class="nav-group"><div class="nav-group-title">${group}</div>${items.filter(([route])=>state.meta?.operations?.enabled||!['live-operations','strategy','activity','live-market'].includes(route)).map(([route,icon,label])=>`<button class="nav-item ${state.route===route?'active':''}" data-route="${route}"><span class="nav-icon">${icon}</span>${label}</button>`).join('')}</div>`).join('');
  $$('[data-route]').forEach(el=>el.onclick=()=>navigate(el.dataset.route));
}
function navigate(route){location.hash=`#/${route}`;}
async function route(){
  pageController.abort();pageController=new AbortController();
  disposeOperations();
  state.route=location.hash.replace(/^#\/?/,'')||'dashboard'; if(!routeInfo[state.route])state.route='dashboard';
  renderNav(); const info=routeInfo[state.route]; $('#pageTitle').textContent=info[0]; $('#pageSubtitle').textContent=`${info[1]} · ${realmLabel()} Realm`;
  $('#sidebar').classList.remove('open');
  if(['live-operations','strategy','activity','live-market'].includes(state.route)){
    $('#dateControl').classList.add('hidden');
    await renderOperations({ content, api, state, escapeHtml, money, decimal, fmtDateTime });
    return;
  }
  $('#dateControl').classList.toggle('hidden',['import','history','raw','quality','settings'].includes(state.route));
  const handler={dashboard:renderDashboard,income:()=>renderStatement('income'),balance:()=>renderStatement('balance'),cashflow:()=>renderStatement('cashflow'),transactions:renderTransactions,products:renderProducts,buildings:renderBuildings,market:renderMarket,fees:renderFees,import:renderImport,history:renderHistory,raw:renderRaw,quality:renderQuality,settings:renderSettings}[state.route];
  try{await handler();await renderCaptureStatus();}catch(e){if(e.name==='AbortError')return;content.innerHTML=`<div class="callout bad"><strong>Unable to load this page.</strong><br>${escapeHtml(e.message)}</div>`;}
}

async function renderCaptureStatus(){
  const signal=pageController.signal;
  let d;
  try{d=await api('/api/capture-sync');}catch(e){if(e.name==='AbortError')return;return;}
  if(signal.aborted||!d.enabled)return;
  const el=document.createElement('div');el.className=`callout ${d.error?'warn':''}`;
  el.innerHTML=`<strong>Saved capture sync</strong> · ${d.state?.lastSuccess?`Last checked ${escapeHtml(fmtDateTime(d.state.lastSuccess))}`:'Initial sync in progress'} · Checks every ${d.intervalSeconds} seconds. CSV imports are also supported.${d.error?`<br>${escapeHtml(d.error)}`:''}${d.state?.skipped?`<br>${d.state.skipped} incomplete or unsupported statement captures were skipped; previous valid reports remain available.`:''}`;
  content.prepend(el);
}

function kpi(label,value,sub='',kind='money',tone=''){
  const display=value==null?'—':kind==='money'?money(value):kind==='percent'?pct(value):Number(value??0).toLocaleString();
  return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value ${tone||((kind==='money'&&Number(value)!==0)?clsMoney(value):'')}">${display}</div><div class="kpi-sub">${sub}</div></div>`;
}
function lineChart(rows,series){
  if(!rows?.length)return '<div class="empty">No statement history in this range.</div>';
  const W=760,H=230,pad={l:44,r:12,t:18,b:28};
  const vals=rows.flatMap(r=>series.map(s=>Number(r[s.key]??0))); let min=Math.min(0,...vals),max=Math.max(0,...vals); if(max===min){max+=1;min-=1;}
  const x=i=>pad.l+(rows.length===1?(W-pad.l-pad.r)/2:i*(W-pad.l-pad.r)/(rows.length-1));
  const y=v=>pad.t+(max-v)*(H-pad.t-pad.b)/(max-min);
  const palette=['var(--accent)','var(--accent-2)','var(--warn)','var(--bad)','var(--good)'];
  let grid=''; for(let i=0;i<5;i++){const yy=pad.t+i*(H-pad.t-pad.b)/4;const val=max-i*(max-min)/4;grid+=`<line class="chart-gridline" x1="${pad.l}" x2="${W-pad.r}" y1="${yy}" y2="${yy}"/><text class="chart-label" x="2" y="${yy+3}">${escapeHtml(compact(val))}</text>`;}
  const paths=series.map((s,si)=>{const points=rows.map((r,i)=>`${x(i)},${y(Number(r[s.key]??0))}`).join(' ');const dots=rows.map((r,i)=>`<circle class="chart-dot" cx="${x(i)}" cy="${y(Number(r[s.key]??0))}" r="3.5" fill="${palette[si%palette.length]}"><title>${escapeHtml(r.date||r.snapshot_date)} — ${escapeHtml(s.label)}: ${money(r[s.key])}</title></circle>`).join('');return `<polyline class="chart-line" points="${points}" stroke="${palette[si%palette.length]}"/>${dots}`}).join('');
  const labels=rows.map((r,i)=>i===0||i===rows.length-1||rows.length<=7?`<text class="chart-label" x="${x(i)}" y="${H-5}" text-anchor="middle">${escapeHtml(String(r.date||r.snapshot_date).slice(5))}</text>`:'').join('');
  const legend=`<div class="legend">${series.map((s,i)=>`<span><i style="background:${palette[i%palette.length]}"></i>${s.label}</span>`).join('')}</div>`;
  return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}${labels}</svg></div>${legend}`;
}
function barList(obj){
  const items=Object.entries(obj||{}).filter(([,v])=>Number(v)>0).sort((a,b)=>Number(b[1])-Number(a[1])); if(!items.length)return '<div class="empty">No expense data.</div>';
  const max=Math.max(...items.map(([,v])=>Number(v)));
  return `<div class="bar-list">${items.map(([k,v])=>`<div class="bar-row"><span>${humanKey(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${Number(v)/max*100}%"></div></div><strong class="money">${money(v)}</strong></div>`).join('')}</div>`;
}

async function renderDashboard(){
  setLoading('Loading company financials…'); const d=await api(`/api/dashboard${dateQuery()}`); const k=d.kpis;
  content.innerHTML=`
    <div class="callout">Financial ledger · ${realmLabel()} · ${d.coverage?.income || d.coverage?.cashflow || d.coverage?.balance ? 'Saved statement periods in the selected UTC date range.' : 'No statements imported in this date range. Missing amounts are shown as —.'} Current operational captures are shown in <a href="#/live-operations">Live overview</a>.</div>
    <div class="grid kpi-grid">
      ${kpi('Sales',k.sales,'Official Income Statement')}${kpi('Gross Profit',k.grossProfit,`Margin ${pct(k.grossMargin)}`)}${kpi('Net Income',k.netIncome,'Official Sim Companies result')}${kpi('Core Business',k.coreBusinessResult,'Derived; excludes non-operating activity')}${kpi('Cash',k.cash,`Latest balance ${fmtDate(d.latestBalance.snapshot_date)}`,'money',k.cash>=0?'positive':'negative')}${kpi('Net Cash Flow',k.netCashFlow,'Selected statement periods')}
      ${kpi('Inventory',k.inventory,'Selected balance-sheet snapshot','money','')}${kpi('Total Assets',k.totalAssets,'Latest balance sheet','money','')}${kpi('Liabilities',k.liabilities,'Latest balance sheet')}${kpi('Equity / Net Worth',k.equity,'Contributed capital + retained earnings')}${kpi('Exchange Fees',k.exchangeFees==null?null:-Math.abs(k.exchangeFees),'Official Income Statement')}${kpi('Transactions',k.transactionCount,'Operational rows in range','number','')}
    </div>
    <div class="grid charts-2">
      <div class="card"><div class="card-header"><div><h3>Profitability Trend</h3><p>Official statements; Core Business Result is derived</p></div></div><div class="card-body">${lineChart(d.charts.profitability,[{key:'sales',label:'Sales'},{key:'gross_profit',label:'Gross Profit'},{key:'net_income',label:'Net Income'},{key:'core_business_result',label:'Core Business'}])}</div></div>
      <div class="card health-card"><div class="health-row"><div class="health-score" style="--score:${d.health.score}"><span>${d.health.score}</span></div><div class="health-label"><div class="kpi-label">Financial Health</div><strong>${escapeHtml(d.health.status)}</strong><p>Transparent rule-based assessment</p></div></div><div class="insights">${d.health.reasons.map(x=>`<div class="insight">${escapeHtml(x)}</div>`).join('')}</div></div>
    </div>
    <div class="grid charts-3">
      <div class="card"><div class="card-header"><div><h3>Cash & Equity</h3><p>Point-in-time balance sheet snapshots</p></div></div><div class="card-body">${lineChart(d.charts.balance,[{key:'cash',label:'Cash'},{key:'total_equity',label:'Equity'}])}</div></div>
      <div class="card"><div class="card-header"><div><h3>Cash Flow</h3><p>Inflows, outflows, and net movement</p></div></div><div class="card-body">${lineChart(d.charts.cashflow,[{key:'all_income',label:'Inflows'},{key:'all_expenses',label:'Outflows'},{key:'net_cash_flow',label:'Net'}])}</div></div>
      <div class="card"><div class="card-header"><div><h3>Expense Breakdown</h3><p>Income Statement categories</p></div></div><div class="card-body">${barList(d.charts.expenses)}</div></div>
    </div>
    <div class="grid charts-2">
      <div class="card"><div class="card-header"><div><h3>Operational Snapshot</h3><p>Account History is shown separately from official statements</p></div></div><div class="card-body"><div class="grid" style="grid-template-columns:repeat(3,1fr)">${kpi('Market Purchases',-k.marketPurchases,'Operational cash outflow')}${kpi('Market Sales',k.marketSales,'Operational cash inflow')}${kpi('Production Spend',-k.productionSpending,'Operational production outflow')}</div></div></div>
      <div class="card"><div class="card-header"><div><h3>Insights</h3><p>Deterministic observations from your imported data</p></div></div><div class="card-body"><div class="insights">${d.insights.length?d.insights.map(x=>`<div class="insight">${escapeHtml(x)}</div>`).join(''):'<div class="empty">Import more statement history to unlock comparisons.</div>'}</div></div></div>
    </div>`;
}

const statementDefs={
  income:{title:'Income Statement',sections:[['Revenue',[['Sales','sales']]],['Cost of Goods Sold',[['COGS','cogs'],['Freight Out','freight_out']]],['Gross Profit',[['Gross Profit','gross_profit','subtotal']]],['Operating & Other',[['Construction','construction'],['Exchange Fees','exchange_fees'],['Salaries','salaries'],['Training','training'],['Poaching','poaching'],['Accounting Overhead','accounting_overhead'],['Bond Interest Expense','bond_interest_expense'],['Bond Interest Income','bond_interest_income'],['Donations','donations'],['Achievements / Referrals / PA','achievements_referrals_pa'],['Executive Royalties','executive_royalties'],['Gain on Sale','gain_on_sale'],['Patent Conversion','patent_conversion'],['Bond Defaults','bond_defaults'],['Bond Writeoffs','bond_writeoffs']]],['Results',[['Net Income','net_income','total'],['Core Business Result (Derived)','core_business_result','total'],['Other Comprehensive Income','other_comprehensive_income']]]]},
  cashflow:{title:'Cash Flow Statement',sections:[['Totals',[['All Income','all_income'],['All Expenses','all_expenses'],['Displayed-line Rounding Adjustment','rounding_adjustment'],['Net Cash Flow','net_cash_flow','total']]],['Inflows',[['From Retail','from_retail'],['From Customers','from_customers'],['From Exchange','from_exchange'],['From Interest','from_interest'],['From Poaching','from_poaching'],['From Royalties','from_royalties'],['From Employees','from_employees'],['Game Income','game_income']]],['Outflows',[['To Suppliers','to_suppliers'],['To Exchange','to_exchange'],['To Employees','to_employees'],['To Executives','to_executives'],['For Interest','for_interest'],['For Fees','for_fees'],['For Accounting','for_accounting'],['For PA Quests','for_pa_quests']]],['Other',[['Investment in Bonds','investment_in_bonds'],['Bonds','bonds'],['Unclassified Net','unclassified_net']]]]},
  balance:{title:'Balance Sheet',sections:[['Assets',[['Cash','cash'],['Cash Reserved for Orders','cash_reserved'],['Accounts Receivable','accounts_receivable'],['Inventory - Materials','inventory_materials'],['Inventory - Research','inventory_research'],['Inventory - WIP','inventory_wip'],['Inventory - Finished Goods','inventory_finished_goods'],['Inventory Valuation Allowance','inventory_valuation_allowance'],['Total Inventory','total_inventory','subtotal'],['Deposits','deposits'],['Investment in Bonds','investment_in_bonds'],['Buildings','buildings'],['Construction in Progress','construction_in_progress'],['Patents','patents'],['Total Assets','total_assets','total']]],['Liabilities',[['Liabilities','liabilities','total']]],['Equity',[['Contributed Capital','contributed_capital'],['Retained Earnings','retained_earnings'],['Total Equity / Net Worth','total_equity','total']]],['Reconciliation',[['Balance Delta','balance_delta','total']]]]},
};
async function renderStatement(type){
  setLoading(`Loading ${statementDefs[type].title}…`); const d=await api(`/api/statements/${type}${dateQuery()}`); const rows=d.rows||[]; if(!rows.length){content.innerHTML='<div class="empty">No saved statements in the selected UTC date range.</div>';return;}
  let selected=0;
  const draw=()=>{const r=rows[selected];const def=statementDefs[type];content.innerHTML=`<div class="card statement"><div class="statement-head"><h2>${def.title}</h2><p>${escapeHtml(state.meta?.company?.name||'Company')} · Snapshot ${fmtDateTime(r.snapshot_at)}${r.period_start_at?` · Period begins ${fmtDateTime(r.period_start_at)}`:''}</p></div><div class="period-tabs">${rows.map((x,i)=>`<button class="period-tab ${i===selected?'active':''}" data-period="${i}">${fmtDate(x.snapshot_date)}</button>`).join('')}</div>${def.sections.map(([name,lines])=>`<div class="statement-section"><div class="nav-group-title" style="padding-left:24px">${name}</div>${lines.map(([label,key,kind])=>`<div class="statement-line ${kind||''}"><span>${label}</span><span class="value ${clsMoney(r[key])}">${money(r[key])}</span></div>`).join('')}</div>`).join('')}</div>`;$$('[data-period]').forEach(b=>b.onclick=()=>{selected=Number(b.dataset.period);draw()});}; draw();
}

function table(headers,rows,{click}={}){
  if(!rows.length)return '<div class="empty">No data found.</div>';
  return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(h=>`<th class="${h.money?'money':''}">${h.label}</th>`).join('')}</tr></thead><tbody>${rows.map((r,i)=>`<tr class="${click?'clickable':''}" data-row="${i}">${headers.map(h=>{let v=h.get?h.get(r):r[h.key];let out=h.html?String(v??''):escapeHtml(v??'—');return `<td class="${h.money?'money '+clsMoney(v):''}" title="${escapeHtml(v??'')}">${h.money?money(v):out}</td>`}).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function renderTransactions(){
  setLoading('Loading transactions…'); const q=new URLSearchParams({page:String(state.txPage),pageSize:'50'}); for(const [k,v] of Object.entries(state.txFilters))if(v)q.set(k,v); if(state.dates.from)q.set('from',state.dates.from);if(state.dates.to)q.set('to',state.dates.to);
  const [d,l]=await Promise.all([api(`/api/transactions?${q}`),api('/api/lookups')]);
  const headers=[{label:'Date',get:r=>fmtDateTime(r.occurred_at)},{label:'Category',key:'category'},{label:'Description',key:'description'},{label:'Product',key:'product_name'},{label:'Building',key:'building_name'},{label:'Qty',key:'amount'},{label:'Unit Price',get:r=>r.price_text?`$${r.price_text}`:'—'},{label:'Money',key:'money',money:true},{label:'Profit',key:'profit',money:true},{label:'Counterparty',key:'counterparty_name'}];
  content.innerHTML=`<div class="toolbar"><input class="input search" id="txSearch" placeholder="Search description, product, counterparty, ID…" value="${escapeHtml(state.txFilters.search||'')}"><select class="input" id="txCategory"><option value="">All categories</option>${l.categories.map(x=>`<option ${state.txFilters.category===x?'selected':''}>${escapeHtml(x)}</option>`).join('')}</select><select class="input" id="txProduct"><option value="">All products</option>${l.products.map(x=>`<option ${state.txFilters.product_name===x?'selected':''}>${escapeHtml(x)}</option>`).join('')}</select><select class="input" id="txBuilding"><option value="">All buildings</option>${l.buildings.map(x=>`<option ${state.txFilters.building_name===x?'selected':''}>${escapeHtml(x)}</option>`).join('')}</select><select class="input" id="txDirection"><option value="">In & out</option><option value="in" ${state.txFilters.direction==='in'?'selected':''}>Money in</option><option value="out" ${state.txFilters.direction==='out'?'selected':''}>Money out</option></select><button class="btn" id="txApply">Apply</button><span class="spacer"></span><a class="btn" href="${realmHref('/api/export/transactions.csv')}">Export all CSV</a></div><div class="card">${table(headers,d.rows,{click:true})}<div class="pager"><span>${d.total.toLocaleString()} transactions · Page ${d.page} of ${Math.max(1,d.pages)}</span><button class="btn small" id="prevPage" ${d.page<=1?'disabled':''}>Previous</button><button class="btn small" id="nextPage" ${d.page>=d.pages?'disabled':''}>Next</button></div></div>`;
  $('#txApply').onclick=()=>{state.txFilters={search:$('#txSearch').value.trim(),category:$('#txCategory').value,product_name:$('#txProduct').value,building_name:$('#txBuilding').value,direction:$('#txDirection').value};state.txPage=1;renderTransactions()}; $('#txSearch').onkeydown=e=>{if(e.key==='Enter')$('#txApply').click()};
  $('#prevPage').onclick=()=>{if(state.txPage>1){state.txPage--;renderTransactions()}}; $('#nextPage').onclick=()=>{if(state.txPage<d.pages){state.txPage++;renderTransactions()}};
  $$('tbody tr.clickable').forEach(tr=>tr.onclick=()=>showTransaction(d.rows[Number(tr.dataset.row)].id));
}
async function showTransaction(id){
  try{const r=await api(`/api/transactions/${id}`); modal(`Transaction #${escapeHtml(r.external_id)}`,`<div class="detail-grid">${[['Date',fmtDateTime(r.occurred_at)],['Category',r.category],['Money',money(r.money)],['Product',r.product_name],['Building',r.building_name],['Quantity',r.amount],['Price',r.price_text],['Unit COGS',r.unit_cogs_text],['Profit',r.profit==null?'—':money(r.profit)],['Counterparty',r.counterparty_name],['Details status',r.details_ok?'Parsed':'Parse error'],['Import batch',r.first_seen_batch_id]].map(([k,v])=>`<div class="detail-item"><label>${k}</label><div>${escapeHtml(v??'—')}</div></div>`).join('')}</div><h4>Details JSON</h4><div class="code">${escapeHtml(JSON.stringify(r.details,null,2))}</div><h4>Original source row</h4><div class="code">${escapeHtml(JSON.stringify(r.rawRow,null,2))}</div>`)}catch(e){toast(e.message,'error')}
}

async function renderProducts(){setLoading();const d=await api(`/api/analytics/products${dateQuery()}`);const h=[{label:'Product',key:'product'},{label:'Transactions',key:'transactions'},{label:'Revenue',key:'revenue',money:true},{label:'Spending',get:r=>-Number(r.spending),money:true},{label:'Net Cash',key:'net_cash',money:true},{label:'Produced',key:'produced_quantity'},{label:'Market Bought',key:'market_bought_quantity'},{label:'Market Sold',key:'market_sold_quantity'},{label:'Avg Buy',get:r=>r.avg_market_buy_price==null?'—':`$${decimal(r.avg_market_buy_price,4)}`},{label:'Avg Sell',get:r=>r.avg_market_sell_price==null?'—':`$${decimal(r.avg_market_sell_price,4)}`},{label:'Known Profit',key:'known_profit',money:true}];content.innerHTML=`<div class="callout">Product analytics are operational and come from Account History. Retail quantities are not invented when Sim Companies does not export them.</div><div class="toolbar"><span class="spacer"></span><a class="btn" href="${realmHref('/api/export/products.csv')}">Export all CSV</a></div><div class="card">${table(h,d.rows)}</div>`;}
async function renderBuildings(){setLoading();const d=await api(`/api/analytics/buildings${dateQuery()}`);const h=[{label:'Building',key:'building'},{label:'Level',key:'level'},{label:'Transactions',key:'transactions'},{label:'Production Qty',key:'production_quantity'},{label:'Attributed Revenue',key:'revenue',money:true},{label:'Attributed Spend',get:r=>-Number(r.spending),money:true},{label:'Products',key:'products'},{label:'Last Activity',get:r=>fmtDateTime(r.last_activity)}];content.innerHTML=`<div class="callout">Building profitability is shown only to the extent transactions can be attributed from exported metadata. Unattributed company-level costs are not fabricated.</div><div class="card">${table(h,d.rows)}</div>`;}
async function renderMarket(){setLoading();const d=await api(`/api/analytics/market${dateQuery()}`);if(!d.products.length&&!d.counterparties.length){content.innerHTML='<div class="empty">No saved market activity in the selected UTC date range.</div>';return}const s=d.summary||{};content.innerHTML=`<div class="grid kpi-grid">${kpi('Market Purchases',-Number(s.purchases||0),'Account History market outflow')}${kpi('Market Sales',Number(s.sales||0),'Account History market inflow')}${kpi('Operational Fees',-Number(s.fees||0),'Account History fee category')}${kpi('Known Market Profit',Number(s.known_profit||0),'Only rows that export profit','money')}${kpi('Net Market Cash',Number(s.sales||0)-Number(s.purchases||0),'Sales minus purchases','money')}${kpi('Products',d.products.length,'Products with market activity','number')}</div><div class="grid charts-2"><div class="card"><div class="card-header"><h3>Market by Product</h3></div>${table([{label:'Product',key:'product'},{label:'Bought',key:'bought_quantity'},{label:'Purchases',get:r=>-Number(r.purchases),money:true},{label:'Sold',key:'sold_quantity'},{label:'Sales',key:'sales',money:true},{label:'Avg Buy',get:r=>r.avg_buy_price==null?'—':`$${decimal(r.avg_buy_price,4)}`},{label:'Avg Sell',get:r=>r.avg_sell_price==null?'—':`$${decimal(r.avg_sell_price,4)}`},{label:'Known Profit',key:'known_profit',money:true}],d.products)}</div><div class="card"><div class="card-header"><h3>Counterparties</h3></div>${table([{label:'Name',key:'name'},{label:'Role',key:'role'},{label:'Transactions',key:'transactions'},{label:'Received',key:'received',money:true},{label:'Paid',get:r=>-Number(r.paid),money:true}],d.counterparties)}</div></div>`;}
async function renderFees(){setLoading();const d=await api(`/api/analytics/fees${dateQuery()}`);const merged=new Map();for(const r of d.income)merged.set(r.date,{date:r.date,income:Number(r.exchange_fees||0),sales:Number(r.sales||0),cash:0,operational:0});for(const r of d.cashflow){const x=merged.get(r.date)||{date:r.date,income:0,sales:0,cash:0,operational:0};x.cash=Number(r.cashflow_fees||0);merged.set(r.date,x)}for(const r of d.operational){const x=merged.get(r.date)||{date:r.date,income:0,sales:0,cash:0,operational:0};x.operational=Number(r.account_history_fees||0);merged.set(r.date,x)}const rows=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));content.innerHTML=`<div class="callout warn"><strong>Sources stay separate.</strong> Income Statement exchange fees, Cash Flow “For fees,” and Account History fee transactions may overlap. Ascendant Ledger does not add them together into a fake total.</div><div class="card"><div class="card-header"><div><h3>Fee Comparison</h3><p>Independent accounting and operational views</p></div></div>${table([{label:'Date',get:r=>fmtDate(r.date)},{label:'Income Statement',get:r=>-r.income,money:true},{label:'Cash Flow',get:r=>-r.cash,money:true},{label:'Account History',get:r=>-r.operational,money:true},{label:'% of Sales',get:r=>r.sales?`${(r.income/r.sales*100).toFixed(1)}%`:'—'}],rows)}</div>`;}

async function readFiles(files){return Promise.all([...files].map(async f=>({filename:f.name,content:await f.text(),size:f.size})));}
async function previewImport(files){state.pendingFiles=await readFiles(files);setLoading('Parsing and validating CSV files…');try{const d=await api('/api/import/preview',{method:'POST',body:JSON.stringify({files:state.pendingFiles.map(({filename,content})=>({filename,content}))})});state.importPreview=d.previews;drawImportPreview();}catch(e){toast(e.message,'error');renderImport();}}
function drawImportPreview(){const p=state.importPreview||[];const company=state.meta?.company?.name||'Company';content.innerHTML=`<div class="callout"><strong>${realmLabel()} Realm — ${escapeHtml(company)}</strong><br>Files are detected from their column headers, not their filenames. Preview is read-only; nothing is stored until you click <strong>Commit Import</strong>.</div><div class="file-list">${p.map(x=>`<div class="file-card"><div><strong>${escapeHtml(x.originalFilename)}</strong><small>${escapeHtml(x.detection.label)} · ${escapeHtml(x.periodStart?fmtDate(x.periodStart):'No date range')}${x.alreadyImportedFile?' · Exact file previously imported':''}</small></div><div class="file-metric"><label>Rows</label><b>${x.rowsTotal}</b></div><div class="file-metric"><label>New</label><b class="positive">${x.rowsNew}</b></div><div class="file-metric"><label>Updates</label><b class="warning">${x.rowsUpdated}</b></div><div class="file-metric"><label>Duplicates</label><b>${x.rowsDuplicate}</b></div><div class="file-metric"><label>Errors</label><b class="${x.rowsInvalid?'negative':''}">${x.rowsInvalid}</b></div></div>${x.warnings?.length?`<div class="callout warn">${x.warnings.map(w=>escapeHtml(w.message)).join('<br>')}</div>`:''}${x.errors?.length?`<div class="callout bad">${x.errors.slice(0,5).map(e=>`Row ${e.rowNumber}: ${escapeHtml(e.message)}`).join('<br>')}</div>`:''}`).join('')}</div><div class="import-actions"><button class="btn" id="cancelImport">Cancel</button><button class="btn primary" id="commitImport" ${p.some(x=>!x.detection.type)?'disabled':''}>Commit Import</button></div>`;$('#cancelImport').onclick=()=>{state.pendingFiles=[];state.importPreview=null;renderImport()};$('#commitImport').onclick=commitImport;}
async function commitImport(){if(!state.pendingFiles.length)return;const company=state.meta?.company?.name||'Company';if(!confirm(`Commit ${state.pendingFiles.length} CSV file${state.pendingFiles.length===1?'':'s'} to ${realmLabel()} — ${company}?`))return;const btn=$('#commitImport');btn.disabled=true;btn.textContent='Importing…';try{const d=await api('/api/import/commit',{method:'POST',body:JSON.stringify({files:state.pendingFiles.map(({filename,content})=>({filename,content}))})});toast(`Import complete: ${d.transactionsInserted} transactions inserted.`);state.pendingFiles=[];state.importPreview=null;navigate('dashboard')}catch(e){toast(e.message,'error');btn.disabled=false;btn.textContent='Commit Import'}}
async function renderImport(){const company=state.meta?.company?.name||'Company';content.innerHTML=`<div class="callout"><strong>Import destination:</strong> ${realmLabel()} Realm — ${escapeHtml(company)}. Data imported here stays separate from the other Realm.</div><div class="drop-zone" id="dropZone"><div class="upload-icon">⇧</div><h3>Drop Sim Companies CSV exports here</h3><p>Account History, Income Statement, Cash Flow Statement, and Balance Sheet · multiple files supported</p><input id="fileInput" type="file" accept=".csv,text/csv" multiple hidden><button class="btn primary" style="margin-top:16px" id="browseFiles">Browse CSV Files</button></div><div class="callout" style="margin-top:16px"><strong>Safe overlapping imports:</strong> transaction IDs are deduplicated; statement dates are revisioned and upserted. Re-exporting the same history will not double-count it.</div>`;const z=$('#dropZone'),i=$('#fileInput');$('#browseFiles').onclick=e=>{e.stopPropagation();i.click()};z.onclick=()=>i.click();i.onchange=()=>i.files?.length&&previewImport(i.files);['dragenter','dragover'].forEach(ev=>z.addEventListener(ev,e=>{e.preventDefault();z.classList.add('drag')}));['dragleave','drop'].forEach(ev=>z.addEventListener(ev,e=>{e.preventDefault();z.classList.remove('drag')}));z.addEventListener('drop',e=>e.dataTransfer?.files?.length&&previewImport(e.dataTransfer.files));}
async function renderHistory(){
  setLoading();
  const d=await api('/api/import/history');
  const h=[
    {label:'Imported',get:r=>fmtDateTime(r.created_at)},
    {label:'Status',html:true,get:r=>`<span class="badge ${r.status==='committed'?'good':r.status==='rolled_back'?'warn':'bad'}">${escapeHtml(r.status)}</span>`},
    {label:'Source / Note',key:'note'},{label:'Files',key:'file_count'},{label:'Rows',key:'rows_total'},{label:'Inserted',key:'rows_inserted'},
    {label:'Updated',key:'rows_updated'},{label:'Duplicates',key:'rows_duplicate'},{label:'Invalid',key:'rows_invalid'},
    {label:'Action',html:true,get:r=>`<div class="inline-actions"><button class="btn small import-details" data-id="${escapeHtml(r.id)}">Details</button>${r.status==='committed'?`<button class="btn small danger rollback" data-id="${escapeHtml(r.id)}">Rollback</button>`:''}</div>`}
  ];
  content.innerHTML=`<div class="callout warn">Rollback removes transactions first introduced by that batch and removes only that batch's statement revisions. If an older import also supplied the same statement date, the older revision is restored. While capture sync is enabled, saved transactions removed by rollback will be restored on its next check.</div><div class="card">${table(h,d.batches)}</div>`;
  $$('.import-details').forEach(b=>b.onclick=e=>{
    e.stopPropagation();
    const files=d.files.filter(f=>f.batch_id===b.dataset.id);
    modal('Import batch details',`${files.length?table([
      {label:'File',key:'original_filename'},{label:'Type',key:'detected_type'},{label:'Rows',key:'rows_total'},
      {label:'Inserted',key:'rows_inserted'},{label:'Updated',key:'rows_updated'},{label:'Duplicates',key:'rows_duplicate'},
      {label:'Invalid',key:'rows_invalid'},{label:'Period start',get:r=>fmtDateTime(r.period_start)},{label:'Period end',get:r=>fmtDateTime(r.period_end)}
    ],files):'<div class="empty">No files recorded for this batch.</div>'}<h4>Provenance</h4><div class="code">Batch: ${escapeHtml(b.dataset.id)}\n${files.map(f=>`${escapeHtml(f.original_filename)}  SHA-256 ${escapeHtml(f.file_sha256)}`).join('\n')}</div>`);
  });
  $$('.rollback').forEach(b=>b.onclick=async e=>{
    e.stopPropagation();
    if(!confirm(`Rollback this ${realmLabel()} import batch? This changes stored financial data only in this Realm.`))return;
    try{const r=await api(`/api/import/${b.dataset.id}/rollback`,{method:'POST',body:'{}'});toast(`Rolled back. ${r.transactionsRemoved} transactions removed.`);renderHistory()}catch(err){toast(err.message,'error')}
  });
}
async function renderQuality(){setLoading();const d=await api('/api/quality');content.innerHTML=`<div class="grid kpi-grid">${kpi('Open Errors',d.stats.errors||0,'Requires attention','number',Number(d.stats.errors)?'negative':'positive')}${kpi('Warnings',d.stats.warnings||0,'Potential mismatch','number',Number(d.stats.warnings)?'warning':'')}${kpi('Info',d.stats.info||0,'Informational findings','number','')}${kpi('Balance sheets checked',d.balanceSheetCount,'Imported balance-sheet snapshots','number')}</div>${d.balanceSheetCount?'':'<div class="callout warn">No imported balance sheets are available to reconcile. Zero findings does not mean the company has passed reconciliation.</div>'}<div class="card">${table([{label:'Severity',html:true,get:r=>`<span class="badge ${r.severity==='error'?'bad':r.severity==='warning'?'warn':'good'}">${r.severity}</span>`},{label:'Check',key:'check_code'},{label:'Date',get:r=>fmtDate(r.occurred_at)},{label:'Message',key:'message'},{label:'Status',html:true,get:r=>r.resolved_at?'<span class="badge">Resolved</span>':'<span class="badge good">Open</span>'}],d.rows)}</div>`;}

async function renderRaw(){
  const dataset=new URLSearchParams(location.search).get('dataset')||'transactions';
  const filter=state.rawFilters[dataset]||{search:'',sort:'',dir:'desc'};
  setLoading();
  const qp=new URLSearchParams({page:String(state.rawPage),pageSize:'50'});
  if(filter.search)qp.set('search',filter.search);if(filter.sort)qp.set('sort',filter.sort);if(filter.dir)qp.set('dir',filter.dir);
  const d=await api(`/api/raw/${dataset}?${qp}`);
  const rows=d.rows||[];
  const allKeys=rows.length?Object.keys(rows[0]):[];
  if(!state.rawColumns[dataset]&&allKeys.length) state.rawColumns[dataset]=allKeys.slice(0,20);
  const selected=new Set(state.rawColumns[dataset]||[]);
  const visibleKeys=allKeys.filter(k=>selected.has(k));
  const headers=visibleKeys.map(k=>({label:humanKey(k),key:k}));
  content.innerHTML=`<div class="toolbar"><select class="input" id="rawDataset">${[['transactions','Transactions'],['income','Income Statement Facts'],['cashflow','Cash Flow Facts'],['balance','Balance Sheet Facts'],['imports','Import Files'],['revisions','Statement Revisions']].map(([v,l])=>`<option value="${v}" ${v===dataset?'selected':''}>${l}</option>`).join('')}</select><input class="input search" id="rawSearch" placeholder="Filter text fields…" value="${escapeHtml(filter.search||'')}"><select class="input" id="rawSort"><option value="">Default sort</option>${allKeys.map(k=>`<option value="${escapeHtml(k)}" ${filter.sort===k?'selected':''}>Sort: ${escapeHtml(humanKey(k))}</option>`).join('')}</select><select class="input" id="rawDir"><option value="desc" ${filter.dir!=='asc'?'selected':''}>Descending</option><option value="asc" ${filter.dir==='asc'?'selected':''}>Ascending</option></select><button class="btn" id="applyRawFilter">Apply</button><button class="btn" id="chooseRawColumns" ${allKeys.length?'':'disabled'}>Columns (${visibleKeys.length}/${allKeys.length})</button><span class="spacer"></span>${['transactions','income','cashflow','balance'].includes(dataset)?`<a class="btn" href="${realmHref(`/api/export/${dataset}.csv`)}">Export all CSV</a>`:''}</div><div class="callout">Raw and provenance fields remain stored even when hidden. Search is available for text-heavy datasets; sorting and column selection work across all raw datasets.</div><div class="card">${visibleKeys.length?table(headers,rows):`<div class="empty">${rows.length?'Choose at least one column to display.':'No imported rows match this view.'}</div>`}<div class="pager"><span>${Number(d.total||0).toLocaleString()} rows · Page ${d.page} of ${Math.max(1,d.pages)}</span><button class="btn small" id="rawPrev" ${d.page<=1?'disabled':''}>Previous</button><button class="btn small" id="rawNext" ${d.page>=d.pages?'disabled':''}>Next</button></div></div>`;
  $('#rawDataset').onchange=e=>{state.rawPage=1;history.replaceState(null,'',`${location.pathname}?dataset=${e.target.value}${location.hash}`);renderRaw()};
  $('#applyRawFilter').onclick=()=>{state.rawFilters[dataset]={search:$('#rawSearch').value.trim(),sort:$('#rawSort').value,dir:$('#rawDir').value};state.rawPage=1;renderRaw()};
  $('#rawSearch').onkeydown=e=>{if(e.key==='Enter')$('#applyRawFilter').click()};
  $('#rawPrev').onclick=()=>{if(state.rawPage>1){state.rawPage--;renderRaw()}};
  $('#rawNext').onclick=()=>{if(state.rawPage<d.pages){state.rawPage++;renderRaw()}};
  if($('#chooseRawColumns')) $('#chooseRawColumns').onclick=()=>{
    modal('Choose raw-data columns',`<div class="column-chooser">${allKeys.map(k=>`<label><input type="checkbox" data-raw-column="${escapeHtml(k)}" ${selected.has(k)?'checked':''}> ${escapeHtml(humanKey(k))}</label>`).join('')}</div><div class="modal-actions"><button class="btn" id="rawColsFirst20">First 20</button><button class="btn primary" id="applyRawColumns">Apply</button></div>`);
    $('#rawColsFirst20').onclick=()=>{$$('[data-raw-column]').forEach((x,i)=>x.checked=i<20)};
    $('#applyRawColumns').onclick=()=>{state.rawColumns[dataset]=$$('[data-raw-column]').filter(x=>x.checked).map(x=>x.dataset.rawColumn);closeModal();renderRaw()};
  };
}

async function renderSettings(){setLoading();const d=await api('/api/settings');const s=d.settings||{};content.innerHTML=`<div class="grid settings-grid"><div class="card"><div class="card-header"><div><h3>${realmLabel()} Business</h3><p>Each Realm has its own company name and financial data</p></div></div><div class="card-body"><div class="form-row"><label>Company name</label><input class="input" id="companyInput" value="${escapeHtml(d.company?.name||'')}"></div><button class="btn primary" id="saveCompany">Save company name</button></div></div><div class="card"><div class="card-header"><div><h3>Display & Backup</h3><p>Personalize this installation</p></div></div><div class="card-body"><div class="form-row"><label>Theme</label><select class="input" id="themeSetting"><option value="system" ${s['display.theme']==='system'?'selected':''}>System</option><option value="dark" ${s['display.theme']==='dark'?'selected':''}>Dark</option><option value="light" ${s['display.theme']==='light'?'selected':''}>Light</option></select></div><div class="form-row"><label>Display timezone</label><input class="input" id="timezoneSetting" placeholder="America/Phoenix or browser" value="${escapeHtml(s['display.timezone']||'UTC')}"><small class="field-help">Use an IANA timezone such as America/Phoenix, UTC, or browser.</small></div><div class="form-row"><label>Currency symbol</label><input class="input" id="currencySetting" maxlength="8" value="${escapeHtml(s['display.currencySymbol']||'$')}"></div><label class="toggle-row"><input type="checkbox" id="tailSetting" ${s['dashboard.showUnreconciledTail']!==false?'checked':''}> Show transactions newer than the latest official statement as an unreconciled-tail insight</label><a class="btn" href="${realmHref('/api/backup')}">Download full SQLite backup (both Realms)</a><p style="color:var(--muted);font-size:10px">Authentication: ${d.authEnabled?'enabled':'disabled'}. Use HTTPS when enabling login behind a reverse proxy.</p>${d.authEnabled?`<hr style="border:0;border-top:1px solid var(--line);margin:16px 0"><div class="form-row"><label>Current password</label><input class="input" id="currentPassword" type="password"></div><div class="form-row"><label>New password (12+ characters)</label><input class="input" id="newPassword" type="password"></div><button class="btn" id="changePassword">Change password</button>`:''}</div></div></div><div class="grid settings-grid" style="margin-top:14px"><div class="card"><div class="card-header"><div><h3>Resource ID Mappings</h3><p>Shared game-wide across both Realms; manual overrides win</p></div></div><div class="card-body">${d.resources.length?d.resources.map(r=>`<div class="mapping-row"><strong>#${r.resource_id}</strong><input class="input map-resource" data-id="${r.resource_id}" value="${escapeHtml(r.display_name)}"><span class="source-pill">${escapeHtml(r.name_source)} · ${r.observation_count} seen</span><button class="btn small save-resource" data-id="${r.resource_id}">Save</button><button class="btn small reset-resource" data-id="${r.resource_id}">Reset</button></div>`).join(''):'<div class="empty">No resource IDs observed yet.</div>'}</div></div><div class="card"><div class="card-header"><div><h3>Building Mappings</h3><p>Shared game-wide across both Realms; auto-populated from imports</p></div></div><div class="card-body">${d.buildings.length?d.buildings.map(r=>`<div class="mapping-row"><strong>${escapeHtml(r.building_code||r.catalog_key)}</strong><input class="input map-building" data-key="${escapeHtml(r.catalog_key)}" value="${escapeHtml(r.display_name)}"><span class="source-pill">${escapeHtml(r.name_source)} · ${r.observation_count} seen</span><button class="btn small save-building" data-key="${escapeHtml(r.catalog_key)}">Save</button><button class="btn small reset-building" data-key="${escapeHtml(r.catalog_key)}">Reset</button></div>`).join(''):'<div class="empty">No buildings observed yet.</div>'}</div></div></div>`;
  $('#saveCompany').onclick=async()=>{try{const name=$('#companyInput').value.trim();await api('/api/settings/company',{method:'PUT',body:JSON.stringify({name})});state.meta.company.name=name;const realmInfo=state.meta.realms?.find(r=>r.realm===state.realm);if(realmInfo)realmInfo.name=name;$('#companyName').textContent=`${realmLabel()} · ${name}`;renderRealmSelect();toast('Company name saved.')}catch(e){toast(e.message,'error')}};
  $('#themeSetting').onchange=async e=>{try{await api('/api/settings/value',{method:'PUT',body:JSON.stringify({key:'display.theme',value:e.target.value})});state.meta.settings['display.theme']=e.target.value;applyTheme(e.target.value);toast('Theme saved.')}catch(err){toast(err.message,'error')}};
  $('#timezoneSetting').onchange=async e=>{try{const value=e.target.value.trim()||'UTC';await api('/api/settings/value',{method:'PUT',body:JSON.stringify({key:'display.timezone',value})});state.meta.settings['display.timezone']=value;toast('Timezone setting saved.');renderSettings()}catch(err){toast(err.message,'error')}};
  $('#currencySetting').onchange=async e=>{try{const value=e.target.value.trim()||'$';await api('/api/settings/value',{method:'PUT',body:JSON.stringify({key:'display.currencySymbol',value})});state.meta.settings['display.currencySymbol']=value;toast('Currency symbol saved.');renderSettings()}catch(err){toast(err.message,'error')}};
  $('#tailSetting').onchange=async e=>{try{const value=Boolean(e.target.checked);await api('/api/settings/value',{method:'PUT',body:JSON.stringify({key:'dashboard.showUnreconciledTail',value})});state.meta.settings['dashboard.showUnreconciledTail']=value;toast('Dashboard setting saved.')}catch(err){toast(err.message,'error')}};
  if($('#changePassword')) $('#changePassword').onclick=async()=>{try{await api('/api/settings/password',{method:'PUT',body:JSON.stringify({currentPassword:$('#currentPassword').value,newPassword:$('#newPassword').value})});$('#currentPassword').value='';$('#newPassword').value='';toast('Password changed.')}catch(e){toast(e.message,'error')}};
  $$('.save-resource').forEach(b=>b.onclick=async()=>{const input=$(`.map-resource[data-id="${b.dataset.id}"]`);try{await api(`/api/settings/resource/${b.dataset.id}`,{method:'PUT',body:JSON.stringify({displayName:input.value.trim()})});toast('Resource mapping saved.')}catch(e){toast(e.message,'error')}});
  $$('.reset-resource').forEach(b=>b.onclick=async()=>{try{await api(`/api/settings/resource/${b.dataset.id}`,{method:'DELETE'});toast('Resource override reset.');renderSettings()}catch(e){toast(e.message,'error')}});
  $$('.save-building').forEach(b=>b.onclick=async()=>{const key=b.dataset.key;const input=[...$$('.map-building')].find(x=>x.dataset.key===key);try{await api(`/api/settings/building/${encodeURIComponent(key)}`,{method:'PUT',body:JSON.stringify({displayName:input.value.trim()})});toast('Building mapping saved.')}catch(e){toast(e.message,'error')}});
  $$('.reset-building').forEach(b=>b.onclick=async()=>{try{await api(`/api/settings/building/${encodeURIComponent(b.dataset.key)}`,{method:'DELETE'});toast('Building override reset.');renderSettings()}catch(e){toast(e.message,'error')}});
}

function modal(title,body){$('#modalRoot').innerHTML=`<div class="modal-backdrop"><div class="modal"><div class="modal-head"><h3>${title}</h3><button class="close">×</button></div><div class="modal-body">${body}</div></div></div>`;$('.modal-backdrop').onclick=e=>{if(e.target.classList.contains('modal-backdrop'))closeModal()};$('.close').onclick=closeModal;}
function closeModal(){$('#modalRoot').innerHTML='';}
function applyTheme(theme){localStorage.setItem('ledger-theme',theme);let actual=theme;if(theme==='system')actual=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.dataset.theme=actual;}
function computeDates(preset){return utcDateRange(preset);}
function setupDates(){const p=$('#datePreset');p.onchange=()=>{state.txPage=1;state.dates.preset=p.value;if(p.value==='custom'){$('#customDates').classList.remove('hidden');return}$('#customDates').classList.add('hidden');Object.assign(state.dates,computeDates(p.value));route()};$('#applyDates').onclick=()=>{if($('#dateFrom').value && $('#dateTo').value && $('#dateFrom').value>$('#dateTo').value){toast('Start date must not be after end date.','error');return}state.txPage=1;state.dates.from=$('#dateFrom').value;state.dates.to=$('#dateTo').value;$('#customDates').classList.add('hidden');route()};}
function renderRealmSelect(){const select=$('#realmSelect');if(!select)return;select.value=state.realm;const realms=state.meta?.realms||[];for(const option of [...select.options]){const info=realms.find(r=>r.realm===option.value);option.textContent=info?`${realmLabel(option.value)} — ${info.name}`:realmLabel(option.value);}}
function setupRealm(){const select=$('#realmSelect');if(!select)return;select.value=state.realm;select.onchange=async()=>{const next=select.value;if(!['magnates','entrepreneurs'].includes(next))return;disposeOperations();pageController.abort();pageController=new AbortController();setLoading('Switching realm…');state.realm=next;localStorage.setItem('ledger-realm',next);state.pendingFiles=[];state.importPreview=null;state.txPage=1;state.rawPage=1;state.txFilters={};await bootData();toast(`Switched to ${realmLabel()} Realm.`);};}
function showLogin(){$('#loginOverlay').classList.remove('hidden');}
function hideLogin(){$('#loginOverlay').classList.add('hidden');}
async function initAuth(){state.auth=await api('/api/auth/status');if(state.auth.enabled&&!state.auth.authenticated)showLogin();else hideLogin();}

window.addEventListener('hashchange',route);
$('#menuButton').onclick=()=>$('#sidebar').classList.toggle('open');
$('#themeToggle').onclick=()=>{const cur=document.documentElement.dataset.theme;applyTheme(cur==='dark'?'light':'dark')};
$('#userMenu').onclick=async()=>{if(state.auth?.enabled){if(confirm('Sign out of Ascendant Ledger?')){await api('/api/auth/logout',{method:'POST',body:'{}'});showLogin()}}else toast('Authentication is disabled for this installation.')};
$('#loginForm').onsubmit=async e=>{e.preventDefault();$('#loginError').textContent='';try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:$('#loginUsername').value,password:$('#loginPassword').value})});hideLogin();state.auth=await api('/api/auth/status');await bootData();}catch(err){$('#loginError').textContent=err.message}};
setupDates();
setupRealm();
guardAttribution();

async function bootData(){
  try{
    state.meta=await api('/api/meta');if(!location.hash&&state.meta.operations?.enabled)location.hash='#/live-operations';enforceAttribution(state.meta.attribution?.display||OFFICIAL_ATTRIBUTION);state.realm=state.meta.realm||state.realm;localStorage.setItem('ledger-realm',state.realm);$('#companyName').textContent=`${realmLabel()} · ${state.meta.company?.name||'Company'}`;$('#brandName').textContent=state.meta.settings?.['app.name']||'Ascendant Ledger';document.title=`${state.meta.company?.name||'Company'} · ${realmLabel()} | ${$('#brandName').textContent}`;renderRealmSelect();applyTheme(localStorage.getItem('ledger-theme')||state.meta.settings?.['display.theme']||'system');
    const health=await api('/api/health');$('#healthText').textContent=health.status==='ok'?'Database healthy':'Database degraded';$('#healthDot').className=`status-dot ${health.status==='ok'?'ok':'bad'}`;await route();
  }catch(e){if(e.message!=='Authentication required.'){$('#healthText').textContent='Connection failed';$('#healthDot').className='status-dot bad';content.innerHTML=`<div class="callout bad">${escapeHtml(e.message)}</div>`;}}
}

(async()=>{renderNav();applyTheme(localStorage.getItem('ledger-theme')||'system');try{await initAuth();if(!state.auth?.enabled||state.auth?.authenticated)await bootData();}catch(e){content.innerHTML=`<div class="callout bad">Unable to initialize: ${escapeHtml(e.message)}</div>`}})();
