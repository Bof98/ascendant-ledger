import { healthStatus } from '../domain/health.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Db } from '../db/connection.js';
import { backupTo } from '../db/connection.js';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/types.js';
import { nowIso } from '../domain/time.js';
import { commitBatch, previewFiles, rollbackBatch, type UploadedFile } from '../import/pipeline.js';
import {
  findUnreconciledTail,
  persistFindings,
  runIdentityChecks,
  runTransactionReconciliation,
} from '../quality/identities.js';
import {
  clearBuildingOverride,
  clearResourceOverride,
  setBuildingOverride,
  setResourceOverride,
} from '../mappings/registry.js';
import {
  clearSession,
  createSessionCookie,
  readSession,
  setSession,
  verifyPassword,
  hashPassword,
} from '../auth.js';

const MAX_PAGE_SIZE = 250;

interface RouteDeps {
  app: FastifyInstance;
  raw: Db;
  qb: Kysely<Database>;
  config: AppConfig;
}

type Row = Record<string, unknown>;

function all<T extends Row = Row>(raw: Db, sql: string, params: unknown[] = []): T[] {
  return raw.prepare(sql).all(...params) as T[];
}

function one<T extends Row = Row>(raw: Db, sql: string, params: unknown[] = []): T | undefined {
  return raw.prepare(sql).get(...params) as T | undefined;
}

function int(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function dateWhere(query: Record<string, unknown>, column: string): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const from = typeof query['from'] === 'string' ? query['from'] : '';
  const to = typeof query['to'] === 'string' ? query['to'] : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function uploadedFilesFromBody(body: unknown, config: AppConfig): UploadedFile[] {
  if (!body || typeof body !== 'object') throw new Error('Request body is required.');
  const files = (body as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) throw new Error('At least one CSV file is required.');
  if (files.length > config.MAX_FILES_PER_BATCH) {
    throw new Error(`Too many files. Maximum per batch is ${config.MAX_FILES_PER_BATCH}.`);
  }
  return files.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`File ${index + 1} is invalid.`);
    const filename = String((item as { filename?: unknown }).filename ?? 'upload.csv');
    const content = (item as { content?: unknown }).content;
    if (typeof content !== 'string') throw new Error(`${filename}: content must be text.`);
    if (!filename.toLowerCase().endsWith('.csv')) throw new Error(`${filename}: only CSV files are accepted.`);
    if (Buffer.byteLength(content, 'utf8') > config.MAX_UPLOAD_BYTES) {
      throw new Error(`${filename}: file exceeds the ${config.MAX_UPLOAD_BYTES} byte upload limit.`);
    }
    return { originalFilename: filename, content };
  });
}

async function refreshQuality(qb: Kysely<Database>, companyId: number): Promise<void> {
  const identity = await runIdentityChecks(qb, companyId);
  const tx = await runTransactionReconciliation(qb, companyId);
  const tail = await findUnreconciledTail(qb, companyId);
  await persistFindings(qb, companyId, [...identity, ...tx, ...(tail ? [tail] : [])]);
}

function csvEscape(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Protect spreadsheet users from formula execution on exported text fields.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Row[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(','))].join('\r\n');
}

function getSettings(raw: Db): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const row of all<{ key: string; value_json: string }>(raw, 'SELECT key, value_json FROM app_settings')) {
    settings[row.key] = parseJson(row.value_json, row.value_json);
  }
  return settings;
}


const REALMS = ['magnates', 'entrepreneurs'] as const;
type RealmCode = (typeof REALMS)[number];

