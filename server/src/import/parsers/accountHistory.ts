import { parseCash } from '../../domain/money.js';
import { tryParseTimestamp, type ParsedTimestamp } from '../../domain/time.js';
import type { CsvRow } from '../csv.js';
import {
  buildingCatalogKey,
  extractProductName,
  parseDetails,
  type ParsedDetails,
} from '../details.js';

/**
 * Account History row parsing.
 *
 * Produces one staged transaction per CSV row. Nothing is written here; staging
 * exists so the Import Center can show an accurate preview (new / duplicate /
 * invalid counts) before anything is committed.
 *
 * `external_id` is the Sim Companies transaction id and the sole dedup key.
 * Verified across the reference export: 69 rows, 69 unique ids, 10-digit
 * integers, strictly monotonic with timestamp.
 */

export interface StagedTransaction {
  rowNumber: number;
  externalId: number;
  occurredAt: ParsedTimestamp;
  category: string;
  money: number;
  description: string;
  detailsRaw: string;
  details: ParsedDetails;
  productName: string | null;
  productSource: 'description' | 'resource_id' | null;
  buildingKey: string | null;
  raw: Record<string, string>;
  unknownColumns: Record<string, string>;
}

export interface TransactionRowError {
  rowNumber: number;
  code: string;
  message: string;
  raw: Record<string, string>;
}

export interface AccountHistoryParseResult {
  rows: StagedTransaction[];
  errors: TransactionRowError[];
  /** Duplicate ids WITHIN a single file. Distinct from cross-import duplicates. */
  intraFileDuplicates: Array<{ externalId: number; rowNumbers: number[] }>;
}

export function parseAccountHistoryRows(
  rows: readonly CsvRow[],
  knownHeaders: ReadonlySet<string>,
): AccountHistoryParseResult {
  const parsed: StagedTransaction[] = [];
  const errors: TransactionRowError[] = [];
  const seen = new Map<number, number[]>();

  for (const row of rows) {
    const idCell = (row.normalised['id'] ?? '').trim();
    const externalId = /^\d+$/.test(idCell) ? Number(idCell) : NaN;

    // The id is the entire duplicate-protection mechanism. A row without a
    // usable one cannot be safely stored, because a later re-import would have
    // no way to recognise it and would insert a second copy.
    if (!Number.isSafeInteger(externalId)) {
      errors.push({
        rowNumber: row.rowNumber,
        code: 'invalid_external_id',
        message: `Transaction id ${JSON.stringify(idCell)} is not a positive integer. Without it this row cannot be de-duplicated.`,
        raw: row.raw,
      });
      continue;
    }

    const timestamp = tryParseTimestamp(row.normalised['timestamp'] ?? '');
    if (!timestamp) {
      errors.push({
        rowNumber: row.rowNumber,
        code: 'invalid_timestamp',
        message: `Could not read a timestamp from ${JSON.stringify(row.normalised['timestamp'] ?? '')}.`,
        raw: row.raw,
      });
      continue;
    }

    let money: number;
    try {
      money = parseCash(row.normalised['money'] ?? '');
    } catch {
      errors.push({
        rowNumber: row.rowNumber,
        code: 'invalid_money',
        message: `Money value ${JSON.stringify(row.normalised['money'] ?? '')} is not a whole SIM$ amount.`,
        raw: row.raw,
      });
      continue;
    }

    const category = (row.normalised['category'] ?? '').trim();
    const description = (row.normalised['description'] ?? '').trim();

    // Preserved byte-for-byte. Spec section 5 requires the original Details value
    // to survive parsing, so this string is stored regardless of parse outcome.
    const detailsRaw = row.normalised['details'] ?? '';
    const details = parseDetails(detailsRaw, category);

    // Product attribution, in confidence order. A resource id resolves through
    // the catalog at query time; the description template is matched here.
    const fromDescription = extractProductName(description);
    let productName: string | null = fromDescription;
    let productSource: StagedTransaction['productSource'] = fromDescription ? 'description' : null;
    if (!productName && details.resourceId !== null) {
      productName = null; // resolved from the catalog on read, not guessed here
      productSource = 'resource_id';
    }

    const unknownColumns: Record<string, string> = {};
    for (const [header, cell] of Object.entries(row.raw)) {
      const normalised = header.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!knownHeaders.has(normalised)) unknownColumns[header] = cell;
    }

    const record: StagedTransaction = {
      rowNumber: row.rowNumber,
      externalId,
      occurredAt: timestamp,
      category,
      money,
      description,
      detailsRaw,
      details,
      productName,
      productSource,
      buildingKey: buildingCatalogKey(details.buildingCode, details.buildingName),
      raw: row.raw,
      unknownColumns,
    };

    const previous = seen.get(externalId);
    if (previous) {
      previous.push(row.rowNumber);
    } else {
      seen.set(externalId, [row.rowNumber]);
      parsed.push(record);
    }
  }

  const intraFileDuplicates = [...seen.entries()]
    .filter(([, rowNumbers]) => rowNumbers.length > 1)
    .map(([externalId, rowNumbers]) => ({ externalId, rowNumbers }));

  return { rows: parsed, errors, intraFileDuplicates };
}
