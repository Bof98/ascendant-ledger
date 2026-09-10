import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import Fastify from 'fastify';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createQueryBuilder } from '../db/kysely.js';
import { buildConfig } from '../config/env.js';
import { commitBatch, rollbackBatch } from '../import/pipeline.js';
import { capturedDate, adaptStatement, statementFile, type Capture, type CapturedStatement } from './capture-adapter.js';
import { runIdentityChecks } from '../quality/identities.js';
import { registerCaptureSync, syncCaptures } from './capture-sync.js';

let dir: string, source: Sqlite.Database, raw: Sqlite.Database;
let qb: ReturnType<typeof createQueryBuilder>;
const at = '2026-01-03T12:00:00Z';
const report = (values: Record<string, number>): CapturedStatement => ({
  period: '1:00 AM 1/1 to 1:00 AM 1/2', as_of: '1:00 AM 01/02/26',
  rows: Object.entries(values).map(([label, value]) => ({ k: 'r', label, value })),
});
const income = () => report({
  Sales: 1000, 'Cost of goods sold': -600, 'Freight Out': -20, 'Construction costs': 0, 'Exchange fees': -10,
  Salaries: 0, Training: 0, Poaching: 0, 'Game income': 0, 'Executive royalties': 10, 'Gain on sale': 20,
  'Patent conversion': 0, 'Accounting overhead': 0, Donations: 0, 'Interest income': 0, 'Interest expense': 0,
  'Write offs': 0, Defaults: 0, 'NET INCOME': 400, 'Other comprehensive income': -5,
  'TOTAL COMPREHENSIVE INCOME': 395, 'Operating profit': 400, 'Capital charge': -5,
});
const balance = () => report({
  Cash: 100, 'Cash reserved for orders': 20, 'Accounts receivable': 0, Materials: 0, Research: 0,
  'Work in process': 0, 'Finished goods': 0, 'Valuation allowance': 0, Deposits: 0, 'Investment in bonds': 0,
  Buildings: 200, 'Construction in progress': 30, Patents: 0, 'Bonds Payable': 0,
  'Contributed Capital': 250, 'Retained earnings': 100, 'TOTAL ASSETS': 350,
  'TOTAL DEBT AND EQUITY': 350, 'COMPANY VALUE': 350,
});
const cashflow = () => report({
  'From retail': 100, 'From customers': 0, 'From exchange': 0, 'From interest': 0, 'From poaching': 0,
  'From royalties': 10, 'From employees': 5, 'To suppliers': 0, 'To exchange': -50, 'To employees': -10,
  'To executives': 0, 'For interest': 0, 'For fees': -5, 'For accounting': 0, 'For PA quests': -3,
  'Investment in bonds': 0, Bonds: 0, 'From game': 0, 'TOTAL CHANGE IN CASH': 46,
});
function capture(payload: unknown): number {
  return Number(source.prepare('INSERT INTO game_snapshots(payload,captured_at,source) VALUES(?,?,?)').run(JSON.stringify(payload), at, 'browser').lastInsertRowid);
}
function transaction(id: number, timestamp = at, amount = -12) {
  source.prepare('INSERT INTO cashflow_entries VALUES(?,?,?,?,?,?,?,?)').run(id, timestamp, amount, 'm', 'Bought Widgets on market', 'marketbuy-1', '{"amount":4,"price":3}', at);
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-capture-test-'));
  raw = openDatabase({ path: path.join(dir, 'ledger.db') });
  migrate(raw); qb = createQueryBuilder(raw);
  source = new Sqlite(path.join(dir, 'source.db'));
  source.exec(`CREATE TABLE game_snapshots(id INTEGER PRIMARY KEY,payload TEXT,captured_at TEXT,source TEXT);
    CREATE TABLE cashflow_entries(entry_id INTEGER PRIMARY KEY,occurred_at TEXT,money REAL,category TEXT,description TEXT,description_key TEXT,details TEXT,captured_at TEXT);`);
});
afterEach(async () => { vi.unstubAllGlobals(); source.close(); await qb.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
const sync = () => syncCaptures(raw, qb, path.join(dir, 'source.db'), 'magnates');

it('anchors yearless statement dates to capture time across New Year and rejects invalid dates', () => {
  expect(capturedDate('1:00 AM 12/31', '2026-01-02T01:00:00Z')).toBe('2025-12-31T01:00:00.000Z');
  expect(capturedDate('1:00 AM 01/02/26', at)).toBe('2026-01-02T01:00:00.000Z');
  expect(() => capturedDate('1:00 AM 2/30', at)).toThrow();
  expect(() => capturedDate('1:00 AM 01/04/26', at)).toThrow();
});
it('backfills all reports with source provenance, exact totals, separate realms and no duplicate captures', async () => {
  const payload = { income_statement: income(), balance_sheet: balance(), cashflow_statement: cashflow() };
  capture(payload); capture(payload); transaction(10);
  const first = await sync();
  expect(first).toMatchObject({ transactionsAdded: 1, statementsAdded: 3, skipped: 0 });
  expect(raw.prepare('SELECT gross_profit,net_income,computed_net_income FROM income_statement_facts').get()).toEqual({ gross_profit: 380, net_income: 400, computed_net_income: 400 });
  expect(raw.prepare('SELECT total_assets,balance_delta FROM balance_sheet_facts').get()).toEqual({ total_assets: 350, balance_delta: 0 });
  expect(raw.prepare('SELECT net_cash_flow,rounding_adjustment,unclassified_net FROM cashflow_statement_facts').get()).toEqual({ net_cash_flow: 46, rounding_adjustment: -1, unclassified_net: 0 });
  const tx = raw.prepare('SELECT category,product_name,raw_row_json FROM account_transactions').get() as Record<string, string>;
  expect(tx).toMatchObject({ category: 'market', product_name: 'Widgets' });
  expect(JSON.parse(tx.raw_row_json!)).toMatchObject({ 'Source category': 'm', 'Source description key': 'marketbuy-1' });
  expect(raw.prepare('SELECT count(*) n FROM account_transactions WHERE company_id=2').get()).toEqual({ n: 0 });
  capture(payload);
  expect(await sync()).toMatchObject({ transactionsAdded: 0, statementsAdded: 0 });
  expect(raw.prepare('SELECT count(*) n FROM statement_revisions').get()).toEqual({ n: 3 });
  expect(raw.prepare('SELECT count(*) n FROM import_batches').get()).toEqual({ n: 1 });
  // A late historical transaction with a smaller ID must still arrive.
  transaction(2, '2025-12-30T12:00:00Z');
  expect(await sync()).toMatchObject({ transactionsAdded: 1, statementsAdded: 0 });
  expect(raw.prepare("SELECT period_start_at,is_inception FROM statement_periods WHERE statement_type='income_statement'").get()).toEqual({ period_start_at: '2026-01-01T01:00:00.000Z', is_inception: 0 });
});
it('retains valid reports when a partial or unsupported capture arrives', async () => {
  capture({ income_statement: income() }); await sync();
  const invalid = income(); invalid.rows!.pop();
  capture({ income_statement: invalid });
  capture({ income_statement: { period: income().period, rows: [{ k: 'h', text: 'Preparing this statement' }] } });
  expect(await sync()).toMatchObject({ skipped: 1, statementsAdded: 0 });
  expect(raw.prepare('SELECT net_income FROM income_statement_facts').get()).toEqual({ net_income: 400 });
});
it('does not advance the cursor or import a partial batch when a transaction is invalid', async () => {
  transaction(10, at, 0.25); capture({ income_statement: income() });
  await expect(sync()).rejects.toThrow('validation');
  expect(raw.prepare('SELECT count(*) n FROM import_batches').get()).toEqual({ n: 0 });
  expect(raw.prepare("SELECT count(*) n FROM app_settings WHERE key='capture-sync:magnates'").get()).toEqual({ n: 0 });
});
it('preserves captured period starts and values through an overlapping import and rollback', async () => {
  capture({ income_statement: income() }); await sync();
  const changed = income(); changed.rows!.find(r => r.label === 'Sales')!.value = 1100;
  changed.rows!.find(r => r.label === 'NET INCOME')!.value = 500;
  const record = adaptStatement('income_statement', changed, { id: 99, captured_at: at, source: 'browser', payload: '' } as Capture)!;
  const batch = await commitBatch(qb, 1, [statementFile('income_statement', [record])]);
  await rollbackBatch(qb, 1, batch.batchId);
  expect(raw.prepare('SELECT net_income FROM income_statement_facts').get()).toEqual({ net_income: 400 });
  expect(raw.prepare('SELECT period_start_at FROM statement_periods').get()).toEqual({ period_start_at: '2026-01-01T01:00:00.000Z' });
});
it('refuses automatic sync when the source realm differs, and exposes the failure', async () => {
  transaction(10);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ api: { realm: 1 } }), { status: 200 })));
  const app = Fastify();
  registerCaptureSync(app, raw, qb, buildConfig({ OPERATIONS_URL: 'http://localhost:5010', OPERATIONS_DB_PATH: path.join(dir, 'source.db') }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    await vi.waitFor(async () => expect((await app.inject('/api/capture-sync')).json().error).toContain('realm'));
    expect(raw.prepare('SELECT count(*) n FROM account_transactions').get()).toEqual({ n: 0 });
    expect((await app.inject('/api/capture-sync?realm=entrepreneurs')).json().enabled).toBe(false);
  } finally { await app.close(); }
});

it('reconciles receivables against retail, exchange and customer cash receipts together', async () => {
  for (const day of [1, 2, 3]) {
    const bs = balance(), is = income(), cf = cashflow();
    bs.as_of = `1:00 AM 01/0${day}/26`;
    is.period = cf.period = day === 1 ? '1:00 AM 12/31 to 1:00 AM 1/1' : `1:00 AM 1/${day-1} to 1:00 AM 1/${day}`;
    cf.rows!.find(r => r.label === 'From retail')!.value = 600;
    cf.rows!.find(r => r.label === 'From exchange')!.value = 300;
    cf.rows!.find(r => r.label === 'From customers')!.value = 100;
    cf.rows!.find(r => r.label === 'TOTAL CHANGE IN CASH')!.value = 947;
    capture({ income_statement: is, balance_sheet: bs, cashflow_statement: cf });
  }
  await sync();
  const findings = await runIdentityChecks(qb, 1);
  expect(findings.filter(f => f.checkCode === 'accrual_cash_bridge_mismatch')).toEqual([]);
  expect(raw.prepare('SELECT count(*) n FROM balance_sheet_facts').get()).toEqual({ n: 3 });
});
