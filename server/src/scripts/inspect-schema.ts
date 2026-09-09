import { config } from '../config/env.js';
import { openDatabase } from '../db/connection.js';

const db = openDatabase({ path: config.databasePath, readonly: true });

try {
  const rows = db
    .prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all();
  console.log(JSON.stringify(rows, null, 2));
} finally {
  db.close();
}
