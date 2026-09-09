import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQLite connection.
 *
 * better-sqlite3 is synchronous, which is the right shape here: this is a
 * single-process, single-user application, and synchronous calls remove a whole
 * class of interleaving bugs from the import pipeline's transactions.
 *
 * Pragma choices:
 *   journal_mode = WAL     readers never block the importer, and the database
 *                          survives an unclean container stop.
 *   synchronous = NORMAL   the safe pairing with WAL; FULL would fsync on every
 *                          commit, which is wasted latency for this workload.
 *   foreign_keys = ON      SQLite disables FK enforcement by default. It has to
 *                          be switched on per connection, every time.
 *   busy_timeout           the backup routine briefly holds a lock.
 */

export interface OpenOptions {
  /** Absolute path to the .db file. Its directory is created if missing. */
  path: string;
  readonly?: boolean;
  /** Emits every statement to stderr. Development only. */
  verbose?: boolean;
}

export type Db = Database.Database;

export function openDatabase(options: OpenOptions): Db {
  const dir = path.dirname(options.path);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  assertWritableDirectory(dir);

  const db = new Database(options.path, {
    readonly: options.readonly ?? false,
    ...(options.verbose ? { verbose: (msg: unknown) => console.error(String(msg)) } : {}),
  });

  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -32000'); // ~32 MB page cache

  return db;
}

/**
 * Fails loudly at boot if DATA_DIR is not writable. Without this the first
 * symptom of a bad volume mount is a confusing error deep inside an import.
 */
function assertWritableDirectory(dir: string): void {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(
      `Data directory is not writable: ${dir}\n` +
        'Check the volume mount and its ownership. Inside the container the ' +
        'application runs as uid 10001.',
    );
  }
}

/**
 * Lightweight structural check used by the frequent Docker healthcheck.
 * quick_check catches the same common corruption classes without doing the
 * much more expensive full integrity scan every 30 seconds as history grows.
 */
export function checkIntegrity(db: Db): { ok: boolean; detail: string } {
  const rows = db.pragma('quick_check(1)') as Array<Record<string, string>>;
  const detail = rows.map((r) => Object.values(r)[0] ?? '').join('; ');
  return { ok: detail === 'ok', detail };
}


/**
 * Online backup. SQLite's backup API is snapshot-consistent and safe to run
 * while the application is serving, unlike copying the .db file by hand while
 * a WAL is active (spec section 36).
 */
export async function backupTo(db: Db, destination: string): Promise<void> {
  const dir = path.dirname(destination);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await db.backup(destination);
}
