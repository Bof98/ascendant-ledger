CREATE TABLE statement_periods (
  id                  INTEGER PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  statement_type      TEXT    NOT NULL,   -- income_statement | cashflow_statement | balance_sheet

  snapshot_date       TEXT    NOT NULL,   -- 'YYYY-MM-DD' (UTC) — the logical upsert key
  snapshot_at         TEXT    NOT NULL,   -- full ISO-8601 UTC timestamp, verbatim
  snapshot_at_us      INTEGER NOT NULL,   -- microsecond epoch

  period_start_at     TEXT,
  period_start_at_us  INTEGER,

  is_inception        INTEGER NOT NULL DEFAULT 0,

  current_revision_id INTEGER,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,

  CHECK (statement_type IN ('income_statement', 'cashflow_statement', 'balance_sheet')),
  CHECK (is_inception IN (0, 1))
) STRICT;

CREATE UNIQUE INDEX uq_period_company_type_date
  ON statement_periods (company_id, statement_type, snapshot_date);
CREATE INDEX idx_period_type_time
  ON statement_periods (company_id, statement_type, snapshot_at_us DESC);

CREATE TABLE statement_revisions (
  id                  INTEGER PRIMARY KEY,
  period_id           INTEGER NOT NULL REFERENCES statement_periods(id) ON DELETE CASCADE,
  import_batch_id     TEXT    NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  import_file_id      TEXT    NOT NULL REFERENCES import_files(id)   ON DELETE CASCADE,

  snapshot_at         TEXT    NOT NULL,   -- timestamp as seen in THIS file
  values_json         TEXT    NOT NULL,   -- all recognised columns, normalised
  unknown_columns_json TEXT,              -- columns present but unrecognised
  raw_row_json        TEXT    NOT NULL,   -- original CSV row, verbatim
  row_hash            TEXT    NOT NULL,   -- sha256 of values_json; identical re-import is a no-op

  observed_at         TEXT    NOT NULL,   -- when this revision was imported
  created_at          TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_revision_period  ON statement_revisions (period_id, observed_at DESC, id DESC);
CREATE INDEX idx_revision_batch   ON statement_revisions (import_batch_id);

CREATE TABLE income_statement_facts (
  period_id                   INTEGER PRIMARY KEY REFERENCES statement_periods(id) ON DELETE CASCADE,
  company_id                  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_at_us              INTEGER NOT NULL,
  revision_id                 INTEGER NOT NULL REFERENCES statement_revisions(id) ON DELETE CASCADE,

  sales                       INTEGER NOT NULL DEFAULT 0,
  cogs                        INTEGER NOT NULL DEFAULT 0,
  freight_out                 INTEGER NOT NULL DEFAULT 0,
  construction                INTEGER NOT NULL DEFAULT 0,
  exchange_fees               INTEGER NOT NULL DEFAULT 0,
  salaries                    INTEGER NOT NULL DEFAULT 0,
  training                    INTEGER NOT NULL DEFAULT 0,
  poaching                    INTEGER NOT NULL DEFAULT 0,
  achievements_referrals_pa   INTEGER NOT NULL DEFAULT 0,
  patent_conversion           INTEGER NOT NULL DEFAULT 0,
  bond_defaults               INTEGER NOT NULL DEFAULT 0,
  bond_writeoffs              INTEGER NOT NULL DEFAULT 0,
  accounting_overhead         INTEGER NOT NULL DEFAULT 0,
  bond_interest_expense       INTEGER NOT NULL DEFAULT 0,
  bond_interest_income        INTEGER NOT NULL DEFAULT 0,
  donations                   INTEGER NOT NULL DEFAULT 0,
  other_comprehensive_income  INTEGER NOT NULL DEFAULT 0,
  net_income                  INTEGER NOT NULL DEFAULT 0,   -- official Sim Companies value, never recomputed

  computed_net_income INTEGER GENERATED ALWAYS AS (
    sales + cogs + freight_out + construction + exchange_fees + salaries +
    training + poaching + achievements_referrals_pa + patent_conversion +
    bond_defaults + bond_writeoffs + accounting_overhead +
    bond_interest_expense + bond_interest_income + donations
  ) STORED,

  gross_profit INTEGER GENERATED ALWAYS AS (sales + cogs) STORED,

  core_business_result INTEGER GENERATED ALWAYS AS (net_income - achievements_referrals_pa) STORED,

  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_is_facts_time ON income_statement_facts (company_id, snapshot_at_us DESC);

CREATE TABLE cashflow_statement_facts (
  period_id           INTEGER PRIMARY KEY REFERENCES statement_periods(id) ON DELETE CASCADE,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_at_us      INTEGER NOT NULL,
  revision_id         INTEGER NOT NULL REFERENCES statement_revisions(id) ON DELETE CASCADE,

  all_income          INTEGER NOT NULL DEFAULT 0,
  all_expenses        INTEGER NOT NULL DEFAULT 0,   -- already negative
  from_retail         INTEGER NOT NULL DEFAULT 0,
  from_customers      INTEGER NOT NULL DEFAULT 0,
  from_exchange       INTEGER NOT NULL DEFAULT 0,
  from_interest       INTEGER NOT NULL DEFAULT 0,
  from_poaching       INTEGER NOT NULL DEFAULT 0,
  to_suppliers        INTEGER NOT NULL DEFAULT 0,
  to_exchange         INTEGER NOT NULL DEFAULT 0,
  to_employees        INTEGER NOT NULL DEFAULT 0,
  to_executives       INTEGER NOT NULL DEFAULT 0,
  for_interest        INTEGER NOT NULL DEFAULT 0,
  for_fees            INTEGER NOT NULL DEFAULT 0,
  for_accounting      INTEGER NOT NULL DEFAULT 0,
  investment_in_bonds INTEGER NOT NULL DEFAULT 0,
  bonds               INTEGER NOT NULL DEFAULT 0,
  game_income         INTEGER NOT NULL DEFAULT 0,

  net_cash_flow INTEGER GENERATED ALWAYS AS (all_income + all_expenses) STORED,

  unclassified_net INTEGER GENERATED ALWAYS AS (
    (all_income + all_expenses)
    - (from_retail + from_customers + from_exchange + from_interest + from_poaching
       + to_suppliers + to_exchange + to_employees + to_executives
       + for_interest + for_fees + for_accounting
       + game_income)
  ) STORED,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_cf_facts_time ON cashflow_statement_facts (company_id, snapshot_at_us DESC);

CREATE TABLE balance_sheet_facts (
  period_id                       INTEGER PRIMARY KEY REFERENCES statement_periods(id) ON DELETE CASCADE,
  company_id                      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_at_us                  INTEGER NOT NULL,
  revision_id                     INTEGER NOT NULL REFERENCES statement_revisions(id) ON DELETE CASCADE,

  cash                            INTEGER NOT NULL DEFAULT 0,
  accounts_receivable             INTEGER NOT NULL DEFAULT 0,
  inventory_materials             INTEGER NOT NULL DEFAULT 0,
  inventory_research              INTEGER NOT NULL DEFAULT 0,
  inventory_wip                   INTEGER NOT NULL DEFAULT 0,
  inventory_finished_goods        INTEGER NOT NULL DEFAULT 0,
  inventory_valuation_allowance   INTEGER NOT NULL DEFAULT 0,
  deposits                        INTEGER NOT NULL DEFAULT 0,
  investment_in_bonds             INTEGER NOT NULL DEFAULT 0,
  buildings                       INTEGER NOT NULL DEFAULT 0,
  patents                         INTEGER NOT NULL DEFAULT 0,
  liabilities                     INTEGER NOT NULL DEFAULT 0,
  contributed_capital             INTEGER NOT NULL DEFAULT 0,
  retained_earnings               INTEGER NOT NULL DEFAULT 0,

  total_inventory INTEGER GENERATED ALWAYS AS (
    inventory_materials + inventory_research + inventory_wip +
    inventory_finished_goods + inventory_valuation_allowance
  ) STORED,

  total_assets INTEGER GENERATED ALWAYS AS (
    cash + accounts_receivable + inventory_materials + inventory_research +
    inventory_wip + inventory_finished_goods + inventory_valuation_allowance +
    deposits + investment_in_bonds + buildings + patents
  ) STORED,

  total_equity INTEGER GENERATED ALWAYS AS (contributed_capital + retained_earnings) STORED,

  balance_delta INTEGER GENERATED ALWAYS AS (
    (cash + accounts_receivable + inventory_materials + inventory_research +
     inventory_wip + inventory_finished_goods + inventory_valuation_allowance +
     deposits + investment_in_bonds + buildings + patents)
    - (liabilities + contributed_capital + retained_earnings)
  ) STORED,

  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_bs_facts_time ON balance_sheet_facts (company_id, snapshot_at_us DESC);
