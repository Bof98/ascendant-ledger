import type { Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Kysely type definitions mirroring the SQL migrations.
 *
 * Kysely is a query builder rather than an ORM: the SQL files remain the single
 * source of truth for the schema and this file describes it to TypeScript. That
 * keeps STRICT tables, stored generated columns, partial indexes and the FTS5
 * virtual table expressible without fighting a schema DSL.
 *
 * Convention: columns the database computes (generated columns, defaults, and
 * autoincrement ids) are wrapped in `Generated<T>` so they are optional on
 * insert and readable on select.
 */

export type StatementType = 'income_statement' | 'cashflow_statement' | 'balance_sheet';
export type ReportType = 'account_history' | StatementType;
export type ImportStatus = 'pending' | 'committed' | 'rolled_back' | 'failed';
export type Severity = 'info' | 'warning' | 'error';
export type CounterpartyRole = 'seller' | 'buyer';
export type NameSource = 'override' | 'observed' | 'unknown';
export type RealmCode = 'magnates' | 'entrepreneurs';

export interface CompaniesTable {
  id: Generated<number>;
  name: string;
  realm: RealmCode | null;
  created_at: string;
  updated_at: string;
}

export interface AppSettingsTable {
  key: string;
  value_json: string;
  updated_at: string;
}

export interface AppUsersTable {
  id: Generated<number>;
  username: string;
  password_hash: string;
  created_at: string;
  last_login_at: string | null;
}

export interface ImportBatchesTable {
  id: string;
  company_id: number;
  status: ImportStatus;
  created_at: string;
  committed_at: string | null;
  rolled_back_at: string | null;
  file_count: Generated<number>;
  note: string | null;
}

export interface ImportFilesTable {
  id: string;
  batch_id: string;
  company_id: number;
  original_filename: string;
  safe_filename: string;
  file_sha256: string;
  file_size_bytes: number;
  detected_type: ReportType | null;
  detection_score: number | null;
  detection_method: string | null;
  schema_version: Generated<number>;
  header_raw_json: string | null;
  unknown_headers_json: string | null;
  rows_total: Generated<number>;
  rows_inserted: Generated<number>;
  rows_updated: Generated<number>;
  rows_duplicate: Generated<number>;
  rows_invalid: Generated<number>;
  period_start: string | null;
  period_end: string | null;
  warnings_json: string | null;
  status: ImportStatus;
  error_message: string | null;
  created_at: string;
  committed_at: string | null;
}

export interface ImportRejectedRowsTable {
  id: Generated<number>;
  import_file_id: string;
  row_number: number;
  raw_row_json: string;
  error_code: string;
  error_message: string;
  created_at: string;
}

export interface AccountTransactionsTable {
  id: Generated<number>;
  company_id: number;
  external_id: number;
  occurred_at: string;
  occurred_at_us: number;
  category: string;
  money: number;
  description: string;
  details_raw: string;
  details_ok: Generated<number>;
  details_error: string | null;
  details_json: string | null;
  detail_version: number | null;
  amount: number | null;
  price_text: string | null;
  price_real: number | null;
  unit_cogs_text: string | null;
  unit_cogs_real: number | null;
  quality: number | null;
  remaining: number | null;
  profit: number | null;
  level: number | null;
  building_code: string | null;
  building_name: string | null;
  building_key: string | null;
  resource_id: number | null;
  counterparty_name: string | null;
  counterparty_role: CounterpartyRole | null;
  product_name: string | null;
  product_source: string | null;
  unknown_detail_keys_json: string | null;
  raw_row_json: string;
  first_seen_batch_id: string;
  first_seen_file_id: string;
  last_seen_batch_id: string | null;
  last_seen_at: string | null;
  observation_count: Generated<number>;
  created_at: string;
  updated_at: string;
}

export interface StatementPeriodsTable {
  id: Generated<number>;
  company_id: number;
  statement_type: StatementType;
  snapshot_date: string;
  snapshot_at: string;
  snapshot_at_us: number;
  period_start_at: string | null;
  period_start_at_us: number | null;
  is_inception: Generated<number>;
  current_revision_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface StatementRevisionsTable {
  id: Generated<number>;
  period_id: number;
  import_batch_id: string;
  import_file_id: string;
  snapshot_at: string;
  values_json: string;
  unknown_columns_json: string | null;
  raw_row_json: string;
  row_hash: string;
  observed_at: string;
  created_at: string;
}

export interface IncomeStatementFactsTable {
  period_id: number;
  company_id: number;
  snapshot_at_us: number;
  revision_id: number;
  executive_royalties: Generated<number>;
  gain_on_sale: Generated<number>;
  sales: Generated<number>;
  cogs: Generated<number>;
  freight_out: Generated<number>;
  construction: Generated<number>;
  exchange_fees: Generated<number>;
  salaries: Generated<number>;
  training: Generated<number>;
  poaching: Generated<number>;
  achievements_referrals_pa: Generated<number>;
  patent_conversion: Generated<number>;
  bond_defaults: Generated<number>;
  bond_writeoffs: Generated<number>;
  accounting_overhead: Generated<number>;
  bond_interest_expense: Generated<number>;
  bond_interest_income: Generated<number>;
  donations: Generated<number>;
  other_comprehensive_income: Generated<number>;
  net_income: Generated<number>;
  /** Identity 1 check: must equal net_income. */
  computed_net_income: Generated<number>;
  /** sales + cogs — COGS is already negative, so it is added. */
  gross_profit: Generated<number>;
  /** Derived, never an official Sim Companies figure. */
  core_business_result: Generated<number>;
  created_at: string;
  updated_at: string;
}

export interface CashflowStatementFactsTable {
  period_id: number;
  company_id: number;
  snapshot_at_us: number;
  revision_id: number;
  from_royalties: Generated<number>;
  from_employees: Generated<number>;
  for_pa_quests: Generated<number>;
  rounding_adjustment: Generated<number>;
  all_income: Generated<number>;
  all_expenses: Generated<number>;
  from_retail: Generated<number>;
  from_customers: Generated<number>;
  from_exchange: Generated<number>;
  from_interest: Generated<number>;
  from_poaching: Generated<number>;
  to_suppliers: Generated<number>;
  to_exchange: Generated<number>;
  to_employees: Generated<number>;
  to_executives: Generated<number>;
  for_interest: Generated<number>;
  for_fees: Generated<number>;
  for_accounting: Generated<number>;
  investment_in_bonds: Generated<number>;
  bonds: Generated<number>;
  game_income: Generated<number>;
  net_cash_flow: Generated<number>;
  unclassified_net: Generated<number>;
  created_at: string;
  updated_at: string;
}

export interface BalanceSheetFactsTable {
  period_id: number;
  company_id: number;
  snapshot_at_us: number;
  revision_id: number;
  cash_reserved: Generated<number>;
  construction_in_progress: Generated<number>;
  cash: Generated<number>;
  accounts_receivable: Generated<number>;
  inventory_materials: Generated<number>;
  inventory_research: Generated<number>;
  inventory_wip: Generated<number>;
  inventory_finished_goods: Generated<number>;
  inventory_valuation_allowance: Generated<number>;
  deposits: Generated<number>;
  investment_in_bonds: Generated<number>;
  buildings: Generated<number>;
  patents: Generated<number>;
  liabilities: Generated<number>;
  contributed_capital: Generated<number>;
  retained_earnings: Generated<number>;
  total_inventory: Generated<number>;
  total_assets: Generated<number>;
  total_equity: Generated<number>;
  /** Identity 2 check: must be 0. */
  balance_delta: Generated<number>;
  created_at: string;
  updated_at: string;
}

export interface ResourceCatalogTable {
  resource_id: number;
  observed_name: string | null;
  observed_name_source: 'description_inference' | 'details_field' | null;
  observed_name_confidence: number | null;
  first_seen_at: string;
  last_seen_at: string;
  first_seen_batch_id: string | null;
  observation_count: Generated<number>;
  created_at: string;
  updated_at: string;
}

export interface ResourceOverridesTable {
  resource_id: number;
  display_name: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface BuildingCatalogTable {
  catalog_key: string;
  building_code: string | null;
  observed_name: string | null;
  last_known_level: number | null;
  first_seen_at: string;
  last_seen_at: string;
  first_seen_batch_id: string | null;
  observation_count: Generated<number>;
  created_at: string;
  updated_at: string;
}

export interface BuildingOverridesTable {
  catalog_key: string;
  display_name: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** Read-only view: override > observed > 'Unknown Resource #N'. */
export interface ResourceResolvedView {
  resource_id: number;
  display_name: string;
  name_source: NameSource;
  observed_name: string | null;
  observed_name_confidence: number | null;
  override_name: string | null;
  override_note: string | null;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

/** Read-only view: override > observed > 'Building <code>'. */
export interface BuildingResolvedView {
  catalog_key: string;
  building_code: string | null;
  display_name: string;
  name_source: NameSource;
  observed_name: string | null;
  override_name: string | null;
  override_note: string | null;
  last_known_level: number | null;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

export interface DataQualityFindingsTable {
  id: Generated<number>;
  company_id: number;
  check_code: string;
  severity: Severity;
  subject_type: 'statement_period' | 'transaction' | 'import_file' | 'catalog' | 'global';
  subject_id: Generated<string>;
  occurred_at: string | null;
  message: string;
  details_json: string | null;
  detected_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
}

export interface CoreResultRulesTable {
  id: Generated<number>;
  company_id: number;
  rule_type: 'income_statement_line' | 'transaction_category';
  target: string;
  action: 'exclude';
  enabled: Generated<number>;
  is_builtin: Generated<number>;
  rationale: string | null;
  created_at: string;
  updated_at: string;
}

export interface MigrationsTable {
  name: string;
  checksum: string;
  applied_at: string;
  duration_ms: number;
}

export interface Database {
  companies: CompaniesTable;
  app_settings: AppSettingsTable;
  app_users: AppUsersTable;
  import_batches: ImportBatchesTable;
  import_files: ImportFilesTable;
  import_rejected_rows: ImportRejectedRowsTable;
  account_transactions: AccountTransactionsTable;
  statement_periods: StatementPeriodsTable;
  statement_revisions: StatementRevisionsTable;
  income_statement_facts: IncomeStatementFactsTable;
  cashflow_statement_facts: CashflowStatementFactsTable;
  balance_sheet_facts: BalanceSheetFactsTable;
  resource_catalog: ResourceCatalogTable;
  resource_overrides: ResourceOverridesTable;
  building_catalog: BuildingCatalogTable;
  building_overrides: BuildingOverridesTable;
  resource_resolved: ResourceResolvedView;
  building_resolved: BuildingResolvedView;
  data_quality_findings: DataQualityFindingsTable;
  core_result_rules: CoreResultRulesTable;
  _migrations: MigrationsTable;
}

export type Company = Selectable<CompaniesTable>;
export type AccountTransaction = Selectable<AccountTransactionsTable>;
export type NewAccountTransaction = Insertable<AccountTransactionsTable>;
export type AccountTransactionUpdate = Updateable<AccountTransactionsTable>;
export type ImportBatch = Selectable<ImportBatchesTable>;
export type ImportFile = Selectable<ImportFilesTable>;
export type StatementPeriod = Selectable<StatementPeriodsTable>;
export type IncomeStatementFact = Selectable<IncomeStatementFactsTable>;
export type CashflowStatementFact = Selectable<CashflowStatementFactsTable>;
export type BalanceSheetFact = Selectable<BalanceSheetFactsTable>;
export type ResolvedResource = Selectable<ResourceResolvedView>;
export type ResolvedBuilding = Selectable<BuildingResolvedView>;