function realmCompany(raw: Db, request: FastifyRequest): { id: number; name: string; realm: RealmCode } {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const requested = String(query['realm'] ?? 'magnates').trim().toLowerCase();
  if (!REALMS.includes(requested as RealmCode)) {
    const error = new Error('Realm must be magnates or entrepreneurs.') as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const row = one<{ id: number; name: string; realm: RealmCode }>(
    raw,
    'SELECT id, name, realm FROM companies WHERE realm=?',
    [requested],
  );
  if (!row) {
    const error = new Error(`Realm ${requested} is not configured.`) as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  return row;
}


function statementRows(raw: Db, companyId: number, type: 'income' | 'cashflow' | 'balance', query: Record<string, unknown>): Row[] {
  const map = {
    income: { fact: 'income_statement_facts', columns: 'f.*' },
    cashflow: { fact: 'cashflow_statement_facts', columns: 'f.*' },
    balance: { fact: 'balance_sheet_facts', columns: 'f.*' },
  } as const;
  const conf = map[type];
  const dw = dateWhere(query, 'p.snapshot_date');
  return all(
    raw,
    `SELECT p.snapshot_date, p.snapshot_at, p.period_start_at, p.is_inception, ${conf.columns}
     FROM ${conf.fact} f JOIN statement_periods p ON p.id=f.period_id
     WHERE f.company_id=?${dw.sql}
     ORDER BY p.snapshot_at_us DESC`,
    [companyId, ...dw.params],
  );
}

export function registerApiRoutes({ app, raw, qb, config }: RouteDeps): void {

  app.get('/api/meta', async (request) => {
    const company = realmCompany(raw, request);
    const realms = all<{ id: number; name: string; realm: RealmCode }>(
      raw,
      `SELECT id, name, realm FROM companies WHERE realm IN ('magnates','entrepreneurs')
       ORDER BY CASE realm WHEN 'magnates' THEN 1 ELSE 2 END`,
    );
    return { operations: { enabled: Boolean(config.OPERATIONS_URL), realm: config.OPERATIONS_REALM, consolePath: config.OPERATIONS_CONSOLE_PATH }, version: '1.1.0', company, realm: company.realm, realms, settings: getSettings(raw), attribution: { creator: 'NullBot', copyrightYear: 2026, display: 'Created by NullBot | Copyright 2026' } };
  });

  app.get('/api/auth/status', async (request) => {
    if (!config.AUTH_ENABLED) return { enabled: false, authenticated: true, user: null };
    const session = readSession(request, config.SESSION_SECRET!);
    return { enabled: true, authenticated: Boolean(session), user: session ? { username: session.username } : null };
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (!config.AUTH_ENABLED) return { ok: true, disabled: true };
    const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(body.username ?? '');
    const password = String(body.password ?? '');
    const user = one<{ id: number; username: string; password_hash: string }>(
      raw,
      'SELECT id, username, password_hash FROM app_users WHERE username=?',
      [username],
    );
    if (!user || !verifyPassword(password, user.password_hash)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return reply.code(401).send({ error: 'Invalid username or password.' });
    }
    raw.prepare('UPDATE app_users SET last_login_at=? WHERE id=?').run(nowIso(), user.id);
    setSession(reply, createSessionCookie(user, config.SESSION_SECRET!), request.protocol === 'https');
    return { ok: true, user: { username: user.username } };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    clearSession(reply, request.protocol === 'https');
    return { ok: true };
  });

  app.get('/api/dashboard', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const query = request.query as Record<string, unknown>;
    const dw = dateWhere(query, 'p.snapshot_date');
    const income = one<Row>(
      raw,
      `SELECT COALESCE(SUM(f.sales),0) sales, COALESCE(SUM(f.cogs),0) cogs,
              COALESCE(SUM(f.gross_profit),0) gross_profit, COALESCE(SUM(f.net_income),0) net_income,
              COALESCE(SUM(f.core_business_result),0) core_business_result,
              COALESCE(SUM(f.exchange_fees),0) exchange_fees
       FROM income_statement_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${dw.sql}`,
      [companyId, ...dw.params],
    ) ?? {};
    const cashflow = one<Row>(
      raw,
      `SELECT COALESCE(SUM(f.all_income),0) all_income, COALESCE(SUM(f.all_expenses),0) all_expenses,
              COALESCE(SUM(f.net_cash_flow),0) net_cash_flow
       FROM cashflow_statement_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${dw.sql}`,
      [companyId, ...dw.params],
    ) ?? {};
    const balanceDw = dateWhere(query, 'p.snapshot_date');
    const balanceRows = all<Row>(raw,
      `SELECT p.snapshot_date, f.* FROM balance_sheet_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${balanceDw.sql} ORDER BY f.snapshot_at_us DESC LIMIT 2`,
      [companyId, ...balanceDw.params]);
    const latestBalance = balanceRows[0] ?? {};
    const previousBalance = balanceRows[1];
    const txRange = dateWhere(query, "substr(occurred_at,1,10)");
    const ops = one<Row>(raw,
      `SELECT
         COALESCE(SUM(CASE WHEN category='market' AND money<0 THEN -money ELSE 0 END),0) market_purchases,
         COALESCE(SUM(CASE WHEN category='market' AND money>0 THEN money ELSE 0 END),0) market_sales,
         COALESCE(SUM(CASE WHEN category='production' AND money<0 THEN -money ELSE 0 END),0) production_spending,
         COUNT(*) transaction_count
       FROM account_transactions WHERE company_id=?${txRange.sql}`,
      [companyId, ...txRange.params]) ?? {};

    const trend = all<Row>(raw,
      `SELECT p.snapshot_date date, f.sales, f.gross_profit, f.net_income, f.core_business_result
       FROM income_statement_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${dw.sql} ORDER BY p.snapshot_at_us ASC`,
      [companyId, ...dw.params]);
    const cashTrend = all<Row>(raw,
      `SELECT p.snapshot_date date, f.cash, f.total_assets, f.liabilities, f.total_equity, f.total_inventory
       FROM balance_sheet_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${dw.sql} ORDER BY p.snapshot_at_us ASC`,
      [companyId, ...dw.params]);
    const flowTrend = all<Row>(raw,
      `SELECT p.snapshot_date date, f.all_income, f.all_expenses, f.net_cash_flow
       FROM cashflow_statement_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${dw.sql} ORDER BY p.snapshot_at_us ASC`,
      [companyId, ...dw.params]);
    const expenses = one<Row>(raw,
      `SELECT
       COALESCE(SUM(-f.cogs),0) cogs, COALESCE(SUM(-f.freight_out),0) freight_out,
       COALESCE(SUM(-f.construction),0) construction, COALESCE(SUM(-f.exchange_fees),0) exchange_fees,
       COALESCE(SUM(-f.salaries),0) salaries, COALESCE(SUM(-f.training),0) training,
       COALESCE(SUM(-f.accounting_overhead),0) accounting_overhead,
       COALESCE(SUM(-f.bond_interest_expense),0) interest_expense, COALESCE(SUM(-f.donations),0) donations
       FROM income_statement_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${dw.sql}`, [companyId, ...dw.params]) ?? {};
    const categories = all<Row>(raw,
      `SELECT category, COUNT(*) count, SUM(money) net_money,
              SUM(CASE WHEN money>0 THEN money ELSE 0 END) inflow,
              -SUM(CASE WHEN money<0 THEN money ELSE 0 END) outflow
       FROM account_transactions WHERE company_id=?${txRange.sql}
       GROUP BY category ORDER BY count DESC`, [companyId, ...txRange.params]);

    const sales = int(income['sales']);
    const gross = int(income['gross_profit']);
    const core = int(income['core_business_result']);
    const netCash = int(cashflow['net_cash_flow']);
    const cash = int(latestBalance['cash']);
    const prevCash = previousBalance ? int(previousBalance['cash']) : cash;
    const grossMargin = sales !== 0 ? gross / sales : null;
    const hasFinancialData = trend.length > 0 || Boolean(latestBalance['snapshot_date']) || flowTrend.length > 0;
    const health = hasFinancialData
      ? healthStatus({
          core,
          netCash,
          cashChange: cash - prevCash,
          balanceDelta: latestBalance['snapshot_date'] ? int(latestBalance['balance_delta']) : null,
          grossMargin,
        })
      : { status: 'No Data', score: 0, reasons: ['Import Sim Companies statements to calculate financial health.'] };
    const insights: string[] = [];
    if (sales !== 0) insights.push(`Gross margin is ${(grossMargin! * 100).toFixed(1)}% for the selected period.`);
    if (core !== int(income['net_income'])) insights.push('Reported Net Income differs from Core Business Result because non-operating activity is excluded from the derived core metric.');
    if (netCash < 0 && core > 0) insights.push('Core operations are profitable while cash flow is negative; review inventory, suppliers, and timing of receipts.');
    if (int(expenses['exchange_fees']) > 0 && sales > 0) insights.push(`Exchange fees equal ${((int(expenses['exchange_fees']) / Math.abs(sales)) * 100).toFixed(1)}% of sales.`);
    if (int(latestBalance['balance_delta']) === 0 && latestBalance['snapshot_date']) insights.push(`The latest balance sheet (${latestBalance['snapshot_date']}) balances exactly.`);
    const dashboardSettings = getSettings(raw);
    const showUnreconciledTail = dashboardSettings['dashboard.showUnreconciledTail'] !== false;
    const tail = showUnreconciledTail ? await findUnreconciledTail(qb, companyId) : null;
    if (tail) insights.push(tail.message);

    return {
      kpis: {
        sales, cogs: int(income['cogs']), grossProfit: gross, grossMargin,
        netIncome: int(income['net_income']), coreBusinessResult: core,
        netMargin: sales !== 0 ? int(income['net_income']) / sales : null,
        exchangeFees: int(income['exchange_fees']), netCashFlow: netCash,
        cash, inventory: int(latestBalance['total_inventory']), totalAssets: int(latestBalance['total_assets']),
        liabilities: int(latestBalance['liabilities']), equity: int(latestBalance['total_equity']),
        marketPurchases: int(ops['market_purchases']), marketSales: int(ops['market_sales']),
        productionSpending: int(ops['production_spending']), transactionCount: int(ops['transaction_count']),
      },
      latestBalance,
      health,
      insights,
      unreconciledTail: tail?.details ?? null,
      charts: { profitability: trend, balance: cashTrend, cashflow: flowTrend, expenses, categories },
    };
  });

  app.get('/api/statements/:type', async (request, reply) => {
    const { id: companyId } = realmCompany(raw, request);
    const params = request.params as { type: string };
    if (!['income', 'cashflow', 'balance'].includes(params.type)) return reply.code(404).send({ error: 'Unknown statement type.' });
    return { rows: statementRows(raw, companyId, params.type as 'income' | 'cashflow' | 'balance', request.query as Record<string, unknown>) };
  });

  app.get('/api/transactions', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const q = request.query as Record<string, unknown>;
    const page = Math.max(1, int(q['page'], 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(10, int(q['pageSize'], 50)));
    const where = ['company_id=?'];
    const params: unknown[] = [companyId];
    const search = typeof q['search'] === 'string' ? q['search'].trim() : '';
    if (search) {
      where.push('(description LIKE ? OR category LIKE ? OR COALESCE(product_name,\'\') LIKE ? OR COALESCE(counterparty_name,\'\') LIKE ? OR CAST(external_id AS TEXT) LIKE ?)');
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(like, like, like, like, like);
    }
    for (const key of ['category', 'product_name', 'building_name'] as const) {
      const value = typeof q[key] === 'string' ? q[key].trim() : '';
      if (value) { where.push(`${key}=?`); params.push(value); }
    }
    const from = typeof q['from'] === 'string' ? q['from'] : '';
    const to = typeof q['to'] === 'string' ? q['to'] : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('substr(occurred_at,1,10)>=?'); params.push(from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('substr(occurred_at,1,10)<=?'); params.push(to); }
    if (q['direction'] === 'in') where.push('money>0');
    if (q['direction'] === 'out') where.push('money<0');
    const whereSql = where.join(' AND ');
    const total = int(one<{ count: number }>(raw, `SELECT COUNT(*) count FROM account_transactions WHERE ${whereSql}`, params)?.count);
    const rows = all<Row>(raw,
      `SELECT id, external_id, occurred_at, category, money, description, amount, price_text, unit_cogs_text, quality,
              remaining, profit, level, building_code, building_name, resource_id, counterparty_name, counterparty_role,
              product_name, product_source, details_ok
       FROM account_transactions WHERE ${whereSql}
       ORDER BY occurred_at_us DESC, external_id DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]);
    return { rows, page, pageSize, total, pages: Math.ceil(total / pageSize) };
  });

  app.get('/api/transactions/:id', async (request, reply) => {
    const { id: companyId } = realmCompany(raw, request);
    const id = int((request.params as { id: string }).id, -1);
    const row = one<Row>(raw, 'SELECT * FROM account_transactions WHERE company_id=? AND id=?', [companyId, id]);
    if (!row) return reply.code(404).send({ error: 'Transaction not found.' });
    return { ...row, details: parseJson(row['details_json'], null), rawRow: parseJson(row['raw_row_json'], null) };
  });

  app.get('/api/lookups', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const categories = all<Row>(raw, 'SELECT DISTINCT category value FROM account_transactions WHERE company_id=? ORDER BY category', [companyId]);
    const products = all<Row>(raw, "SELECT DISTINCT product_name value FROM account_transactions WHERE company_id=? AND product_name IS NOT NULL AND product_name<>'' ORDER BY product_name", [companyId]);
    const buildings = all<Row>(raw, "SELECT DISTINCT building_name value FROM account_transactions WHERE company_id=? AND building_name IS NOT NULL AND building_name<>'' ORDER BY building_name", [companyId]);
    return { categories: categories.map((r) => r['value']), products: products.map((r) => r['value']), buildings: buildings.map((r) => r['value']) };
  });

  app.get('/api/analytics/products', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const dw = dateWhere(request.query as Record<string, unknown>, 'substr(occurred_at,1,10)');
    const rows = all<Row>(raw,
      `SELECT product_name product,
        COUNT(*) transactions,
        SUM(CASE WHEN money>0 THEN money ELSE 0 END) revenue,
        -SUM(CASE WHEN money<0 THEN money ELSE 0 END) spending,
        SUM(money) net_cash,
        SUM(CASE WHEN category='production' THEN COALESCE(amount,0) ELSE 0 END) produced_quantity,
        SUM(CASE WHEN category='market' AND money<0 THEN COALESCE(amount,0) ELSE 0 END) market_bought_quantity,
        SUM(CASE WHEN category='market' AND money>0 THEN COALESCE(amount,0) ELSE 0 END) market_sold_quantity,
        AVG(CASE WHEN category='market' AND money<0 THEN price_real END) avg_market_buy_price,
        AVG(CASE WHEN category='market' AND money>0 THEN price_real END) avg_market_sell_price,
        SUM(COALESCE(profit,0)) known_profit,
        SUM(CASE WHEN profit IS NOT NULL THEN 1 ELSE 0 END) known_profit_rows
       FROM account_transactions
       WHERE company_id=? AND product_name IS NOT NULL AND product_name<>''${dw.sql}
       GROUP BY product_name ORDER BY revenue DESC, spending DESC`,
      [companyId, ...dw.params]);
    return { rows };
  });

  app.get('/api/analytics/buildings', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const dw = dateWhere(request.query as Record<string, unknown>, 'substr(t.occurred_at,1,10)');
    const rows = all<Row>(raw,
      `SELECT COALESCE(t.building_key, 'name:'||t.building_name) building_key,
              COALESCE(br.display_name, t.building_name, t.building_code, 'Unknown') building,
              MAX(COALESCE(t.level, br.last_known_level)) level,
              COUNT(*) transactions,
              SUM(CASE WHEN t.category='production' THEN COALESCE(t.amount,0) ELSE 0 END) production_quantity,
              SUM(CASE WHEN t.money>0 THEN t.money ELSE 0 END) revenue,
              -SUM(CASE WHEN t.money<0 THEN t.money ELSE 0 END) spending,
              GROUP_CONCAT(DISTINCT t.product_name) products,
              MAX(t.occurred_at) last_activity
       FROM account_transactions t
       LEFT JOIN building_resolved br ON br.catalog_key=t.building_key
       WHERE t.company_id=? AND (t.building_name IS NOT NULL OR t.building_code IS NOT NULL)${dw.sql}
       GROUP BY COALESCE(t.building_key, 'name:'||t.building_name), COALESCE(br.display_name, t.building_name, t.building_code, 'Unknown')
       ORDER BY revenue DESC, transactions DESC`, [companyId, ...dw.params]);
    return { rows };
  });

  app.get('/api/analytics/market', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const dw = dateWhere(request.query as Record<string, unknown>, 'substr(occurred_at,1,10)');
    const summary = one<Row>(raw,
      `SELECT
       -SUM(CASE WHEN category='market' AND money<0 THEN money ELSE 0 END) purchases,
       SUM(CASE WHEN category='market' AND money>0 THEN money ELSE 0 END) sales,
       SUM(CASE WHEN category='fees' THEN -money ELSE 0 END) fees,
       SUM(CASE WHEN category='market' THEN COALESCE(profit,0) ELSE 0 END) known_profit
       FROM account_transactions WHERE company_id=?${dw.sql}`, [companyId, ...dw.params]) ?? {};
    const products = all<Row>(raw,
      `SELECT product_name product, COUNT(*) transactions,
       -SUM(CASE WHEN money<0 THEN money ELSE 0 END) purchases,
       SUM(CASE WHEN money>0 THEN money ELSE 0 END) sales,
       SUM(CASE WHEN money<0 THEN COALESCE(amount,0) ELSE 0 END) bought_quantity,
       SUM(CASE WHEN money>0 THEN COALESCE(amount,0) ELSE 0 END) sold_quantity,
       AVG(CASE WHEN money<0 THEN price_real END) avg_buy_price,
       AVG(CASE WHEN money>0 THEN price_real END) avg_sell_price,
       SUM(COALESCE(profit,0)) known_profit
       FROM account_transactions WHERE company_id=? AND category='market' AND product_name IS NOT NULL${dw.sql}
       GROUP BY product_name ORDER BY purchases DESC, sales DESC`, [companyId, ...dw.params]);
    const counterparties = all<Row>(raw,
      `SELECT counterparty_name name, counterparty_role role, COUNT(*) transactions,
       SUM(CASE WHEN money>0 THEN money ELSE 0 END) received,
       -SUM(CASE WHEN money<0 THEN money ELSE 0 END) paid
       FROM account_transactions WHERE company_id=? AND category='market' AND counterparty_name IS NOT NULL${dw.sql}
       GROUP BY counterparty_name, counterparty_role ORDER BY transactions DESC LIMIT 50`, [companyId, ...dw.params]);
    return { summary, products, counterparties };
  });

  app.get('/api/analytics/fees', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const q = request.query as Record<string, unknown>;
    const stmtDw = dateWhere(q, 'p.snapshot_date');
    const txDw = dateWhere(q, 'substr(occurred_at,1,10)');
    const income = all<Row>(raw,
      `SELECT p.snapshot_date date, -f.exchange_fees exchange_fees, f.sales
       FROM income_statement_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${stmtDw.sql} ORDER BY p.snapshot_at_us ASC`, [companyId, ...stmtDw.params]);
    const cash = all<Row>(raw,
      `SELECT p.snapshot_date date, -f.for_fees cashflow_fees
       FROM cashflow_statement_facts f JOIN statement_periods p ON p.id=f.period_id
       WHERE f.company_id=?${stmtDw.sql} ORDER BY p.snapshot_at_us ASC`, [companyId, ...stmtDw.params]);
    const operational = all<Row>(raw,
      `SELECT substr(occurred_at,1,10) date, -SUM(money) account_history_fees, COUNT(*) transactions
       FROM account_transactions WHERE company_id=? AND category='fees'${txDw.sql}
       GROUP BY substr(occurred_at,1,10) ORDER BY date ASC`, [companyId, ...txDw.params]);
    return { income, cashflow: cash, operational };
  });

  app.post('/api/import/preview', async (request, reply) => {
    const { id: companyId } = realmCompany(raw, request);
    try {
      const files = uploadedFilesFromBody(request.body, config);
      const previews = await previewFiles(qb, companyId, files);
      return { previews };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/import/commit', async (request, reply) => {
    const { id: companyId } = realmCompany(raw, request);
    try {
      const files = uploadedFilesFromBody(request.body, config);
      // Preview again server-side rather than trusting the browser's earlier
      // preview. This prevents an unrecognised CSV from being recorded as a
      // successful zero-row import if the request is crafted manually.
      const previews = await previewFiles(qb, companyId, files);
      const unrecognised = previews.filter((p) => !p.detection.type);
      if (unrecognised.length > 0) {
        return reply.code(400).send({
          error: `Unrecognised CSV schema: ${unrecognised.map((p) => p.originalFilename).join(', ')}.`,
        });
      }
      const result = await commitBatch(qb, companyId, files, { note: 'Web import' });
      await refreshQuality(qb, companyId);
      return result;
    } catch (error) {
      request.log.error({ error }, 'import commit failed');
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/import/history', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const batches = all<Row>(raw,
      `SELECT b.*, COALESCE(SUM(f.rows_total),0) rows_total, COALESCE(SUM(f.rows_inserted),0) rows_inserted,
              COALESCE(SUM(f.rows_updated),0) rows_updated, COALESCE(SUM(f.rows_duplicate),0) rows_duplicate,
              COALESCE(SUM(f.rows_invalid),0) rows_invalid
       FROM import_batches b LEFT JOIN import_files f ON f.batch_id=b.id
       WHERE b.company_id=? GROUP BY b.id ORDER BY b.created_at DESC`, [companyId]);
    const files = all<Row>(raw,
      `SELECT id, batch_id, original_filename, detected_type, file_sha256, file_size_bytes, rows_total, rows_inserted,
              rows_updated, rows_duplicate, rows_invalid, period_start, period_end, warnings_json, status, error_message, created_at
       FROM import_files WHERE company_id=? ORDER BY created_at DESC`, [companyId]);
    return { batches, files: files.map((f) => ({ ...f, warnings: parseJson(f['warnings_json'], []) })) };
  });

  app.post('/api/import/:batchId/rollback', async (request, reply) => {
    const { id: companyId } = realmCompany(raw, request);
    try {
      const batchId = (request.params as { batchId: string }).batchId;
      const result = await rollbackBatch(qb, companyId, batchId);
      await refreshQuality(qb, companyId);
      return result;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/quality', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    await refreshQuality(qb, companyId);
    const rows = all<Row>(raw,
      `SELECT * FROM data_quality_findings WHERE company_id=? ORDER BY resolved_at IS NULL DESC,
       CASE severity WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END, detected_at DESC`, [companyId]);
    const stats = one<Row>(raw,
      `SELECT SUM(CASE WHEN resolved_at IS NULL AND severity='error' THEN 1 ELSE 0 END) errors,
              SUM(CASE WHEN resolved_at IS NULL AND severity='warning' THEN 1 ELSE 0 END) warnings,
              SUM(CASE WHEN resolved_at IS NULL AND severity='info' THEN 1 ELSE 0 END) info
       FROM data_quality_findings WHERE company_id=?`, [companyId]) ?? {};
    return { stats, rows: rows.map((r) => ({ ...r, details: parseJson(r['details_json'], {}) })) };
  });

  app.get('/api/settings', async (request) => {
    const { id: companyId } = realmCompany(raw, request);
    const company = one<Row>(raw, 'SELECT id, name, created_at, updated_at FROM companies WHERE id=?', [companyId]);
    const resources = all<Row>(raw, 'SELECT * FROM resource_resolved ORDER BY display_name, resource_id');
    const buildings = all<Row>(raw, 'SELECT * FROM building_resolved ORDER BY display_name, catalog_key');
    const rules = all<Row>(raw, 'SELECT * FROM core_result_rules WHERE company_id=? ORDER BY is_builtin DESC, target', [companyId]);
    return { company, settings: getSettings(raw), resources, buildings, rules, authEnabled: config.AUTH_ENABLED };
  });

  app.put('/api/settings/company', async (request, reply) => {
    const { id: companyId } = realmCompany(raw, request);
    const body = (request.body ?? {}) as { name?: unknown };
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 120) return reply.code(400).send({ error: 'Company name must be 1-120 characters.' });
    raw.prepare('UPDATE companies SET name=?, updated_at=? WHERE id=?').run(name, nowIso(), companyId);
    return { ok: true, name };
  });

  app.put('/api/settings/value', async (request, reply) => {
    const body = (request.body ?? {}) as { key?: unknown; value?: unknown };
    const key = String(body.key ?? '');
    const allowed = new Set(['display.timezone', 'display.currencySymbol', 'display.theme', 'dashboard.showUnreconciledTail']);
    if (!allowed.has(key)) return reply.code(400).send({ error: 'Setting is not editable.' });

    let value = body.value;
    if (key === 'display.theme') {
      if (!['system', 'dark', 'light'].includes(String(value))) {
        return reply.code(400).send({ error: 'Theme must be system, dark, or light.' });
      }
      value = String(value);
    } else if (key === 'display.timezone') {
      const zone = String(value ?? '').trim();
      if (!zone || zone.length > 80) return reply.code(400).send({ error: 'Timezone is invalid.' });
      if (!['browser', 'local'].includes(zone)) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date()); }
        catch { return reply.code(400).send({ error: 'Use a valid IANA timezone (for example America/Phoenix) or browser.' }); }
      }
      value = zone;
    } else if (key === 'display.currencySymbol') {
      const symbol = String(value ?? '').trim();
      if (!symbol || symbol.length > 8 || /[<>&"']/.test(symbol)) {
        return reply.code(400).send({ error: 'Currency symbol must be 1-8 safe characters.' });
      }
      value = symbol;
    } else if (key === 'dashboard.showUnreconciledTail') {
      if (typeof value !== 'boolean') return reply.code(400).send({ error: 'This setting must be true or false.' });
    }

    raw.prepare(
      `INSERT INTO app_settings (key,value_json,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
    ).run(key, JSON.stringify(value), nowIso());
    return { ok: true, key, value };
  });


  app.put('/api/settings/password', async (request, reply) => {
    if (!config.AUTH_ENABLED) return reply.code(400).send({ error: 'Authentication is disabled.' });
    const session = readSession(request, config.SESSION_SECRET!);
    if (!session) return reply.code(401).send({ error: 'Authentication required.' });
    const body = (request.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = String(body.currentPassword ?? '');
    const newPassword = String(body.newPassword ?? '');
    if (newPassword.length < 12) return reply.code(400).send({ error: 'New password must be at least 12 characters.' });
    const user = one<{ id: number; password_hash: string }>(raw, 'SELECT id, password_hash FROM app_users WHERE id=?', [session.uid]);
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return reply.code(400).send({ error: 'Current password is incorrect.' });
    }
    raw.prepare('UPDATE app_users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), user.id);
    return { ok: true };
  });


  app.put('/api/settings/resource/:id', async (request, reply) => {
    const id = int((request.params as { id: string }).id, -1);
    const body = (request.body ?? {}) as { displayName?: unknown; note?: unknown };
    const name = String(body.displayName ?? '').trim();
    if (id < 0 || !name) return reply.code(400).send({ error: 'Resource id and display name are required.' });
    await setResourceOverride(qb, id, name, body.note ? String(body.note) : null);
    return { ok: true };
  });

  app.delete('/api/settings/resource/:id', async (request) => {
    await clearResourceOverride(qb, int((request.params as { id: string }).id));
    return { ok: true };
  });

  app.put('/api/settings/building/:key', async (request, reply) => {
    const key = decodeURIComponent((request.params as { key: string }).key);
    const body = (request.body ?? {}) as { displayName?: unknown; note?: unknown };
    const name = String(body.displayName ?? '').trim();
    if (!key || !name) return reply.code(400).send({ error: 'Building key and display name are required.' });
    await setBuildingOverride(qb, key, name, body.note ? String(body.note) : null);
    return { ok: true };
  });

  app.delete('/api/settings/building/:key', async (request) => {
    await clearBuildingOverride(qb, decodeURIComponent((request.params as { key: string }).key));
    return { ok: true };
  });

  app.get('/api/raw/:dataset', async (request, reply) => {
    const { id: companyId } = realmCompany(raw, request);
    const dataset = (request.params as { dataset: string }).dataset;
    const tables: Record<string, { table: string; order: string; company?: boolean }> = {
      transactions: { table: 'account_transactions', order: 'occurred_at_us DESC', company: true },
      income: { table: 'income_statement_facts', order: 'snapshot_at_us DESC', company: true },
      cashflow: { table: 'cashflow_statement_facts', order: 'snapshot_at_us DESC', company: true },
      balance: { table: 'balance_sheet_facts', order: 'snapshot_at_us DESC', company: true },
      imports: { table: 'import_files', order: 'created_at DESC', company: true },
      revisions: { table: 'statement_revisions', order: 'id DESC', company: false },
    };
    const conf = tables[dataset];
    if (!conf) return reply.code(404).send({ error: 'Unknown dataset.' });
    const q = request.query as Record<string, unknown>;
    const page = Math.max(1, int(q['page'], 1));
    const pageSize = Math.min(100, Math.max(10, int(q['pageSize'], 50)));
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (conf.company) { clauses.push('company_id=?'); params.push(companyId); }
    if (dataset === 'revisions') { clauses.push('period_id IN (SELECT id FROM statement_periods WHERE company_id=?)'); params.push(companyId); }

    const searchable: Record<string, string[]> = {
      transactions: ['description', 'category', 'product_name', 'building_name', 'counterparty_name', 'raw_row_json'],
      imports: ['original_filename', 'detected_type', 'status', 'warnings_json', 'error_message'],
      revisions: ['values_json', 'raw_row_json', 'unknown_columns_json'],
    };
    const search = typeof q['search'] === 'string' ? q['search'].trim() : '';
    const searchColumns = searchable[dataset] ?? [];
    if (search && searchColumns.length > 0) {
      clauses.push(`(${searchColumns.map((column) => `COALESCE(CAST(${column} AS TEXT),'') LIKE ?`).join(' OR ')})`);
      const like = `%${search}%`;
      for (let i = 0; i < searchColumns.length; i += 1) params.push(like);
    }

    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const tableColumns = new Set(
      (raw.prepare(`PRAGMA table_info(${conf.table})`).all() as Array<{ name: string }>).map((column) => column.name),
    );
    const requestedSort = typeof q['sort'] === 'string' ? q['sort'] : '';
    const direction = String(q['dir'] ?? '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const order = tableColumns.has(requestedSort)
      ? `"${requestedSort.replace(/"/g, '""')}" ${direction}`
      : conf.order;

    const total = int(one<{ count: number }>(raw, `SELECT COUNT(*) count FROM ${conf.table}${where}`, params)?.count);
    const rows = all<Row>(raw, `SELECT * FROM ${conf.table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    return { rows, page, pageSize, total, pages: Math.ceil(total / pageSize), sort: requestedSort || null, dir: direction.toLowerCase() };
  });

  app.get('/api/export/:dataset.csv', async (request, reply) => {
    const { id: companyId, realm } = realmCompany(raw, request);
    const dataset = (request.params as { dataset: string }).dataset;
    const queries: Record<string, string> = {
      transactions: 'SELECT * FROM account_transactions WHERE company_id=? ORDER BY occurred_at_us DESC',
      income: `SELECT p.snapshot_date, p.snapshot_at, f.* FROM income_statement_facts f JOIN statement_periods p ON p.id=f.period_id WHERE f.company_id=? ORDER BY f.snapshot_at_us DESC`,
      cashflow: `SELECT p.snapshot_date, p.snapshot_at, f.* FROM cashflow_statement_facts f JOIN statement_periods p ON p.id=f.period_id WHERE f.company_id=? ORDER BY f.snapshot_at_us DESC`,
      balance: `SELECT p.snapshot_date, p.snapshot_at, f.* FROM balance_sheet_facts f JOIN statement_periods p ON p.id=f.period_id WHERE f.company_id=? ORDER BY f.snapshot_at_us DESC`,
      products: `SELECT product_name product, COUNT(*) transactions, SUM(money) net_cash FROM account_transactions WHERE company_id=? AND product_name IS NOT NULL GROUP BY product_name ORDER BY product_name`,
    };
    const sql = queries[dataset];
    if (!sql) return reply.code(404).send({ error: 'Unknown export dataset.' });
    const csv = toCsv(all<Row>(raw, sql, [companyId]));
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="ledger-${realm}-${dataset}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(csv);
  });

  app.get('/api/backup', async (_request, reply) => {
    const backupDir = path.join(config.DATA_DIR, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ascendant-ledger-${stamp}.db`;
    const destination = path.join(backupDir, filename);
    await backupTo(raw, destination);
    reply.header('Content-Type', 'application/vnd.sqlite3');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(fs.createReadStream(destination));
  });
}
