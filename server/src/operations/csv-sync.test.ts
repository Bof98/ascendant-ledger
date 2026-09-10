import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { createQueryBuilder } from '../db/kysely.js';
import { buildConfig, type AppConfig } from '../config/env.js';
import { getSignature } from '../import/detect.js';
import { csvFile } from './capture-adapter.js';
import { commitBatch } from '../import/pipeline.js';
import { readCsv } from '../import/csv.js';
import Fastify from 'fastify';
import { registerCsvSync, downloadCsvExports, exportCookies, importDownloadedCsvs } from './csv-sync.js';

let dir: string, config: AppConfig, raw: ReturnType<typeof openDatabase>, qb: ReturnType<typeof createQueryBuilder>;
function fixtures() {
  return (['account_history', 'income_statement', 'balance_sheet', 'cashflow_statement'] as const).map(type => {
    const row: Record<string, unknown> = Object.fromEntries(getSignature(type).known.map(h => [h, '0']));
    row.timestamp = '2026-01-02T01:00:00.123456Z';
    if (type === 'account_history') Object.assign(row, { id: '1234', category: 'market', money: -10, description: 'Bought Widgets on market', details: '{"amount":2,"price":5}' });
    if (type === 'income_statement') Object.assign(row, { sales: 300, cogs: -100, netincome: 200 });
    if (type === 'balance_sheet') Object.assign(row, { cash: 200, 'retained earnings': 200 });
    if (type === 'cashflow_statement') Object.assign(row, { 'all income': 200, 'from retail': 200 });
    return csvFile(`example-${type}.csv`, [row]);
  });
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-csv-test-'));
  const session = path.join(dir, 'session.json');
  fs.writeFileSync(session, JSON.stringify({ cookies: [{ name: 'sessionid', value: 'test-only', domain: '.simcompanies.com', path: '/', expires: -1 }] }));
  config = buildConfig({ DATA_DIR: dir, CSV_STORAGE_STATE_PATH: session, CSV_COMPANY_ID: '123', OPERATIONS_DB_PATH: path.join(dir, 'source.db'), OPERATIONS_URL: 'http://localhost:5010' });
  raw = openDatabase({ path: config.databasePath }); migrate(raw); qb = createQueryBuilder(raw);
});
afterEach(async () => { vi.unstubAllGlobals(); await qb.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
function mockDownload(overrides: { realm?: number; company?: number; status?: number; contentType?: string; finalRealm?: number } = {}) {
  let identity = 0, csv = 0;
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/www\.simcompanies\.com\//);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect((init?.headers as Record<string, string>).Cookie).toBe('sessionid=test-only');
    if (String(url).endsWith('auth-data/')) {
      identity++;
      return new Response(JSON.stringify({ authCompany: { companyId: overrides.company ?? 123, realmId: identity > 1 ? overrides.finalRealm ?? 0 : overrides.realm ?? 0 } }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(fixtures()[csv++]!.content, { status: overrides.status ?? 200, headers: { 'content-type': overrides.contentType ?? 'text/csv' } });
  });
}
it('scopes cookies by host, expiry and path and excludes malformed headers', () => {
  const make = (name: string, extra = {}) => ({ name, value: 'v', domain: '.simcompanies.com', path: '/', expires: -1, ...extra });
  const cookie = exportCookies([make('ok'), make('foreign', { domain: '.other.com' }), make('expired', { expires: 1 }), make('wrongpath', { path: '/signin' }), make('bad', { value: 'v; leaked=1' }), make('hostonly', { domain: 'simcompanies.com' })], '/csv/income-statement/');
  expect(cookie).toBe('ok=v');
});
it('downloads all four exact exports and verifies company/realm before and after', async () => {
  const request = mockDownload();
  const files = await downloadCsvExports(config, request as typeof fetch);
  expect(files).toHaveLength(4);
  expect(request).toHaveBeenCalledTimes(6);
  expect(request.mock.calls[1]![0]).toBe('https://www.simcompanies.com/csv/account-history/123/');
  expect(files[0]!.content.toString()).toBe(fixtures()[0]!.content);
});
it('rejects another company/realm and a realm change during downloads', async () => {
  for (const options of [{ realm: 1 }, { company: 999 }, { finalRealm: 1 }]) {
    await expect(downloadCsvExports(config, mockDownload(options) as typeof fetch)).rejects.toThrow('different company or realm');
  }
});
it('rejects expired sessions, rate limits, login pages and oversized exports', async () => {
  await expect(downloadCsvExports(config, mockDownload({ status: 401 }) as typeof fetch)).rejects.toThrow('renewed login');
  await expect(downloadCsvExports(config, mockDownload({ status: 429 }) as typeof fetch)).rejects.toThrow('429');
  await expect(downloadCsvExports(config, mockDownload({ contentType: 'text/html' }) as typeof fetch)).rejects.toThrow('instead of a CSV');
  await expect(downloadCsvExports({ ...config, MAX_UPLOAD_BYTES: 2 }, mockDownload() as typeof fetch)).rejects.toThrow('size limit');
});
it('archives exact original bytes and deduplicates a repeated download', async () => {
  const files = fixtures();
  const first = await importDownloadedCsvs(raw, qb, config, files);
  expect(first.transactionsAdded).toBe(1);
  expect(first.files).toHaveLength(4);
  first.files.forEach((file, i) => expect(fs.readFileSync(path.join(dir, 'csv-downloads', 'magnates', file.filename), 'utf8')).toBe(files[i]!.content));
  expect(await importDownloadedCsvs(raw, qb, config, files)).toMatchObject({ batchId: null, transactionsAdded: 0 });
  expect(raw.prepare('SELECT count(*) n FROM import_batches').get()).toEqual({ n: 1 });
  expect(raw.prepare('SELECT count(*) n FROM statement_revisions').get()).toEqual({ n: 3 });
  expect(raw.prepare('SELECT count(*) n FROM account_transactions WHERE company_id=2').get()).toEqual({ n: 0 });
});
it('validates the complete download set before importing any file', async () => {
  const files = fixtures(); files[2]!.content = 'unexpected,html\nlogin,page\n';
  await expect(importDownloadedCsvs(raw, qb, config, files)).rejects.toThrow('validation');
  expect(raw.prepare('SELECT count(*) n FROM import_batches').get()).toEqual({ n: 0 });
});
it('prevents a queued screen capture from overwriting an official CSV statement', async () => {
  const files = fixtures(); await importDownloadedCsvs(raw, qb, config, files);
  const row = readCsv(files[1]!.content).rows[0]!.raw;
  row['Source kind'] = 'saved game capture'; row.sales = '999'; row.netincome = '899';
  await commitBatch(qb, 1, [csvFile('captured-income.csv', [row])]);
  expect(raw.prepare('SELECT net_income FROM income_statement_facts').get()).toEqual({ net_income: 200 });
  expect(raw.prepare('SELECT count(*) n FROM statement_revisions').get()).toEqual({ n: 3 });
});

it('preserves captured fields absent from the official export without changing its original bytes', async () => {
  const files = fixtures();
  const capture = readCsv(files[2]!.content).rows[0]!.raw;
  capture.cash = '170'; capture['construction in progress'] = '30'; capture['Source kind'] = 'saved game capture';
  await commitBatch(qb, 1, [csvFile('captured-balance.csv', [capture])]);
  const official = { ...capture }; delete official['Source kind']; delete official['construction in progress'];
  files[2] = csvFile('official-balance.csv', [official]);
  const result = await importDownloadedCsvs(raw, qb, config, files);
  expect(raw.prepare('SELECT cash,construction_in_progress,total_assets,balance_delta FROM balance_sheet_facts').get()).toEqual({ cash: 170, construction_in_progress: 30, total_assets: 200, balance_delta: 0 });
  const revision = raw.prepare("SELECT r.raw_row_json FROM statement_revisions r JOIN statement_periods p ON p.current_revision_id=r.id WHERE p.statement_type='balance_sheet'").get() as { raw_row_json: string };
  expect(JSON.parse(JSON.parse(revision.raw_row_json)['Captured supplemental fields']).values).toEqual({ construction_in_progress: 30 });
  const archive = fs.readFileSync(path.join(dir, 'csv-downloads', 'magnates', result.files[2]!.filename), 'utf8');
  expect(archive).toBe(files[2]!.content);
  expect(archive).not.toContain('construction in progress');
});

it('downloads once per accounting-page capture, ignores other page markers, and persists the visit across restarts', async () => {
  const marker = path.join(dir, 'capture_sources.json');
  fs.writeFileSync(marker, JSON.stringify({ accounting: 1000 }));
  const request = mockDownload(); vi.stubGlobal('fetch', request);
  const start = async () => {
    const app = Fastify(); registerCsvSync(app, raw, qb, config);
    await app.listen({ host: '127.0.0.1', port: 0 }); return app;
  };
  let app = await start();
  try {
    expect(request).not.toHaveBeenCalled();
    expect((await app.inject('/api/csv-sync')).json()).toMatchObject({ trigger: 'accounting_capture', state: { captureTimestamp: 1000, nextAttempt: null } });
    fs.writeFileSync(marker, JSON.stringify({ accounting: 1000, warehouse: 1500 }));
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(request).not.toHaveBeenCalled();
    fs.writeFileSync(marker, JSON.stringify({ accounting: 2000 }));
    await vi.waitFor(async () => expect((await app.inject('/api/csv-sync')).json()).toMatchObject({ running: false, state: { captureTimestamp: 2000, error: null, transactionsAdded: 1 } }), { timeout: 3000 });
    expect(request).toHaveBeenCalledTimes(6);
    fs.writeFileSync(marker, JSON.stringify({ accounting: 2000, finance: 2100 }));
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(request).toHaveBeenCalledTimes(6);
    await app.close(); app = await start();
    expect(request).toHaveBeenCalledTimes(6);
  } finally { await app.close(); }
});

it('does not download on an hourly clock or a status-page read', async () => {
  fs.writeFileSync(path.join(dir, 'capture_sources.json'), JSON.stringify({ accounting: 1000 }));
  const request = mockDownload(); vi.stubGlobal('fetch', request);
  const app = Fastify(); registerCsvSync(app, raw, qb, config);
  await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    await app.inject('/api/csv-sync');
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(request).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); await app.close(); }
});
