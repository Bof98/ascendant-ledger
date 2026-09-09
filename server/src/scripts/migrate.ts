import { config } from '../config/env.js';
import { openDatabase, checkIntegrity } from '../db/connection.js';
import { migrate } from '../db/migrate.js';

/**
 * Runs pending migrations against the configured database and exits.
 * Invoked by `npm run migrate` and by the container entrypoint before boot.
 */

const db = openDatabase({ path: config.databasePath });

try {
  console.log(`database: ${config.databasePath}`);

  const result = migrate(db, { log: (m) => console.log(`  ${m}`) });

  if (result.applied.length === 0) {
    console.log(`up to date (${result.alreadyApplied.length} migrations already applied)`);
  } else {
    console.log(`applied ${result.applied.length} migration(s)`);
  }

  const integrity = checkIntegrity(db);
  if (!integrity.ok) {
    console.error(`integrity_check failed: ${integrity.detail}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  db.close();
}
