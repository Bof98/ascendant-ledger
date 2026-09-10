import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database, RealmCode } from '../db/types.js';
import type { Db } from '../db/connection.js';
import type { AppConfig } from '../config/env.js';
import { commitBatch, previewFiles, type UploadedFile } from '../import/pipeline.js';

const ORIGIN = 'https://www.simcompanies.com';
interface Cookie { name: string; value: string; domain: string; path?: string; expires?: number; secure?: boolean }
export interface CsvSyncState {
  lastAttempt: string; lastSuccess: string | null; nextAttempt: string;
  error: string | null; batchId: string | null; transactionsAdded: number;
  files: Array<{ filename: string; sha256: string; bytes: number; rows: number }>;
}
const keyFor = (realm: string) => `csv-sync:${realm}`;
export function readCsvSyncState(raw: Db, realm: string): CsvSyncState | null {
  const saved = raw.prepare('SELECT value_json FROM app_settings WHERE key=?').get(keyFor(realm)) as { value_json: string } | undefined;
  return saved ? JSON.parse(saved.value_json) : null;
}
function saveState(raw: Db, realm: string, state: CsvSyncState): void {
  raw.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(keyFor(realm), JSON.stringify(state), new Date().toISOString());
}

/** Send only cookies scoped to the fixed SimCompanies origin and request path. */
export function exportCookies(cookies: Cookie[], pathname: string, now = Date.now()): string {
  return cookies.filter(c => {
    const domain = c.domain.toLowerCase();
    const matches = domain === 'www.simcompanies.com' || domain === '.www.simcompanies.com' || domain === '.simcompanies.com';
    const cp = c.path || '/';
    return matches && (pathname === cp || pathname.startsWith(cp.endsWith('/') ? cp : cp + '/'))
      && (c.expires === undefined || c.expires === -1 || c.expires * 1000 > now)
      && /^[!#$%&'*+.^_`|~\w-]+$/.test(c.name) && !/[;\r\n]/.test(c.value);
  }).map(c => `${c.name}=${c.value}`).join('; ');
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel(); throw new Error('CSV export exceeds the configured size limit');
  }
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new Error('Empty CSV response');
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('CSV export exceeds the configured size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function downloadCsvExports(config: AppConfig, request: typeof fetch = fetch): Promise<UploadedFile[]> {
  if (!config.CSV_STORAGE_STATE_PATH || !config.CSV_COMPANY_ID) throw new Error('Automatic CSV downloads are not configured');
  let cookies: Cookie[];
  try {
    const state = JSON.parse(fs.readFileSync(config.CSV_STORAGE_STATE_PATH, 'utf8')) as { cookies?: Cookie[] };
    if (!Array.isArray(state.cookies)) throw new Error();
    cookies = state.cookies;
  } catch { throw new Error('The saved SimCompanies login session could not be read'); }
  async function get(pathname: string, csv = false): Promise<Response> {
    const cookie = exportCookies(cookies, pathname);
    if (!cookie) throw new Error('The saved SimCompanies login session has expired; sign in again in the capture service');
    let response: Response;
    try {
      response = await request(ORIGIN + pathname, { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(config.CSV_DOWNLOAD_TIMEOUT_MS),
        headers: { Cookie: cookie, Accept: csv ? 'text/csv' : 'application/json', 'Accept-Language': 'en-US,en;q=0.9' } });
    } catch { throw new Error('SimCompanies download failed or redirected to login; check the saved session'); }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) throw new Error('SimCompanies needs a renewed login session for CSV downloads');
      throw new Error(`SimCompanies CSV request returned HTTP ${response.status}; will retry later`);
    }
    return response;
  }
  async function verifyCompany(): Promise<void> {
    const response = await get('/api/v3/companies/auth-data/');
    if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel(); throw new Error('SimCompanies returned a login page instead of company identity'); }
    const data = JSON.parse((await boundedBody(response, 2_000_000)).toString('utf8')) as { authCompany?: { companyId?: number; realmId?: number } };
    if (data.authCompany?.companyId !== config.CSV_COMPANY_ID || data.authCompany?.realmId !== (config.OPERATIONS_REALM === 'magnates' ? 0 : 1)) {
      throw new Error('The saved session is signed into a different company or realm; no CSVs were imported');
    }
  }
  await verifyCompany();
  const files: UploadedFile[] = [];
  for (const [filename, pathname] of [
    ['simcompanies-account-history.csv', `/csv/account-history/${config.CSV_COMPANY_ID}/`],
    ['simcompanies-income-statement.csv', '/csv/income-statement/'],
    ['simcompanies-balance-sheet.csv', '/csv/balance-sheet/'],
    ['simcompanies-cashflow-statement.csv', '/csv/cashflow-statement/'],
  ]) {
    const response = await get(pathname!, true);
    if (!response.headers.get('content-type')?.split(';')[0]?.toLowerCase().includes('csv')) {
      await response.body?.cancel(); throw new Error('SimCompanies returned a page instead of a CSV export');
    }
    files.push({ originalFilename: filename!, content: await boundedBody(response, config.MAX_UPLOAD_BYTES) });
  }
  // The session may have been switched elsewhere while the downloads ran.
  await verifyCompany();
  return files;
}

