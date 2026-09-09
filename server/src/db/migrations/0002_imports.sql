CREATE TABLE import_batches (
  id            TEXT    PRIMARY KEY,          -- uuid v4
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status        TEXT    NOT NULL,             -- pending | committed | rolled_back | failed
  created_at    TEXT    NOT NULL,
  committed_at  TEXT,
  rolled_back_at TEXT,
  file_count    INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  CHECK (status IN ('pending', 'committed', 'rolled_back', 'failed'))
) STRICT;

CREATE INDEX idx_import_batches_company_created
  ON import_batches (company_id, created_at DESC);

CREATE TABLE import_files (
  id                    TEXT    PRIMARY KEY,  -- uuid v4
  batch_id              TEXT    NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  original_filename     TEXT    NOT NULL,     -- exactly as uploaded
  safe_filename         TEXT    NOT NULL,     -- sanitised, used for any on-disk copy
  file_sha256           TEXT    NOT NULL,     -- lets us recognise a byte-identical re-upload
  file_size_bytes       INTEGER NOT NULL,

  detected_type         TEXT,                 -- account_history | income_statement | cashflow_statement | balance_sheet | NULL when unrecognised
  detection_score       REAL,                 -- 0..1 header-signature match strength
  detection_method      TEXT,                 -- header_signature | manual_override
  schema_version        INTEGER NOT NULL DEFAULT 1,

  header_raw_json       TEXT,                 -- JSON array of header cells, verbatim
  unknown_headers_json  TEXT,                 -- JSON array of unrecognised header cells

  rows_total            INTEGER NOT NULL DEFAULT 0,
  rows_inserted         INTEGER NOT NULL DEFAULT 0,
  rows_updated          INTEGER NOT NULL DEFAULT 0,
  rows_duplicate        INTEGER NOT NULL DEFAULT 0,
  rows_invalid          INTEGER NOT NULL DEFAULT 0,

  period_start          TEXT,
  period_end            TEXT,

  warnings_json         TEXT,                 -- JSON array of {code, message, rowNumber?}
  status                TEXT    NOT NULL,     -- pending | committed | rolled_back | failed
  error_message         TEXT,
  created_at            TEXT    NOT NULL,
  committed_at          TEXT,

  CHECK (status IN ('pending', 'committed', 'rolled_back', 'failed'))
) STRICT;

CREATE INDEX idx_import_files_batch     ON import_files (batch_id);
CREATE INDEX idx_import_files_sha       ON import_files (company_id, file_sha256);
CREATE INDEX idx_import_files_type_time ON import_files (company_id, detected_type, created_at DESC);

CREATE TABLE import_rejected_rows (
  id              INTEGER PRIMARY KEY,
  import_file_id  TEXT    NOT NULL REFERENCES import_files(id) ON DELETE CASCADE,
  row_number      INTEGER NOT NULL,           -- 1-based, excluding the header
  raw_row_json    TEXT    NOT NULL,           -- JSON object of the original cells
  error_code      TEXT    NOT NULL,
  error_message   TEXT    NOT NULL,
  created_at      TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_import_rejected_file ON import_rejected_rows (import_file_id);
