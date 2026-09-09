CREATE TABLE account_transactions (
  id                    INTEGER PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  external_id           INTEGER NOT NULL,     -- Sim Companies `id`
  occurred_at           TEXT    NOT NULL,     -- original ISO-8601 UTC string, verbatim
  occurred_at_us        INTEGER NOT NULL,     -- microsecond epoch, for indexed range scans

  category              TEXT    NOT NULL,     -- free text: production|sales|market|fees|construction|game and anything new
  money                 INTEGER NOT NULL,     -- whole SIM$, signed exactly as exported
  description           TEXT    NOT NULL,
  details_raw           TEXT    NOT NULL,     -- the Details cell exactly as it appeared, always preserved

  details_ok            INTEGER NOT NULL DEFAULT 1,   -- 0 when JSON.parse failed
  details_error         TEXT,
  details_json          TEXT,                 -- normalised re-serialisation, NULL when parse failed
  detail_version        INTEGER,              -- the game's own `version` field

  amount                INTEGER,              -- units; exact for market rows, absent for retail sales
  price_text            TEXT,                 -- exact original decimal string
  price_real            REAL,                 -- analytic only, never used for cash math
  unit_cogs_text        TEXT,
  unit_cogs_real        REAL,
  quality               REAL,
  remaining             INTEGER,
  profit                INTEGER,
  level                 INTEGER,

  building_code         TEXT,                 -- e.g. 'G', 'W'; absent on some rows
  building_name         TEXT,                 -- e.g. 'Grocery store', 'Water reservoir', 'Farm'
  building_key          TEXT,                 -- resolved catalog key, see 0005

  resource_id           INTEGER,              -- numeric resource id (market order fills)
  counterparty_name     TEXT,                 -- from `sellers` or `buyer`
  counterparty_role     TEXT,                 -- seller | buyer

  product_name          TEXT,
  product_source        TEXT,                 -- description | resource_id | manual

  unknown_detail_keys_json TEXT,              -- JSON array of key names

  raw_row_json          TEXT    NOT NULL,

  first_seen_batch_id   TEXT    NOT NULL REFERENCES import_batches(id),
  first_seen_file_id    TEXT    NOT NULL REFERENCES import_files(id),
  last_seen_batch_id    TEXT    REFERENCES import_batches(id),
  last_seen_at          TEXT,
  observation_count     INTEGER NOT NULL DEFAULT 1,

  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,

  CHECK (details_ok IN (0, 1)),
  CHECK (counterparty_role IS NULL OR counterparty_role IN ('seller', 'buyer'))
) STRICT;

CREATE UNIQUE INDEX uq_tx_company_external ON account_transactions (company_id, external_id);

CREATE INDEX idx_tx_time        ON account_transactions (company_id, occurred_at_us DESC);
CREATE INDEX idx_tx_cat_time    ON account_transactions (company_id, category, occurred_at_us DESC);
CREATE INDEX idx_tx_product     ON account_transactions (company_id, product_name, occurred_at_us DESC)
  WHERE product_name IS NOT NULL;
CREATE INDEX idx_tx_building    ON account_transactions (company_id, building_key, occurred_at_us DESC)
  WHERE building_key IS NOT NULL;
CREATE INDEX idx_tx_counterparty ON account_transactions (company_id, counterparty_name, occurred_at_us DESC)
  WHERE counterparty_name IS NOT NULL;
CREATE INDEX idx_tx_first_batch ON account_transactions (first_seen_batch_id);
CREATE INDEX idx_tx_sign        ON account_transactions (company_id, money);

CREATE VIRTUAL TABLE account_transactions_fts USING fts5(
  description,
  product_name,
  building_name,
  counterparty_name,
  category,
  content = 'account_transactions',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_tx_fts_insert AFTER INSERT ON account_transactions BEGIN
  INSERT INTO account_transactions_fts (rowid, description, product_name, building_name, counterparty_name, category)
  VALUES (new.id, new.description, new.product_name, new.building_name, new.counterparty_name, new.category);
END;

CREATE TRIGGER trg_tx_fts_delete AFTER DELETE ON account_transactions BEGIN
  INSERT INTO account_transactions_fts (account_transactions_fts, rowid, description, product_name, building_name, counterparty_name, category)
  VALUES ('delete', old.id, old.description, old.product_name, old.building_name, old.counterparty_name, old.category);
END;

CREATE TRIGGER trg_tx_fts_update AFTER UPDATE ON account_transactions BEGIN
  INSERT INTO account_transactions_fts (account_transactions_fts, rowid, description, product_name, building_name, counterparty_name, category)
  VALUES ('delete', old.id, old.description, old.product_name, old.building_name, old.counterparty_name, old.category);
  INSERT INTO account_transactions_fts (rowid, description, product_name, building_name, counterparty_name, category)
  VALUES (new.id, new.description, new.product_name, new.building_name, new.counterparty_name, new.category);
END;
