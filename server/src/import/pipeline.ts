import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database, ReportType, StatementType } from '../db/types.js';
import { nowIso, tryParseTimestamp } from '../domain/time.js';
import { observeCatalogEntries } from '../mappings/registry.js';
import { readCsv, type CsvDocument } from './csv.js';
import { detectReportType, getSignature, type DetectionResult } from './detect.js';
import { parseAccountHistoryRows, type StagedTransaction } from './parsers/accountHistory.js';
import { getColumnMap, parseStatementRows, type ParsedStatementRow } from './parsers/statements.js';

/**
 * The import pipeline.
 *
 * Two phases, deliberately separated:
 *
 *   PREVIEW  parses and classifies everything, reads the database to work out
 *            what is new and what is already held, and writes nothing. This is
 *            what backs the Import Center's confirmation panel (spec section 12).
 *
 *   COMMIT   re-parses and writes inside a single transaction per batch. A
 *            failure anywhere rolls the whole batch back, so a half-imported
 *            file can never exist.
 *
 * Duplicate protection differs by report type and both mechanisms are exact:
 *
 *   Account History   `external_id` is unique per company. A row already held is
 *                     counted as a duplicate and left ALONE apart from its
 *                     last-seen provenance. Transaction rows are immutable —
 *                     the game never revises one — so there is nothing to update
 *                     and nothing an overlapping re-export can corrupt.
 *
 *   Statements        keyed on (type, snapshot_date). A re-export of the same
 *                     day appends a new revision and re-materialises. The
 *                     append-only ledger is what makes rollback of an
 *                     overlapping import restore the previous values instead of
 *                     deleting the day.
 */

export interface FilePreview {
  fileId: string;
  originalFilename: string;
  safeFilename: string;
  sha256: string;
  sizeBytes: number;
  detection: DetectionResult;
  rowsTotal: number;
  rowsNew: number;
  rowsDuplicate: number;
  rowsUpdated: number;
  rowsInvalid: number;
  periodStart: string | null;
  periodEnd: string | null;
  warnings: Array<{ code: string; message: string; rowNumber?: number }>;
  errors: Array<{ rowNumber: number; code: string; message: string }>;
  /** True when a byte-identical file was already committed. */
  alreadyImportedFile: boolean;
}

interface ParsedFile {
  document: CsvDocument;
  detection: DetectionResult;
  transactions: StagedTransaction[];
  statementRows: ParsedStatementRow[];
  errors: Array<{ rowNumber: number; code: string; message: string; raw: Record<string, string> }>;
  warnings: Array<{ code: string; message: string; rowNumber?: number }>;
}

export interface UploadedFile {
  originalFilename: string;
  content: Buffer | string;
}

/** Strips directory components and anything awkward. Guards spec section 37. */
export function sanitiseFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'upload.csv';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 180);
  return cleaned === '' ? 'upload.csv' : cleaned;
}

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Parses a file end to end without touching the database. */
function parseFile(file: UploadedFile): ParsedFile {
  const document = readCsv(file.content);
  const detection = detectReportType(document);

  const warnings: ParsedFile['warnings'] = [];
  for (const ragged of document.raggedRows) {
    warnings.push({
      code: 'ragged_row',
      message: `Row ${ragged.rowNumber} had ${ragged.cellCount} cells but the header declares ${document.headers.length}.`,
      rowNumber: ragged.rowNumber,
    });
  }
  if (detection.unknownHeaders.length > 0 && detection.type) {
    warnings.push({
      code: 'unknown_columns',
      message: `Unrecognised columns kept alongside the imported data: ${detection.unknownHeaders.join(', ')}.`,
    });
  }
  if (detection.missingHeaders.length > 0) {
    warnings.push({
      code: 'missing_columns',
      message: `Expected columns absent from this file, stored as 0: ${detection.missingHeaders.join(', ')}.`,
    });
  }

  if (!detection.type) {
    return { document, detection, transactions: [], statementRows: [], errors: [], warnings };
  }

  const knownHeaders = new Set(getSignature(detection.type).known);

  if (detection.type === 'account_history') {
    const result = parseAccountHistoryRows(document.rows, knownHeaders);
    for (const dup of result.intraFileDuplicates) {
      warnings.push({
        code: 'duplicate_id_in_file',
        message: `Transaction id ${dup.externalId} appears on rows ${dup.rowNumbers.join(', ')} of this file. The first occurrence was kept.`,
      });
    }
    return {
      document,
      detection,
      transactions: result.rows,
      statementRows: [],
      errors: result.errors,
      warnings,
    };
  }

  const result = parseStatementRows(detection.type, document.rows, knownHeaders);
  for (const row of result.rows) {
    for (const w of row.warnings) warnings.push(w);
  }
  return {
    document,
    detection,
    transactions: [],
    statementRows: result.rows,
    errors: result.errors,
    warnings,
  };
}