export async function importDownloadedCsvs(raw: Db, qb: Kysely<Database>, config: AppConfig, files: UploadedFile[]): Promise<Pick<CsvSyncState, 'batchId' | 'transactionsAdded' | 'files'>> {
  const realm: RealmCode = config.OPERATIONS_REALM;
  const company = raw.prepare('SELECT id FROM companies WHERE realm=?').get(realm) as { id: number } | undefined;
  if (!company) throw new Error('CSV destination realm is unavailable');
  const previews = await previewFiles(qb, company.id, files);
  const expected = ['account_history', 'income_statement', 'balance_sheet', 'cashflow_statement'];
  if (files.length !== 4 || previews.some((p, i) => p.detection.type !== expected[i] || p.rowsInvalid > 0 || p.rowsTotal === 0)) {
    throw new Error('Downloaded CSVs failed validation; no files were imported');
  }
  const archive = path.join(config.DATA_DIR, 'csv-downloads', realm);
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  const saved = files.map((file, i) => {
    const hash = createHash('sha256').update(file.content).digest('hex');
    // Hash filenames retain the exact original bytes and deduplicate unchanged exports.
    const filename = `${hash}-${file.originalFilename}`;
    const destination = path.join(archive, filename);
    if (!fs.existsSync(destination)) {
      const temporary = destination + '.tmp';
      fs.writeFileSync(temporary, file.content, { mode: 0o600 });
      fs.renameSync(temporary, destination);
    }
    return { filename, sha256: hash, bytes: Buffer.byteLength(file.content), rows: previews[i]!.rowsTotal };
  });
  // A byte-identical committed file adds no revisions or import batches.
  const changed = files.filter((_, i) => !previews[i]!.alreadyImportedFile);
  if (!changed.length) return { batchId: null, transactionsAdded: 0, files: saved };
  const result = await commitBatch(qb, company.id, changed, { note: 'Automatically downloaded original CSV exports from SimCompanies. Exact files retained on the server; official CSV statements take precedence over saved screen captures.' });
  return { batchId: result.batchId, transactionsAdded: result.transactionsInserted, files: saved };
}

export function registerCsvSync(app: FastifyInstance, raw: Db, qb: Kysely<Database>, config: AppConfig): void {
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const enabled = Boolean(config.CSV_STORAGE_STATE_PATH);
  async function run(): Promise<void> {
    const previous = readCsvSyncState(raw, config.OPERATIONS_REALM);
    const state: CsvSyncState = { lastAttempt: new Date().toISOString(), lastSuccess: previous?.lastSuccess ?? null,
      nextAttempt: new Date(Date.now() + config.CSV_SYNC_INTERVAL_MS).toISOString(), error: null,
      batchId: previous?.batchId ?? null, transactionsAdded: 0, files: previous?.files ?? [] };
    try {
      const result = await importDownloadedCsvs(raw, qb, config, await downloadCsvExports(config));
      Object.assign(state, result, { batchId: result.batchId ?? previous?.batchId ?? null, lastSuccess: new Date().toISOString() });
    } catch (error) {
      // Network errors are sanitized above; do not log cookie state or response bodies.
      state.error = (error as Error).message;
      app.log.warn({ message: state.error }, 'Automatic CSV download did not complete');
    }
    saveState(raw, config.OPERATIONS_REALM, state);
  }
  const tick = () => {
    if (running) return;
    const state = readCsvSyncState(raw, config.OPERATIONS_REALM);
    if (state && Date.parse(state.nextAttempt) > Date.now()) return;
    running = run().finally(() => { running = null; });
  };
  app.get('/api/csv-sync', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const realm = String((request.query as { realm?: string }).realm ?? 'magnates');
    if (!['magnates', 'entrepreneurs'].includes(realm)) return reply.code(400).send({ error: 'Invalid realm' });
    return { enabled: enabled && realm === config.OPERATIONS_REALM, intervalSeconds: config.CSV_SYNC_INTERVAL_MS / 1000,
      running: Boolean(running) && realm === config.OPERATIONS_REALM, state: readCsvSyncState(raw, realm) };
  });
  if (enabled) {
    app.addHook('onListen', async () => { tick(); timer = setInterval(tick, 60_000); timer.unref(); });
    app.addHook('onClose', async () => { clearInterval(timer); await running; });
  }
}
