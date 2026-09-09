DROP INDEX IF EXISTS uq_dq_check_subject;
DROP INDEX IF EXISTS idx_dq_open;

ALTER TABLE data_quality_findings RENAME TO data_quality_findings_old;

CREATE TABLE data_quality_findings (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  check_code    TEXT    NOT NULL,
  severity      TEXT    NOT NULL,
  subject_type  TEXT    NOT NULL,
  subject_id    TEXT    NOT NULL DEFAULT '',
  occurred_at   TEXT,

  message       TEXT    NOT NULL,
  details_json  TEXT,

  detected_at   TEXT    NOT NULL,
  resolved_at   TEXT,
  acknowledged_at TEXT,

  CHECK (severity IN ('info', 'warning', 'error')),
  CHECK (subject_type IN ('statement_period', 'transaction', 'import_file', 'catalog', 'global'))
) STRICT;

INSERT INTO data_quality_findings
  (id, company_id, check_code, severity, subject_type, subject_id, occurred_at,
   message, details_json, detected_at, resolved_at, acknowledged_at)
SELECT
  id, company_id, check_code, severity, subject_type, COALESCE(subject_id, ''), occurred_at,
  message, details_json, detected_at, resolved_at, acknowledged_at
FROM data_quality_findings_old;

DROP TABLE data_quality_findings_old;

CREATE UNIQUE INDEX uq_dq_check_subject
  ON data_quality_findings (company_id, check_code, subject_type, subject_id);

CREATE INDEX idx_dq_open
  ON data_quality_findings (company_id, severity, detected_at DESC)
  WHERE resolved_at IS NULL;
