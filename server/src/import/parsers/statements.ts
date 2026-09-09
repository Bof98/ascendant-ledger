import type { StatementType } from '../../db/types.js';
import { parseCashOrDefault } from '../../domain/money.js';
import { tryParseTimestamp, type ParsedTimestamp } from '../../domain/time.js';
import type { CsvRow } from '../csv.js';

/**
 * Statement row parsing.
 *
 * All three statements share a shape: one timestamp column plus a fixed set of
 * signed integer cash columns. Only the column map differs, so one parser serves
 * all three.
 *
 * Signs are preserved exactly as exported. Expenses arrive negative and are
 * stored negative. Spec section 8 allows the UI to render expense magnitudes,
 * but that is a formatting decision made at the very edge; nothing in the
 * storage or calculation path ever re-signs a value.
 *
 * A missing optional column defaults to 0 rather than failing, which is what
 * lets an older or newer export still import. A column that is PRESENT but
 * unparseable is a different matter: that is recorded as a row-level warning so
 * the discrepancy stays visible.
 */

/** Normalised CSV header → fact table column. */
export type ColumnMap = Readonly<Record<string, string>>;

const INCOME_STATEMENT_COLUMNS: ColumnMap = {
  sales: 'sales',
  cogs: 'cogs',
  'freight out': 'freight_out',
  construction: 'construction',
  'exchange fees': 'exchange_fees',
  salaries: 'salaries',
  training: 'training',
  poaching: 'poaching',
  'achievements referrals pa': 'achievements_referrals_pa',
  'patent conversion': 'patent_conversion',
  'bond defaults': 'bond_defaults',
  'bond writeoffs': 'bond_writeoffs',
  'accounting overhead': 'accounting_overhead',
  'bond interest expense': 'bond_interest_expense',
  'bond interest income': 'bond_interest_income',
  donations: 'donations',
  'other comprehensive income': 'other_comprehensive_income',
  netincome: 'net_income',
};

const CASHFLOW_STATEMENT_COLUMNS: ColumnMap = {
  'all income': 'all_income',
  'all expenses': 'all_expenses',
  'from retail': 'from_retail',
  'from customers': 'from_customers',
  'from exchange': 'from_exchange',
  'from interest': 'from_interest',
  'from poaching': 'from_poaching',
  'to suppliers': 'to_suppliers',
  'to exchange': 'to_exchange',
  'to employees': 'to_employees',
  'to executives': 'to_executives',
  'for interest': 'for_interest',
  'for fees': 'for_fees',
  'for accounting': 'for_accounting',
  'investment in bonds': 'investment_in_bonds',
  bonds: 'bonds',
  'game income': 'game_income',
};

const BALANCE_SHEET_COLUMNS: ColumnMap = {
  cash: 'cash',
  'accounts receivable': 'accounts_receivable',
  'inventory - materials': 'inventory_materials',
  'inventory - research': 'inventory_research',
  'inventory - work in process': 'inventory_wip',
  'inventory - finished goods': 'inventory_finished_goods',
  'inventory - valuation allowance': 'inventory_valuation_allowance',
  deposits: 'deposits',
  'investment in bonds': 'investment_in_bonds',
  buildings: 'buildings',
  patents: 'patents',
  liabilities: 'liabilities',
  'contributed capital': 'contributed_capital',
  'retained earnings': 'retained_earnings',
};

const COLUMN_MAPS: Record<StatementType, ColumnMap> = {
  income_statement: INCOME_STATEMENT_COLUMNS,
  cashflow_statement: CASHFLOW_STATEMENT_COLUMNS,
  balance_sheet: BALANCE_SHEET_COLUMNS,
};

export function getColumnMap(type: StatementType): ColumnMap {
  return COLUMN_MAPS[type];
}

export interface StatementRowWarning {
  code: string;
  message: string;
  rowNumber: number;
}

export interface ParsedStatementRow {
  rowNumber: number;
  timestamp: ParsedTimestamp;
  /** Fact table column → signed whole SIM$. */
  values: Record<string, number>;
  /** Original header → original cell, for unrecognised columns only. */
  unknownColumns: Record<string, string>;
  /** Whole original row, verbatim. */
  raw: Record<string, string>;
  warnings: StatementRowWarning[];
}

export interface StatementRowError {
  rowNumber: number;
  code: string;
  message: string;
  raw: Record<string, string>;
}

export interface StatementParseResult {
  rows: ParsedStatementRow[];
  errors: StatementRowError[];
}

export function parseStatementRows(
  type: StatementType,
  rows: readonly CsvRow[],
  knownHeaders: ReadonlySet<string>,
): StatementParseResult {
  const columnMap = COLUMN_MAPS[type];
  const parsed: ParsedStatementRow[] = [];
  const errors: StatementRowError[] = [];

  for (const row of rows) {
    const timestampCell = row.normalised['timestamp'];
    const timestamp = timestampCell ? tryParseTimestamp(timestampCell) : null;

    // Without a usable timestamp the row cannot be keyed, so it is rejected and
    // preserved in import_rejected_rows rather than guessed at.
    if (!timestamp) {
      errors.push({
        rowNumber: row.rowNumber,
        code: 'invalid_timestamp',
        message: `Could not read a timestamp from ${JSON.stringify(timestampCell ?? '')}.`,
        raw: row.raw,
      });
      continue;
    }

    const values: Record<string, number> = {};
    const warnings: StatementRowWarning[] = [];

    for (const [header, column] of Object.entries(columnMap)) {
      const cell = row.normalised[header];
      const { value, ok } = parseCashOrDefault(cell, 0);
      values[column] = value;

      if (!ok) {
        warnings.push({
          rowNumber: row.rowNumber,
          code: 'unreadable_cash_value',
          message: `Column "${header}" held ${JSON.stringify(cell)}, which is not a whole SIM$ amount. Stored as 0 and flagged.`,
        });
      }
    }

    const unknownColumns: Record<string, string> = {};
    for (const [header, cell] of Object.entries(row.raw)) {
      const normalised = header.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!knownHeaders.has(normalised)) unknownColumns[header] = cell;
    }

    parsed.push({
      rowNumber: row.rowNumber,
      timestamp,
      values,
      unknownColumns,
      raw: row.raw,
      warnings,
    });
  }

  return { rows: parsed, errors };
}
