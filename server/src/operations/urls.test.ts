import { expect, it } from 'vitest';
import fs from 'node:fs/promises';

// Execute the same browser module without adding a frontend build dependency.
const source = await fs.readFile(new URL('../../web/assets/urls.js', import.meta.url), 'utf8');
const { scopedApiUrl } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

it('keeps API requests and CSV downloads under the proxy mount', () => {
  expect(scopedApiUrl('/api/dashboard?from=2026-01-01', 'magnates', 'https://example.com/simcompanies/assets/app.js')).toBe('/simcompanies/api/dashboard?from=2026-01-01&realm=magnates');
  expect(scopedApiUrl('/api/export/transactions.csv', 'entrepreneurs', 'https://example.com/simcompanies/assets/app.js')).toBe('/simcompanies/api/export/transactions.csv?realm=entrepreneurs');
});

it('also supports standalone hosting at the root', () => {
  expect(scopedApiUrl('/api/meta', 'magnates', 'http://localhost:8080/assets/app.js')).toBe('/api/meta?realm=magnates');
});
