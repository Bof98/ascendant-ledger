CREATE TABLE data_quality_findings (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  check_code    TEXT    NOT NULL,   -- e.g. balance_sheet_unbalanced, net_income_mismatch
  severity      TEXT    NOT NULL,   -- info | warning | error
  subject_type  TEXT    NOT NULL,   -- statement_period | transaction | import_file | catalog | global
  subject_id    TEXT,               -- id of the subject, as text
  occurred_at   TEXT,               -- the business timestamp the finding relates to

  message       TEXT    NOT NULL,   -- human-readable, includes the supporting numbers
  details_json  TEXT,               -- structured supporting values

  detected_at   TEXT    NOT NULL,
  resolved_at   TEXT,               -- set when a later import clears the finding
  acknowledged_at TEXT,             -- set when the user dismisses it

  CHECK (severity IN ('info', 'warning', 'error')),
  CHECK (subject_type IN ('statement_period', 'transaction', 'import_file', 'catalog', 'global'))
) STRICT;

CREATE UNIQUE INDEX uq_dq_check_subject
  ON data_quality_findings (company_id, check_code, subject_type, COALESCE(subject_id, ''));
CREATE INDEX idx_dq_open
  ON data_quality_findings (company_id, severity, detected_at DESC)
  WHERE resolved_at IS NULL;

CREATE TABLE core_result_rules (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rule_type     TEXT    NOT NULL,   -- income_statement_line | transaction_category
  target        TEXT    NOT NULL,   -- column name or category name
  action        TEXT    NOT NULL,   -- exclude
  enabled       INTEGER NOT NULL DEFAULT 1,
  is_builtin    INTEGER NOT NULL DEFAULT 0,
  rationale     TEXT,               -- shown in the metric's tooltip
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,

  CHECK (rule_type IN ('income_statement_line', 'transaction_category')),
  CHECK (action IN ('exclude')),
  CHECK (enabled IN (0, 1)),
  CHECK (is_builtin IN (0, 1))
) STRICT;

CREATE UNIQUE INDEX uq_core_rule ON core_result_rules (company_id, rule_type, target);
