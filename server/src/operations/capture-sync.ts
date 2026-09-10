import Sqlite from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database, StatementType } from '../db/types.js';
import type { Db } from '../db/connection.js';
import type { AppConfig } from '../config/env.js';
import { commitBatch, previewFiles, type UploadedFile } from '../import/pipeline.js';
import { adaptStatement, statementFile, transactionFile, type Capture, type CapturedStatement, type CapturedTransaction, type StatementRecord } from './capture-adapter.js';

const types: StatementType[] = ['income_statement', 'cashflow_statement', 'balance_sheet'];
export interface SyncState {
  lastSnapshotId: number; lastSuccess: string | null; batchId: string | null;
  transactionsAdded: number; statementsAdded: number;
  skipped: number; issues: string[];
}
const empty = (): SyncState => ({ lastSnapshotId: 0, lastSuccess: null, batchId: null, transactionsAdded: 0, statementsAdded: 0, skipped: 0, issues: [] });

export async function syncCaptures(raw: Db, qb: Kysely<Database>, sourcePath: string, realm: string): Promise<SyncState> {
  const company = raw.prepare('SELECT id FROM companies WHERE realm=?').get(realm) as { id: number } | undefined;
  if (!company) throw new Error('Capture destination realm is unavailable');
  const key = `capture-sync:${realm}`;
  const saved = raw.prepare('SELECT value_json FROM app_settings WHERE key=?').get(key) as { value_json: string } | undefined;
  const previous: SyncState = saved ? JSON.parse(saved.value_json) : empty();
  const state: SyncState = { ...previous, transactionsAdded: 0, statementsAdded: 0, issues: [...previous.issues] };
  // Never use the ledger connection helper here: it checks writability and sets
  // pragmas intended for our own database. The capture service owns this file.
  const source = new Sqlite(sourcePath, { readonly: true, fileMustExist: true });
  source.pragma('query_only = ON');
  source.pragma('busy_timeout = 5000');
  const records = new Map<string, StatementRecord>();
  let transactions: CapturedTransaction[];
  try {
    const existingIds = new Set((raw.prepare('SELECT external_id FROM account_transactions WHERE company_id=?').all(company.id) as { external_id: number }[]).map(r => r.external_id));
    // Scan IDs, not a timestamp watermark: delayed/backfilled history can arrive out of order.
    transactions = (source.prepare('SELECT * FROM cashflow_entries ORDER BY entry_id').all() as CapturedTransaction[]).filter(row => !existingIds.has(row.entry_id));
    const limit = (source.prepare('SELECT COALESCE(MAX(id),0) id FROM game_snapshots').get() as { id: number }).id;
    if (limit < previous.lastSnapshotId) throw new Error('Capture database was reset; review its realm and reset the sync cursor before importing');
    while (state.lastSnapshotId < limit) {
      const page = source.prepare('SELECT id, payload, captured_at, source FROM game_snapshots WHERE id>? AND id<=? ORDER BY id LIMIT 100').all(state.lastSnapshotId, limit) as Capture[];
      if (!page.length) break;
      for (const capture of page) {
        try {
          const payload = JSON.parse(capture.payload) as Record<string, CapturedStatement>;
          for (const type of types) {
            if (!payload[type]) continue;
            try {
              const record = adaptStatement(type, payload[type], capture);
              if (record) records.set(`${type}:${record.timestamp.slice(0, 10)}`, record);
            } catch (error) {
              state.skipped++;
              const issue = `${type}, snapshot ${capture.id}: ${(error as Error).message}`;
              state.issues = [...state.issues.slice(-9), issue];
            }
          }
        } catch {
          state.skipped++;
          state.issues = [...state.issues.slice(-9), `Snapshot ${capture.id}: invalid saved JSON`];
        }
        state.lastSnapshotId = capture.id;
      }
    }
  } finally { source.close(); }

  const files: UploadedFile[] = [];
  if (transactions!.length) files.push(transactionFile(transactions!));
  for (const type of types) {
    const changed = [...records.values()].filter(record => {
      if (record.type !== type) return false;
      const current = raw.prepare(`SELECT r.values_json, r.raw_row_json FROM statement_periods p JOIN statement_revisions r ON r.id=p.current_revision_id
        WHERE p.company_id=? AND p.statement_type=? AND p.snapshot_date=?`).get(company.id, type, record.timestamp.slice(0, 10)) as { values_json: string; raw_row_json: string } | undefined;
      if (!current) return true;
      // An uploaded/downloaded CSV is authoritative over a rounded screen capture.
      if (JSON.parse(current.raw_row_json)['Source kind'] !== 'saved game capture') return false;
      const values = JSON.parse(current.values_json) as Record<string, number>;
      return Object.entries(record.values).some(([k, value]) => (values[k] ?? 0) !== value);
    });
    if (changed.length) { files.push(statementFile(type, changed)); state.statementsAdded += changed.length; }
  }
  if (files.length) {
    const previews = await previewFiles(qb, company.id, files);
    if (previews.some(p => !p.detection.type || p.rowsInvalid)) throw new Error('Captured data failed import validation; cursor was not advanced');
    const result = await commitBatch(qb, company.id, files, { note: 'Automatic sync from saved game captures (UTC). Generated CSV transport; original source fields retained. Not a downloaded game CSV.' });
    state.batchId = result.batchId;
    state.transactionsAdded = result.transactionsInserted;
  }
  state.lastSuccess = new Date().toISOString();
  // Written only after the import commits. A crash before this write replays
  // safely using transaction IDs and the current statement values.
  raw.prepare(`INSERT INTO app_settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`).run(key, JSON.stringify(state), state.lastSuccess);
  return state;
}

