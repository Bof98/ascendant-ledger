import fs from 'node:fs';
import path from 'node:path';

// npm start needs the same migrations that Docker includes in its runtime.
const root = process.cwd();
fs.cpSync(path.join(root, 'src/db/migrations'), path.join(root, 'dist/db/migrations'), { recursive: true });
