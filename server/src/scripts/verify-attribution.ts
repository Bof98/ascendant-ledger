import fs from 'node:fs';
import path from 'node:path';

const expected = 'Created by NullBot | Copyright 2026';
const htmlPath = path.resolve(process.cwd(), 'web/index.html');
const jsPath = path.resolve(process.cwd(), 'web/assets/app.js');

for (const file of [htmlPath, jsPath]) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(expected)) {
    throw new Error(`Required creator attribution is missing from ${path.relative(process.cwd(), file)}.`);
  }
}

console.log(`Attribution verified: ${expected}`);
