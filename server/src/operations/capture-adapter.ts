import type { StatementType } from '../db/types.js';
import { getColumnMap } from '../import/parsers/statements.js';
import type { UploadedFile } from '../import/pipeline.js';

export interface CapturedStatement {
  period?: string;
  as_of?: string;
  rows?: Array<{ k: string; label?: string; text?: string; value?: number | null }>;
}
export interface Capture { id: number; captured_at: string; payload: string; source: string }
export interface CapturedTransaction {
  entry_id: number; occurred_at: string; category: string; money: number;
  description: string | null; description_key: string | null; details: string | null; captured_at: string;
}
export interface StatementRecord {
  type: StatementType; timestamp: string; start: string | null;
  values: Record<string, number>; source: Capture; statement: CapturedStatement;
}
const mappings: Record<StatementType, Record<string, string>> = {
  income_statement: {
    Sales: 'sales', 'Cost of goods sold': 'cogs', 'Freight Out': 'freight_out',
    'Construction costs': 'construction', 'Exchange fees': 'exchange_fees', Salaries: 'salaries',
    Training: 'training', Poaching: 'poaching', 'Game income': 'achievements_referrals_pa',
    'Executive royalties': 'executive_royalties', 'Gain on sale': 'gain_on_sale',
    'Patent conversion': 'patent_conversion', 'Accounting overhead': 'accounting_overhead', Donations: 'donations',
    'Interest income': 'bond_interest_income', 'Interest expense': 'bond_interest_expense',
    'Write offs': 'bond_writeoffs', Defaults: 'bond_defaults', 'NET INCOME': 'net_income',
    'Other comprehensive income': 'other_comprehensive_income',
  },
  balance_sheet: {
    Cash: 'cash', 'Cash reserved for orders': 'cash_reserved', 'Accounts receivable': 'accounts_receivable',
    Materials: 'inventory_materials', Research: 'inventory_research', 'Work in process': 'inventory_wip',
    'Finished goods': 'inventory_finished_goods', 'Valuation allowance': 'inventory_valuation_allowance',
    Deposits: 'deposits', 'Investment in bonds': 'investment_in_bonds', Buildings: 'buildings',
    'Construction in progress': 'construction_in_progress', Patents: 'patents', 'Bonds Payable': 'liabilities',
    'Contributed Capital': 'contributed_capital', 'Retained earnings': 'retained_earnings',
  },
  cashflow_statement: {
    'From retail': 'from_retail', 'From customers': 'from_customers', 'From exchange': 'from_exchange',
    'From interest': 'from_interest', 'From poaching': 'from_poaching', 'From royalties': 'from_royalties',
    'From employees': 'from_employees', 'To suppliers': 'to_suppliers', 'To exchange': 'to_exchange',
    'To employees': 'to_employees', 'To executives': 'to_executives', 'For interest': 'for_interest',
    'For fees': 'for_fees', 'For accounting': 'for_accounting', 'For PA quests': 'for_pa_quests',
    'Investment in bonds': 'investment_in_bonds', Bonds: 'bonds', 'From game': 'game_income',
  },
};
const summaries: Record<StatementType, string[]> = {
  income_statement: ['TOTAL COMPREHENSIVE INCOME', 'Operating profit', 'Capital charge'],
  balance_sheet: ['TOTAL ASSETS', 'TOTAL DEBT AND EQUITY', 'COMPANY VALUE'],
  cashflow_statement: ['TOTAL CHANGE IN CASH'],
};

