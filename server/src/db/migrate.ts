import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Db } from './connection.js';

/**
 * Forward-only SQL migration runner.
 *
 * Migrations are plain .sql files applied in filename order, each inside its own
 * transaction. Hand-written SQL rather than a generator because this schema uses
 * STRICT tables, stored generated columns, partial indexes and an FTS5 virtual
 * table with sync triggers — all of which are clearer written directly than
 * coaxed out of a migration DSL.
 *
 * Each applied file's SHA-256 is recorded. If a file that has already run is
 * later edited, the next startup fails rather than leaving two deployments with
 * silently divergent schemas.
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: string;
  durationMs: number;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

function ensureMigrationTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TEXT NOT NULL,
      duration_ms INTEGER NOT NULL
    ) STRICT;
  `);
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function readMigrationFiles(dir: string): Array<{ name: string; sql: string; checksum: string }> {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort() // zero-padded numeric prefixes make lexical order the correct order
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      return { name, sql, checksum: sha256(sql) };
    });
}

export function listApplied(db: Db): AppliedMigration[] {
  ensureMigrationTable(db);
  return db
    .prepare(
      `SELECT name, checksum, applied_at AS appliedAt, duration_ms AS durationMs
         FROM _migrations ORDER BY name`,
    )
    .all() as AppliedMigration[];
}

export function migrate(db: Db, options: { dir?: string; log?: (m: string) => void } = {}): MigrateResult {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? (() => {});

  ensureMigrationTable(db);

  const files = readMigrationFiles(dir);
  const applied = new Map(listApplied(db).map((m) => [m.name, m.checksum]));

  const result: MigrateResult = { applied: [], alreadyApplied: [] };

  for (const file of files) {
    const previousChecksum = applied.get(file.name);

    if (previousChecksum !== undefined) {
      if (previousChecksum !== file.checksum) {
        throw new Error(
          `Migration ${file.name} has changed since it was applied.\n` +
            `  recorded: ${previousChecksum}\n` +
            `  on disk:  ${file.checksum}\n` +
            'Applied migrations are immutable. Add a new migration instead of editing this one.',
        );
      }
      result.alreadyApplied.push(file.name);
      continue;
    }

    const started = Date.now();

    // A DDL-only migration is transactional in SQLite, so a failure part-way
    // through leaves the schema untouched.
    const run = db.transaction(() => {
      db.exec(file.sql);
      db.prepare(
        `INSERT INTO _migrations (name, checksum, applied_at, duration_ms)
         VALUES (?, ?, ?, ?)`,
      ).run(file.name, file.checksum, new Date().toISOString(), Date.now() - started);
    });

    try {
      run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${file.name} failed: ${reason}`);
    }

    log(`applied ${file.name} (${Date.now() - started}ms)`);
    result.applied.push(file.name);
  }

  return result;
}
