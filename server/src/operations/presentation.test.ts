import { expect, it } from 'vitest';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../../web/assets/presentation.js', import.meta.url), 'utf8');
const { formatAmount, capturedStatementLines, forecastSummary, utcDateRange } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

it('preserves fractional prices, negative amounts and unknown values', () => {
  expect(formatAmount(0.24, '$', 4)).toBe('$0.24');
  expect(formatAmount(1.2345, '$', 4)).toBe('$1.2345');
  expect(formatAmount(-12.35)).toBe('-$12.35');
  expect(formatAmount(0)).toBe('$0');
  for (const missing of [null, undefined, '', NaN]) expect(formatAmount(missing)).toBe('—');
});

it('renders captured statement labels and amounts instead of parser row codes', () => {
  expect(capturedStatementLines([
    { k: 'h', text: 'GROSS PROFIT' },
    { k: 'r', label: 'Sales', value: 1000 },
    { k: 'r', label: 'Cost of goods sold', value: -600 },
    { k: 's', value: 400 },
    { k: 'r', label: 'Unparsed', raw: 'Pending' },
  ], formatAmount)).toEqual([['GROSS PROFIT', ''], ['Sales', '$1,000'], ['Cost of goods sold', '-$600'], ['Subtotal', '$400'], ['Unparsed', 'Pending']]);
});

it('does not present missing forecast estimates as a modeled zero cash change', () => {
  const recommendation = { action: 'buy_resource', params: {} };
  expect(forecastSummary({ recommendations: [recommendation] }).available).toBe(false);
  expect(forecastSummary({ recommendations: [{ ...recommendation, params: { expected_cash_delta: 0 } }] }).available).toBe(true);
});

it('keeps date presets on UTC calendar boundaries', () => {
  const now = new Date('2026-03-01T00:15:00Z');
  expect(utcDateRange('yesterday', now)).toEqual({ from: '2026-02-28', to: '2026-02-28' });
  expect(utcDateRange('7', now)).toEqual({ from: '2026-02-23', to: '2026-03-01' });
  expect(utcDateRange('previousMonth', now)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
});
