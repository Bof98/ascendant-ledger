CREATE TABLE resource_catalog (
  resource_id           INTEGER PRIMARY KEY,   -- the game's numeric id, preserved verbatim
  observed_name         TEXT,                  -- inferred name, NULL until one can be inferred
  observed_name_source  TEXT,                  -- description_inference | details_field
  observed_name_confidence REAL,               -- 0..1; inference from a Description is not certain

  first_seen_at         TEXT    NOT NULL,      -- transaction time of the first sighting
  last_seen_at          TEXT    NOT NULL,
  first_seen_batch_id   TEXT    REFERENCES import_batches(id) ON DELETE SET NULL,
  observation_count     INTEGER NOT NULL DEFAULT 1,

  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,

  CHECK (observed_name_source IS NULL OR observed_name_source IN ('description_inference', 'details_field'))
) STRICT;

CREATE TABLE resource_overrides (
  resource_id   INTEGER PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  note          TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

CREATE TABLE building_catalog (
  catalog_key           TEXT    PRIMARY KEY,   -- 'code:G' | 'name:Farm'
  building_code         TEXT,                  -- verbatim, NULL when the export gave none
  observed_name         TEXT,                  -- verbatim building_name as exported
  last_known_level      INTEGER,               -- from construction rows

  first_seen_at         TEXT    NOT NULL,
  last_seen_at          TEXT    NOT NULL,
  first_seen_batch_id   TEXT    REFERENCES import_batches(id) ON DELETE SET NULL,
  observation_count     INTEGER NOT NULL DEFAULT 1,

  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_building_catalog_code ON building_catalog (building_code)
  WHERE building_code IS NOT NULL;

CREATE TABLE building_overrides (
  catalog_key   TEXT    PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  note          TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

CREATE VIEW resource_resolved AS
SELECT
  c.resource_id,
  COALESCE(o.display_name, c.observed_name, 'Unknown Resource #' || c.resource_id) AS display_name,
  CASE
    WHEN o.display_name    IS NOT NULL THEN 'override'
    WHEN c.observed_name   IS NOT NULL THEN 'observed'
    ELSE 'unknown'
  END                                        AS name_source,
  c.observed_name,
  c.observed_name_confidence,
  o.display_name                             AS override_name,
  o.note                                     AS override_note,
  c.first_seen_at,
  c.last_seen_at,
  c.observation_count
FROM resource_catalog c
LEFT JOIN resource_overrides o ON o.resource_id = c.resource_id;

CREATE VIEW building_resolved AS
SELECT
  c.catalog_key,
  c.building_code,
  COALESCE(
    o.display_name,
    c.observed_name,
    'Building ' || COALESCE(c.building_code, c.catalog_key)
  )                                          AS display_name,
  CASE
    WHEN o.display_name  IS NOT NULL THEN 'override'
    WHEN c.observed_name IS NOT NULL THEN 'observed'
    ELSE 'unknown'
  END                                        AS name_source,
  c.observed_name,
  o.display_name                             AS override_name,
  o.note                                     AS override_note,
  c.last_known_level,
  c.first_seen_at,
  c.last_seen_at,
  c.observation_count
FROM building_catalog c
LEFT JOIN building_overrides o ON o.catalog_key = c.catalog_key;
