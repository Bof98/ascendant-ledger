import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Kysely } from 'kysely';
import { openDatabase, type Db } from './db/connection.js';
import { createQueryBuilder } from './db/kysely.js';
import { migrate } from './db/migrate.js';
import type { Database } from './db/types.js';
import { previewFiles, commitBatch, rollbackBatch, type UploadedFile } from './import/pipeline.js';
import Fastify from 'fastify';
import { registerApiRoutes } from './api/routes.js';
import { buildConfig } from './config/env.js';

const ACCOUNT = `id,Timestamp,Category,Money,Description,Details\r\n1001,2026-01-02T12:00:00.000001+00:00,production,-100,Production of Widgets,"{""version"":1,""price"":2.0,""quality"":0,""amount"":50,""building_name"":""Factory""}"\r\n1002,2026-01-02T12:05:00.000001+00:00,sales,200,Sales of Widgets,"{""version"":1,""building"":""G"",""quality"":0,""price"":5.0,""unit_cogs"":2.0,""remaining"":0,""building_name"":""Grocery store""}"\r\n1003,2026-01-02T12:10:00.000001+00:00,market,-60,Bought Inputs on market,"{""version"":1,""amount"":10,""price"":6.0,""sellers"":""Example Supplier""}"\r\n1004,2026-01-02T12:15:00.000001+00:00,market,80,Widgets market order filled,"{""version"":1,""resource"":99,""amount"":10,""quality"":0,""price"":8.0,""buyer"":""Example Buyer"",""profit"":20}"\r\n`;

const INCOME = `Timestamp,Sales,COGS,Freight Out,Construction,Exchange Fees,Salaries,Training,Poaching,Achievements Referrals PA,Patent Conversion,Bond Defaults,Bond Writeoffs,Accounting Overhead,Bond Interest Expense,Bond Interest Income,Donations,Other Comprehensive Income,NetIncome\r\n2026-01-02T01:00:00.000001+00:00,1000,-600,0,0,-10,-40,0,0,100,0,0,0,0,0,0,0,0,450\r\n`;

const CASHFLOW = `Timestamp,All income,All expenses,From retail,From customers,From exchange,From interest,From poaching,To suppliers,To exchange,To employees,To executives,For interest,For fees,For accounting,Investment in bonds,Bonds,Game income\r\n2026-01-02T01:00:00.000001+00:00,1100,-650,1000,0,0,0,0,-600,0,-40,0,0,-10,0,0,0,100\r\n`;

const BALANCE = `Timestamp,Cash,Accounts Receivable,Inventory - materials,Inventory - research,Inventory - work in process,Inventory - finished goods,Inventory - valuation allowance,Deposits,Investment in bonds,Buildings,Patents,Liabilities,Contributed Capital,Retained Earnings\r\n2026-01-02T01:00:00.000001+00:00,500,100,400,0,0,0,0,0,0,1000,0,200,1000,800\r\n`;

const files = (): UploadedFile[] => [
  { originalFilename: 'account-history-example.csv', content: ACCOUNT },
  { originalFilename: 'income-example.csv', content: INCOME },
  { originalFilename: 'cashflow-example.csv', content: CASHFLOW },
  { originalFilename: 'balance-example.csv', content: BALANCE },
];

let dir: string;
let raw: Db;
let db: Kysely<Database>;
let magnatesId: number;
let entrepreneursId: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ascendant-ledger-public-test-'));
  raw = openDatabase({ path: path.join(dir, 'test.db') });
  migrate(raw, { dir: path.resolve(import.meta.dirname, 'db/migrations') });
  db = createQueryBuilder(raw);
  const rows = raw.prepare('SELECT id, realm FROM companies ORDER BY id').all() as Array<{ id: number; realm: string }>;
  magnatesId = rows.find((row) => row.realm === 'magnates')!.id;
  entrepreneursId = rows.find((row) => row.realm === 'entrepreneurs')!.id;
});

