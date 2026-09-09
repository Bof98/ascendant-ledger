import { parse } from 'csv-parse/sync';

/**
 * CSV reading, built to the tolerances in spec section 28.
 *
 * Confirmed properties of the reference exports: UTF-8 with no BOM, CRLF line
 * endings, RFC4180 double-quote escaping (the Account History `Details` column
 * embeds JSON full of commas and quotes). The reader still handles a BOM and
 * bare LF, because those are exactly the kind of thing that changes silently
 * between game releases.
 *
 * Two invariants hold throughout:
 *   * Every row is retained verbatim as `raw`, keyed by the ORIGINAL header
 *     text, so an unrecognised column survives into the database.
 *   * Header lookup is normalised (case, whitespace, BOM) but the original
 *     spelling is never overwritten.
 */

export interface CsvRow {
  /** 1-based, excluding the header line. Matches what a spreadsheet shows. */
  rowNumber: number;
  /** Cells keyed by original header text, exactly as they appeared. */
  raw: Record<string, string>;
  /** Cells keyed by normalised header, for lookup. */
  normalised: Record<string, string>;
}

export interface CsvDocument {
  /** Header cells in file order, original spelling. */
  headers: string[];
  /** Header cells in file order, normalised. Same length and order as `headers`. */
  normalisedHeaders: string[];
  rows: CsvRow[];
  /** True when a UTF-8 BOM was stripped from the first cell. */
  hadBom: boolean;
  /** Rows whose cell count did not match the header. Reported, never dropped. */
  raggedRows: Array<{ rowNumber: number; cellCount: number; cells: string[] }>;
}

export class CsvParseError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'CsvParseError';
  }
}

const BOM = '\uFEFF';

/**
 * Normalises a header cell for matching: strips BOM, trims, collapses internal
 * whitespace, lowercases. `"Inventory  - Materials "` and `"inventory - materials"`
 * therefore resolve to the same key.
 */
export function normaliseHeader(header: string): string {
  return header.replace(BOM, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function readCsv(content: string | Buffer): CsvDocument {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  const hadBom = text.startsWith(BOM);
  const body = hadBom ? text.slice(BOM.length) : text;

  if (body.trim() === '') {
    throw new CsvParseError('File is empty.');
  }

  let records: string[][];
  try {
    records = parse(body, {
      bom: true,
      // Ragged rows are collected and reported rather than aborting the import.
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: false,
      columns: false,
    }) as string[][];
  } catch (error) {
    throw new CsvParseError('File could not be parsed as CSV.', error);
  }

  const [headerCells, ...dataRows] = records;
  if (!headerCells || headerCells.length === 0) {
    throw new CsvParseError('File has no header row.');
  }

  const headers = headerCells.map((h) => h.replace(BOM, '').trim());
  const normalisedHeaders = headers.map(normaliseHeader);

  const rows: CsvRow[] = [];
  const raggedRows: CsvDocument['raggedRows'] = [];

  dataRows.forEach((cells, index) => {
    const rowNumber = index + 1;

    if (cells.length !== headers.length) {
      raggedRows.push({ rowNumber, cellCount: cells.length, cells });
      // Short rows still get imported with the missing tail blank; the finding
      // is recorded so the discrepancy is visible rather than invisible.
      if (cells.length < headers.length) {
        cells = [...cells, ...Array<string>(headers.length - cells.length).fill('')];
      }
    }

    const raw: Record<string, string> = {};
    const normalised: Record<string, string> = {};
    headers.forEach((header, i) => {
      const value = cells[i] ?? '';
      raw[header] = value;
      normalised[normalisedHeaders[i]!] = value;
    });

    rows.push({ rowNumber, raw, normalised });
  });

  return { headers, normalisedHeaders, rows, hadBom, raggedRows };
}
