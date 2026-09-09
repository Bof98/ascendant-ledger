CREATE TABLE companies (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

CREATE TABLE app_settings (
  key           TEXT    PRIMARY KEY,
  value_json    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

CREATE TABLE app_users (
  id              INTEGER PRIMARY KEY,
  username        TEXT    NOT NULL UNIQUE,
  password_hash   TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  last_login_at   TEXT
) STRICT;
