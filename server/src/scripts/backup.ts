import path from 'node:path';
import { config } from '../config/env.js';
import { backupTo, openDatabase } from '../db/connection.js';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(config.DATA_DIR, 'backups', `ascendant-ledger-${stamp}.db`);

const db = openDatabase({ path: config.databasePath });

try {
  await backupTo(db, destination);
  console.log(destination);
} finally {
  db.close();
}
