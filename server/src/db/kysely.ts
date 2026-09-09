import { Kysely, SqliteDialect, type LogEvent } from 'kysely';
import type { Db } from './connection.js';
import type { Database } from './types.js';

/**
 * Wraps an already-open better-sqlite3 handle in Kysely.
 *
 * The raw handle is kept alongside the Kysely instance because a few operations
 * need it directly: PRAGMA statements, the online backup API, and the FTS5 MATCH
 * queries that are clearer written as raw SQL.
 */
export function createQueryBuilder(db: Db, options: { debug?: boolean } = {}): Kysely<Database> {
  const log = (event: LogEvent): void => {
    if (event.level === 'error') {
      console.error('query failed', event.query.sql, event.error);
    } else {
      console.error(`query ${event.queryDurationMillis.toFixed(1)}ms`, event.query.sql);
    }
  };

  // Spread rather than `log: undefined`, which exactOptionalPropertyTypes rejects.
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: db }),
    ...(options.debug ? { log } : {}),
  });
}