// The capture browser runs in UTC. Anchor yearless labels to their capture,
// choosing the most recent occurrence, including December reports read in January.
export function capturedDate(label: string, anchor: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/i.exec(label.trim());
  const ref = new Date(anchor);
  if (!m || !Number.isFinite(ref.getTime())) throw new Error(`Unrecognised statement date: ${label}`);
  const hour = Number(m[1]), minute = Number(m[2]), month = Number(m[4]), day = Number(m[5]);
  if (hour < 1 || hour > 12 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Invalid statement date');
  const fullYear = m[6] ? Number(m[6]) + (m[6].length === 2 ? 2000 : 0) : ref.getUTCFullYear();
  const make = (year: number) => new Date(Date.UTC(year, month - 1, day, hour % 12 + (m[3]!.toUpperCase() === 'PM' ? 12 : 0), minute));
  let value = make(fullYear);
  if (!m[6] && value.getTime() > ref.getTime()) value = make(fullYear - 1);
  if (value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day || value.getTime() > ref.getTime()) throw new Error('Invalid or future statement date');
  return value.toISOString();
}

export function adaptStatement(type: StatementType, statement: CapturedStatement, source: Capture): StatementRecord | null {
  const rows = statement.rows?.filter(r => r.k === 'r') ?? [];
  // The game also saves a placeholder while the accounting team is preparing a report.
  if (!rows.length) return null;
  let timestamp: string, start: string | null = null;
  if (type === 'balance_sheet') timestamp = capturedDate(statement.as_of ?? '', source.captured_at);
  else {
    const parts = (statement.period ?? '').split(/\s+to\s+/i);
    if (parts.length !== 2) throw new Error('Missing statement period');
    timestamp = capturedDate(parts[1]!, source.captured_at);
    start = capturedDate(parts[0]!, timestamp);
    if (start >= timestamp) throw new Error('Statement period must have a positive duration');
  }
  const values: Record<string, number> = Object.fromEntries(Object.values(getColumnMap(type)).map(k => [k, 0]));
  const originals: Record<string, number> = {};
  for (const row of rows) {
    if (!row.label || !Number.isSafeInteger(row.value)) throw new Error('Missing or invalid statement amount');
    if (Object.hasOwn(originals, row.label)) throw new Error(`Duplicate statement line: ${row.label}`);
    originals[row.label] = row.value!;
    const column = mappings[type][row.label];
    if (column) values[column] = row.value!;
    else if (!summaries[type].includes(row.label)) throw new Error(`Unmapped statement line: ${row.label}`);
  }
  // Require all source lines, including zero amounts. Partial captures must not
  // replace a complete report with zeros for fields the browser failed to read.
  for (const label of [...Object.keys(mappings[type]), ...summaries[type]]) {
    if (!Object.hasOwn(originals, label)) throw new Error(`Incomplete statement: ${label}`);
  }
  if (type === 'cashflow_statement') {
    const amounts = Object.keys(mappings[type]).map(k => originals[k]!);
    values.all_income = amounts.filter(v => v > 0).reduce((a, b) => a + b, 0);
    values.all_expenses = amounts.filter(v => v < 0).reduce((a, b) => a + b, 0);
    values.rounding_adjustment = originals['TOTAL CHANGE IN CASH']! - values.all_income - values.all_expenses;
    if (Math.abs(values.rounding_adjustment) > 5) throw new Error('Cash-flow lines differ materially from the reported total');
  } else if (type === 'income_statement') {
    const computed = Object.entries(values).filter(([k]) => !['net_income', 'other_comprehensive_income'].includes(k)).reduce((a, [, v]) => a + v, 0);
    if (computed !== values.net_income) throw new Error('Income statement does not reconcile');
  } else {
    const assets = Object.entries(values).filter(([k]) => !['liabilities', 'contributed_capital', 'retained_earnings'].includes(k)).reduce((a, [, v]) => a + v, 0);
    if (assets !== originals['TOTAL ASSETS'] || Math.abs(assets - values.liabilities! - values.contributed_capital! - values.retained_earnings!) > 5) throw new Error('Balance sheet does not reconcile');
  }
  return { type, timestamp, start, values, source, statement };
}

export function csvFile(name: string, rows: Record<string, unknown>[]): UploadedFile {
  const headers = [...new Set(rows.flatMap(Object.keys))];
  const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return { originalFilename: name, content: [headers, ...rows.map(row => headers.map(h => row[h]))].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n' };
}
export function statementFile(type: StatementType, records: StatementRecord[]): UploadedFile {
  return csvFile(`captured-${type}.csv`, records.map(record => ({
    Timestamp: record.timestamp,
    ...Object.fromEntries(Object.entries(getColumnMap(type)).map(([header, column]) => [header, record.values[column]])),
    'Source kind': 'saved game capture', 'Source snapshot id': record.source.id,
    'Source captured at': record.source.captured_at, 'Source period start': record.start,
    'Source statement': JSON.stringify(record.statement),
  })));
}
export function transactionFile(rows: CapturedTransaction[]): UploadedFile {
  const categories: Record<string, string> = { c: 'construction', f: 'fees', g: 'game', m: 'market', p: 'production', s: 'sales' };
  return csvFile('captured-account-history.csv', rows.map(row => ({
    id: row.entry_id, Timestamp: row.occurred_at, Category: categories[row.category] ?? row.category,
    Money: row.money, Description: row.description, Details: row.details ?? '{}',
    'Source kind': 'saved account history', 'Source category': row.category,
    'Source description key': row.description_key, 'Source captured at': row.captured_at,
  })));
}