function periodBounds(parsed: ParsedFile): { start: string | null; end: string | null } {
  const stamps =
    parsed.transactions.length > 0
      ? parsed.transactions.map((t) => t.occurredAt.iso)
      : parsed.statementRows.map((r) => r.timestamp.iso);
  if (stamps.length === 0) return { start: null, end: null };
  stamps.sort();
  return { start: stamps[0]!, end: stamps[stamps.length - 1]! };
}

/** Builds the Import Center preview. Read-only. */
export async function previewFiles(
  db: Kysely<Database>,
  companyId: number,
  files: readonly UploadedFile[],
): Promise<FilePreview[]> {
  const previews: FilePreview[] = [];

  for (const file of files) {
    const hash = sha256(file.content);
    const sizeBytes = Buffer.byteLength(
      typeof file.content === 'string' ? file.content : file.content,
    );

    const priorFile = await db
      .selectFrom('import_files')
      .select(['id'])
      .where('company_id', '=', companyId)
      .where('file_sha256', '=', hash)
      .where('status', '=', 'committed')
      .executeTakeFirst();

    let parsed: ParsedFile;
    try {
      parsed = parseFile(file);
    } catch (error) {
      previews.push({
        fileId: randomUUID(),
        originalFilename: file.originalFilename,
        safeFilename: sanitiseFilename(file.originalFilename),
        sha256: hash,
        sizeBytes,
        detection: {
          type: null,
          label: 'Unreadable',
          score: 0,
          method: 'header_signature',
          unknownHeaders: [],
          missingHeaders: [],
          candidates: [],
        },
        rowsTotal: 0,
        rowsNew: 0,
        rowsDuplicate: 0,
        rowsUpdated: 0,
        rowsInvalid: 0,
        periodStart: null,
        periodEnd: null,
        warnings: [],
        errors: [
          {
            rowNumber: 0,
            code: 'unreadable_file',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        alreadyImportedFile: Boolean(priorFile),
      });
      continue;
    }

    let rowsNew = 0;
    let rowsDuplicate = 0;
    let rowsUpdated = 0;

    if (parsed.detection.type === 'account_history' && parsed.transactions.length > 0) {
      const ids = parsed.transactions.map((t) => t.externalId);
      const existing = await db
        .selectFrom('account_transactions')
        .select(['external_id'])
        .where('company_id', '=', companyId)
        .where('external_id', 'in', ids)
        .execute();
      const held = new Set(existing.map((r) => r.external_id));
      rowsDuplicate = parsed.transactions.filter((t) => held.has(t.externalId)).length;
      rowsNew = parsed.transactions.length - rowsDuplicate;
    } else if (parsed.detection.type && parsed.statementRows.length > 0) {
      const type = parsed.detection.type as StatementType;
      for (const row of parsed.statementRows) {
        const existing = await db
          .selectFrom('statement_periods')
          .select(['id', 'current_revision_id'])
          .where('company_id', '=', companyId)
          .where('statement_type', '=', type)
          .where('snapshot_date', '=', row.timestamp.utcDate)
          .executeTakeFirst();

        if (!existing) {
          rowsNew += 1;
          continue;
        }

        // An identical re-export is a duplicate; a changed one is an update.
        const currentHash = existing.current_revision_id
          ? (
              await db
                .selectFrom('statement_revisions')
                .select(['row_hash'])
                .where('id', '=', existing.current_revision_id)
                .executeTakeFirst()
            )?.row_hash
          : undefined;

        if (currentHash === stableHash(row.values)) rowsDuplicate += 1;
        else rowsUpdated += 1;
      }
    }

    const bounds = periodBounds(parsed);

    previews.push({
      fileId: randomUUID(),
      originalFilename: file.originalFilename,
      safeFilename: sanitiseFilename(file.originalFilename),
      sha256: hash,
      sizeBytes,
      detection: parsed.detection,
      rowsTotal: parsed.document.rows.length,
      rowsNew,
      rowsDuplicate,
      rowsUpdated,
      rowsInvalid: parsed.errors.length,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      warnings: parsed.warnings,
      errors: parsed.errors.map(({ rowNumber, code, message }) => ({ rowNumber, code, message })),
      alreadyImportedFile: Boolean(priorFile),
    });
  }

  return previews;
}

export interface CommitResult {
  batchId: string;
  files: Array<{
    fileId: string;
    originalFilename: string;
    detectedType: ReportType | null;
    rowsTotal: number;
    rowsInserted: number;
    rowsUpdated: number;
    rowsDuplicate: number;
    rowsInvalid: number;
  }>;
  transactionsInserted: number;
  periodsTouched: number[];
  catalog: { resourcesAdded: number; buildingsAdded: number };
}

/**
 * Commits a batch.
 *
 * The whole batch runs inside one SQLite transaction. Partial success is not a
 * state this application can end up in.
 */
export async function commitBatch(
  db: Kysely<Database>,
  companyId: number,
  files: readonly UploadedFile[],
  options: { note?: string } = {},
): Promise<CommitResult> {
  const batchId = randomUUID();
  const now = nowIso();

  return db.transaction().execute(async (trx) => {
    await trx
      .insertInto('import_batches')
      .values({
        id: batchId,
        company_id: companyId,
        status: 'pending',
        created_at: now,
        committed_at: null,
        rolled_back_at: null,
        file_count: files.length,
        note: options.note ?? null,
      })
      .execute();

    const summaries: CommitResult['files'] = [];
    const periodsTouched = new Set<number>();
    let transactionsInserted = 0;
    let resourcesAdded = 0;
    let buildingsAdded = 0;

    for (const file of files) {
      const fileId = randomUUID();
      const hash = sha256(file.content);
      const parsed = parseFile(file);
      const bounds = periodBounds(parsed);

      await trx
        .insertInto('import_files')
        .values({
          id: fileId,
          batch_id: batchId,
          company_id: companyId,
          original_filename: file.originalFilename,
          safe_filename: sanitiseFilename(file.originalFilename),
          file_sha256: hash,
          file_size_bytes: Buffer.byteLength(file.content as Buffer | string),
          detected_type: parsed.detection.type,
          detection_score: parsed.detection.score,
          detection_method: parsed.detection.method,
          schema_version: 1,
          header_raw_json: JSON.stringify(parsed.document.headers),
          unknown_headers_json: JSON.stringify(parsed.detection.unknownHeaders),
          rows_total: parsed.document.rows.length,
          rows_inserted: 0,
          rows_updated: 0,
          rows_duplicate: 0,
          rows_invalid: parsed.errors.length,
          period_start: bounds.start,
          period_end: bounds.end,
          warnings_json: JSON.stringify(parsed.warnings),
          status: 'pending',
          error_message: null,
          created_at: now,
          committed_at: null,
        })
        .execute();

      // Rejected rows are preserved verbatim (spec section 41).
      for (const error of parsed.errors) {
        await trx
          .insertInto('import_rejected_rows')
          .values({
            import_file_id: fileId,
            row_number: error.rowNumber,
            raw_row_json: JSON.stringify(error.raw),
            error_code: error.code,
            error_message: error.message,
            created_at: now,
          })
          .execute();
      }

      let inserted = 0;
      let updated = 0;
      let duplicate = 0;

      if (parsed.detection.type === 'account_history') {
        const result = await insertTransactions(trx, companyId, batchId, fileId, parsed.transactions, now);
        inserted = result.inserted;
        duplicate = result.duplicate;
        transactionsInserted += result.inserted;

        const catalog = await observeCatalogEntries(trx, parsed.transactions, batchId);
        resourcesAdded += catalog.resourcesAdded;
        buildingsAdded += catalog.buildingsAdded;
      } else if (parsed.detection.type) {
        const result = await appendStatementRevisions(
          trx,
          companyId,
          parsed.detection.type as StatementType,
          batchId,
          fileId,
          parsed.statementRows,
          now,
        );
        inserted = result.inserted;
        updated = result.updated;
        duplicate = result.duplicate;
        for (const id of result.periodIds) periodsTouched.add(id);
      }

      await trx
        .updateTable('import_files')
        .set({
          rows_inserted: inserted,
          rows_updated: updated,
          rows_duplicate: duplicate,
          status: 'committed',
          committed_at: now,
        })
        .where('id', '=', fileId)
        .execute();

      summaries.push({
        fileId,
        originalFilename: file.originalFilename,
        detectedType: parsed.detection.type,
        rowsTotal: parsed.document.rows.length,
        rowsInserted: inserted,
        rowsUpdated: updated,
        rowsDuplicate: duplicate,
        rowsInvalid: parsed.errors.length,
      });
    }

    await rematerialiseAll(trx, companyId);

    await trx
      .updateTable('import_batches')
      .set({ status: 'committed', committed_at: now })
      .where('id', '=', batchId)
      .execute();

    return {
      batchId,
      files: summaries,
      transactionsInserted,
      periodsTouched: [...periodsTouched],
      catalog: { resourcesAdded, buildingsAdded },
    };
  });
}

async function insertTransactions(
  trx: Kysely<Database>,
  companyId: number,
  batchId: string,
  fileId: string,
  rows: readonly StagedTransaction[],
  now: string,
): Promise<{ inserted: number; duplicate: number }> {
  let inserted = 0;
  let duplicate = 0;

  for (const row of rows) {
    const existing = await trx
      .selectFrom('account_transactions')
      .select(['id', 'observation_count'])
      .where('company_id', '=', companyId)
      .where('external_id', '=', row.externalId)
      .executeTakeFirst();

    if (existing) {
      // Transaction rows are immutable. Only provenance advances, so an
      // overlapping re-export leaves the stored values byte-identical.
      await trx
        .updateTable('account_transactions')
        .set({
          last_seen_batch_id: batchId,
          last_seen_at: now,
          observation_count: existing.observation_count + 1,
          updated_at: now,
        })
        .where('id', '=', existing.id)
        .execute();
      duplicate += 1;
      continue;
    }

    const d = row.details;
    await trx
      .insertInto('account_transactions')
      .values({
        company_id: companyId,
        external_id: row.externalId,
        occurred_at: row.occurredAt.raw,
        occurred_at_us: row.occurredAt.epochMicros,
        category: row.category,
        money: row.money,
        description: row.description,
        details_raw: row.detailsRaw,
        details_ok: d.ok ? 1 : 0,
        details_error: d.error,
        details_json: d.json,
        detail_version: d.version,
        amount: d.amount,
        price_text: d.price?.text ?? null,
        price_real: d.price?.real ?? null,
        unit_cogs_text: d.unitCogs?.text ?? null,
        unit_cogs_real: d.unitCogs?.real ?? null,
        quality: d.quality,
        remaining: d.remaining,
        profit: d.profit,
        level: d.level,
        building_code: d.buildingCode,
        building_name: d.buildingName,
        building_key: row.buildingKey,
        resource_id: d.resourceId,
        counterparty_name: d.counterpartyName,
        counterparty_role: d.counterpartyRole,
        product_name: row.productName,
        product_source: row.productSource,
        unknown_detail_keys_json: d.unknownKeys.length > 0 ? JSON.stringify(d.unknownKeys) : null,
        raw_row_json: JSON.stringify(row.raw),
        first_seen_batch_id: batchId,
        first_seen_file_id: fileId,
        last_seen_batch_id: batchId,
        last_seen_at: now,
        observation_count: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    inserted += 1;
  }

  return { inserted, duplicate };
}

async function appendStatementRevisions(
  trx: Kysely<Database>,
  companyId: number,
  type: StatementType,
  batchId: string,
  fileId: string,
  rows: readonly ParsedStatementRow[],
  now: string,
): Promise<{ inserted: number; updated: number; duplicate: number; periodIds: number[] }> {
  let inserted = 0;
  let updated = 0;
  let duplicate = 0;
  const periodIds: number[] = [];

  for (const row of rows) {
    let period = await trx
      .selectFrom('statement_periods')
      .select(['id', 'current_revision_id'])
      .where('company_id', '=', companyId)
      .where('statement_type', '=', type)
      .where('snapshot_date', '=', row.timestamp.utcDate)
      .executeTakeFirst();

    let isNewPeriod = false;
    if (!period) {
      const created = await trx
        .insertInto('statement_periods')
        .values({
          company_id: companyId,
          statement_type: type,
          snapshot_date: row.timestamp.utcDate,
          snapshot_at: row.timestamp.raw,
          snapshot_at_us: row.timestamp.epochMicros,
          period_start_at: null,
          period_start_at_us: null,
          is_inception: 0,
          current_revision_id: null,
          created_at: now,
          updated_at: now,
        })
        .returning(['id', 'current_revision_id'])
        .executeTakeFirstOrThrow();
      period = created;
      isNewPeriod = true;
    }

    periodIds.push(period.id);

    const rowHash = stableHash(row.values);
    const currentHash = period.current_revision_id
      ? (
          await trx
            .selectFrom('statement_revisions')
            .select(['row_hash'])
            .where('id', '=', period.current_revision_id)
            .executeTakeFirst()
        )?.row_hash
      : undefined;

    // A revision is appended even when the values are identical. It costs one
    // small row and it is what lets Import History answer "which imports
    // supplied this day" honestly.
    await trx
      .insertInto('statement_revisions')
      .values({
        period_id: period.id,
        import_batch_id: batchId,
        import_file_id: fileId,
        snapshot_at: row.timestamp.raw,
        values_json: JSON.stringify(row.values),
        unknown_columns_json:
          Object.keys(row.unknownColumns).length > 0 ? JSON.stringify(row.unknownColumns) : null,
        raw_row_json: JSON.stringify(row.raw),
        row_hash: rowHash,
        observed_at: now,
        created_at: now,
      })
      .execute();

    if (isNewPeriod) inserted += 1;
    else if (currentHash === rowHash) duplicate += 1;
    else updated += 1;
  }

  return { inserted, updated, duplicate, periodIds };
}

const FACT_TABLES: Record<StatementType, 'income_statement_facts' | 'cashflow_statement_facts' | 'balance_sheet_facts'> =
  {
    income_statement: 'income_statement_facts',
    cashflow_statement: 'cashflow_statement_facts',
    balance_sheet: 'balance_sheet_facts',
  };

/**
 * Rebuilds every derived statement row from the surviving revision ledger.
 *
 * This is the operation that makes rollback correct. It is a full rebuild rather
 * than an incremental patch: cheap at this data size (one row per statement per
 * day), and it removes any possibility of the materialised view drifting away
 * from the ledger it is supposed to reflect.
 *
 * Also recomputes `period_start_at`, which can only be known by looking at the
 * previous snapshot of the same type, and the `is_inception` flag on the oldest
 * period. Both shift when older history is backfilled.
 */
export async function rematerialiseAll(trx: Kysely<Database>, companyId: number): Promise<void> {
  for (const type of Object.keys(FACT_TABLES) as StatementType[]) {
    const factTable = FACT_TABLES[type];

    const periods = await trx
      .selectFrom('statement_periods')
      .select(['id', 'snapshot_at', 'snapshot_at_us', 'snapshot_date'])
      .where('company_id', '=', companyId)
      .where('statement_type', '=', type)
      .orderBy('snapshot_at_us', 'asc')
      .execute();

    let previousUs: number | null = null;
    let previousAt: string | null = null;

    for (const [index, period] of periods.entries()) {
      const winning = await trx
        .selectFrom('statement_revisions')
        .select(['id', 'values_json', 'snapshot_at', 'raw_row_json'])
        .where('period_id', '=', period.id)
        .orderBy('observed_at', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst();

      if (!winning) {
        // Every revision for this day has been rolled back. The period and its
        // fact row go with them; the day genuinely is not held any more.
        await trx.deleteFrom(factTable).where('period_id', '=', period.id).execute();
        await trx.deleteFrom('statement_periods').where('id', '=', period.id).execute();
        continue;
      }

      const values = JSON.parse(winning.values_json) as Record<string, number>;
      const sourceStart = tryParseTimestamp(JSON.parse(winning.raw_row_json)['Source period start'] ?? '');
      const winningTime = tryParseTimestamp(winning.snapshot_at)!;

      await trx
        .updateTable('statement_periods')
        .set({
          current_revision_id: winning.id,
          snapshot_at: winning.snapshot_at,
          snapshot_at_us: winningTime.epochMicros,
          period_start_at: sourceStart?.raw ?? previousAt,
          period_start_at_us: sourceStart?.epochMicros ?? previousUs,
          is_inception: index === 0 && !sourceStart ? 1 : 0,
          updated_at: nowIso(),
        })
        .where('id', '=', period.id)
        .execute();

      const existing = await trx
        .selectFrom(factTable)
        .select(['period_id'])
        .where('period_id', '=', period.id)
        .executeTakeFirst();

      const payload = {
        company_id: companyId,
        snapshot_at_us: winningTime.epochMicros,
        revision_id: winning.id,
        ...Object.fromEntries(Object.values(getColumnMap(type)).map(column => [column, 0])),
        ...values,
      };

      if (existing) {
        await trx
          .updateTable(factTable)
          .set({ ...payload, updated_at: nowIso() } as never)
          .where('period_id', '=', period.id)
          .execute();
      } else {
        await trx
          .insertInto(factTable)
          .values({
            period_id: period.id,
            ...payload,
            created_at: nowIso(),
            updated_at: nowIso(),
          } as never)
          .execute();
      }

      previousUs = winningTime.epochMicros;
      previousAt = winning.snapshot_at;
    }
  }
}

export interface RollbackResult {
  batchId: string;
  transactionsRemoved: number;
  revisionsRemoved: number;
  periodsRemoved: number;
  periodsRestored: number;
}

/**
 * Rolls a batch back.
 *
 * Two different mechanisms, because the two data shapes have different
 * ownership rules:
 *
 *   Transactions are deleted only where `first_seen_batch_id` matches. A row
 *   this batch merely re-observed belongs to an earlier batch and stays.
 *
 *   Statement revisions supplied by this batch are deleted, then everything is
 *   re-materialised. If an earlier batch also supplied that day, its revision is
 *   still in the ledger and becomes the winner again — the day reverts to the
 *   earlier values rather than disappearing. That is the case naive rollback
 *   gets wrong.
 */
export async function rollbackBatch(
  db: Kysely<Database>,
  companyId: number,
  batchId: string,
): Promise<RollbackResult> {
  return db.transaction().execute(async (trx) => {
    const batch = await trx
      .selectFrom('import_batches')
      .select(['id', 'status'])
      .where('id', '=', batchId)
      .where('company_id', '=', companyId)
      .executeTakeFirst();

    if (!batch) throw new Error(`Import batch ${batchId} not found.`);
    if (batch.status === 'rolled_back') throw new Error(`Import batch ${batchId} is already rolled back.`);

    const periodsBefore = await trx
      .selectFrom('statement_periods')
      .select(['id'])
      .where('company_id', '=', companyId)
      .execute();

    const deletedTx = await trx
      .deleteFrom('account_transactions')
      .where('company_id', '=', companyId)
      .where('first_seen_batch_id', '=', batchId)
      .executeTakeFirst();

    const deletedRevisions = await trx
      .deleteFrom('statement_revisions')
      .where('import_batch_id', '=', batchId)
      .executeTakeFirst();

    await rematerialiseAll(trx, companyId);

    const periodsAfter = await trx
      .selectFrom('statement_periods')
      .select(['id'])
      .where('company_id', '=', companyId)
      .execute();

    const now = nowIso();
    await trx
      .updateTable('import_files')
      .set({ status: 'rolled_back' })
      .where('batch_id', '=', batchId)
      .execute();
    await trx
      .updateTable('import_batches')
      .set({ status: 'rolled_back', rolled_back_at: now })
      .where('id', '=', batchId)
      .execute();

    const removed = periodsBefore.length - periodsAfter.length;

    return {
      batchId,
      transactionsRemoved: Number(deletedTx.numDeletedRows ?? 0n),
      revisionsRemoved: Number(deletedRevisions.numDeletedRows ?? 0n),
      periodsRemoved: removed,
      periodsRestored: periodsAfter.length,
    };
  });
}