export function registerCaptureSync(app: FastifyInstance, raw: Db, qb: Kysely<Database>, config: AppConfig): void {
  let running: Promise<void> | null = null;
  let lastError: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  async function run(): Promise<void> {
    try {
      // Fail closed if the capture service has switched realms or cannot identify itself.
      const response = await fetch(new URL('api/state', `${config.OPERATIONS_URL!.replace(/\/+$/, '')}/`), {
        signal: AbortSignal.timeout(config.OPERATIONS_TIMEOUT_MS), redirect: 'error',
      });
      if (!response.ok) throw new Error('Capture service is unavailable');
      const upstream = await response.json() as { api?: { realm?: number } };
      const expected = config.OPERATIONS_REALM === 'magnates' ? 0 : 1;
      if (upstream.api?.realm !== expected) throw new Error('Capture realm does not match the configured sync destination');
      await syncCaptures(raw, qb, config.OPERATIONS_DB_PATH!, config.OPERATIONS_REALM);
      lastError = null;
    } catch (error) {
      lastError = (error as Error).message;
      app.log.error({ err: error }, 'Capture sync failed; existing ledger data remains available');
    }
  }
  const tick = () => { if (!running) running = run().finally(() => { running = null; }); };
  app.get('/api/capture-sync', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const realm = String((request.query as { realm?: string }).realm ?? 'magnates');
    if (!['magnates', 'entrepreneurs'].includes(realm)) return reply.code(400).send({ error: 'Invalid realm' });
    const enabled = Boolean(config.OPERATIONS_DB_PATH) && realm === config.OPERATIONS_REALM;
    const saved = raw.prepare('SELECT value_json FROM app_settings WHERE key=?').get(`capture-sync:${realm}`) as { value_json: string } | undefined;
    return { enabled, intervalSeconds: config.CAPTURE_SYNC_INTERVAL_MS / 1000, running: enabled && Boolean(running),
      error: enabled ? lastError : null, state: saved ? JSON.parse(saved.value_json) : null };
  });
  if (config.OPERATIONS_DB_PATH) {
    app.addHook('onListen', async () => { tick(); timer = setInterval(tick, config.CAPTURE_SYNC_INTERVAL_MS); timer.unref(); });
    app.addHook('onClose', async () => { clearInterval(timer); await running; });
  }
}