afterEach(async () => {
  await db.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('public fresh install', () => {
  async function apiGet(url: string, asText = false) {
    const app = Fastify();
    registerApiRoutes({ app, raw, qb: db, config: buildConfig({ DATA_DIR: dir }) });
    try {
      const response = await app.inject(url);
      expect(response.statusCode).toBe(200);
      return asText ? response.body : response.json();
    } finally { await app.close(); }
  }

  it('keeps absent financial data distinct from zero and does not claim a balance check', async () => {
    const report = await apiGet('/api/dashboard');
    expect(report.kpis.cash).toBeNull();
    expect(report.kpis.netIncome).toBeNull();
    expect(report.kpis.netCashFlow).toBeNull();
    expect(report.coverage).toEqual({ income: 0, cashflow: 0, balance: 0 });
    expect((await apiGet('/api/quality')).balanceSheetCount).toBe(0);
  });

  it('agrees across statement, dashboard, selected dates, duplicate import and rollback', async () => {
    const input = files();
    input[1]!.content = INCOME.replace(',1000,-600,0,0,-10', ',1000,-600,-20,0,-10').replace(',450', ',430');
    const batch = await commitBatch(db, magnatesId, input);
    const report = await apiGet('/api/dashboard?from=2026-01-02&to=2026-01-02');
    expect(report.kpis).toMatchObject({ sales: 1000, grossProfit: 380, grossMargin: 0.38, netIncome: 430, cash: 500, netCashFlow: 450, transactionCount: 4 });
    const exported = await apiGet('/api/export/transactions.csv', true);
    expect(exported).toContain(',-100,');
    expect(exported).not.toContain(",'-100,");
    const statement = await apiGet('/api/statements/income');
    expect(statement.rows[0].gross_profit).toBe(report.kpis.grossProfit);
    expect((await apiGet('/api/dashboard?from=2026-01-03&to=2026-01-03')).kpis.cash).toBeNull();
    expect((await apiGet('/api/dashboard?realm=entrepreneurs')).kpis.sales).toBeNull();
    expect((await previewFiles(db, magnatesId, input))[0]!.rowsDuplicate).toBe(4);
    await rollbackBatch(db, magnatesId, batch.batchId);
    expect((await apiGet('/api/dashboard')).kpis.cash).toBeNull();
  });

  it('upgrades a populated ledger without changing official net income or imported rows', async () => {
    const oldDir = path.join(dir, 'old-migrations');
    fs.mkdirSync(oldDir);
    const migrationDir = path.resolve(import.meta.dirname, 'db/migrations');
    for (const name of fs.readdirSync(migrationDir).filter(name => name < '0010')) {
      fs.copyFileSync(path.join(migrationDir, name), path.join(oldDir, name));
    }
    const existing = openDatabase({ path: path.join(dir, 'upgrade.db') });
    migrate(existing, { dir: oldDir });
    const existingQb = createQueryBuilder(existing);
    try {
      await commitBatch(db, magnatesId, [{ originalFilename: 'income.csv', content: INCOME.replace(',1000,-600,0,0,-10', ',1000,-600,-20,0,-10').replace(',450', ',430') }]);
      // Seed the historical schema using only its writable columns. The current
      // importer deliberately requires the current schema, including new fields.
      for (const table of ['import_batches', 'import_files', 'statement_periods', 'statement_revisions', 'income_statement_facts']) {
        const cols = (existing.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
        for (const row of raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
          existing.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c]));
        }
      }
      expect(existing.prepare('SELECT gross_profit FROM income_statement_facts').get()).toEqual({ gross_profit: 400 });
      migrate(existing, { dir: migrationDir });
      expect(existing.prepare('SELECT gross_profit, net_income FROM income_statement_facts').get()).toEqual({ gross_profit: 380, net_income: 430 });
      expect(existing.prepare('SELECT COUNT(*) count FROM statement_revisions').get()).toEqual({ count: 1 });
    } finally { await existingQb.destroy(); }
  });

  it('creates independent Magnates and Entrepreneurs ledgers', () => {
    const rows = raw.prepare('SELECT name, realm FROM companies ORDER BY id').all() as Array<{ name: string; realm: string }>;
    expect(rows).toEqual([
      { name: 'My Magnates Company', realm: 'magnates' },
      { name: 'My Entrepreneurs Company', realm: 'entrepreneurs' },
    ]);
  });

  it('detects all four supported CSV schemas', async () => {
    const preview = await previewFiles(db, magnatesId, files());
    expect(preview.map((item) => item.detection.type)).toEqual([
      'account_history',
      'income_statement',
      'cashflow_statement',
      'balance_sheet',
    ]);
    expect(preview.every((item) => item.rowsInvalid === 0)).toBe(true);
  });

  it('deduplicates inside a Realm but allows the same game IDs in the other Realm', async () => {
    await commitBatch(db, magnatesId, [files()[0]!]);
    const magnatesPreview = await previewFiles(db, magnatesId, [files()[0]!]);
    const entrepreneursPreview = await previewFiles(db, entrepreneursId, [files()[0]!]);
    expect(magnatesPreview[0]!.rowsDuplicate).toBe(4);
    expect(magnatesPreview[0]!.rowsNew).toBe(0);
    expect(entrepreneursPreview[0]!.rowsDuplicate).toBe(0);
    expect(entrepreneursPreview[0]!.rowsNew).toBe(4);

    await commitBatch(db, entrepreneursId, [files()[0]!]);
    const counts = raw.prepare('SELECT company_id, COUNT(*) count FROM account_transactions GROUP BY company_id ORDER BY company_id').all() as Array<{ company_id: number; count: number }>;
    expect(counts).toEqual([
      { company_id: magnatesId, count: 4 },
      { company_id: entrepreneursId, count: 4 },
    ]);
  });

  it('keeps statement snapshots isolated even when dates match', async () => {
    await commitBatch(db, magnatesId, files().slice(1));
    await commitBatch(db, entrepreneursId, files().slice(1));
    const periods = raw.prepare(`SELECT company_id, statement_type, COUNT(*) count FROM statement_periods GROUP BY company_id, statement_type ORDER BY company_id, statement_type`).all() as Array<{ company_id: number; statement_type: string; count: number }>;
    expect(periods).toHaveLength(6);
    expect(periods.every((row) => row.count === 1)).toBe(true);
  });


  it('ships the required NullBot creator attribution in the public UI', () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), 'web/index.html'), 'utf8');
    const js = fs.readFileSync(path.resolve(process.cwd(), 'web/assets/app.js'), 'utf8');
    expect(html).toContain('Created by NullBot | Copyright 2026');
    expect(js).toContain('Created by NullBot | Copyright 2026');
  });

  it('rolls back only the selected Realm', async () => {
    const magnates = await commitBatch(db, magnatesId, [files()[0]!]);
    await commitBatch(db, entrepreneursId, [files()[0]!]);
    await rollbackBatch(db, magnatesId, magnates.batchId);

    const magCount = (raw.prepare('SELECT COUNT(*) count FROM account_transactions WHERE company_id=?').get(magnatesId) as { count: number }).count;
    const entCount = (raw.prepare('SELECT COUNT(*) count FROM account_transactions WHERE company_id=?').get(entrepreneursId) as { count: number }).count;
    expect(magCount).toBe(0);
    expect(entCount).toBe(4);
  });
});
