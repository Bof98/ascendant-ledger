import { describe, expect, it } from 'vitest';
import { healthStatus } from './health.js';

describe('financial health evidence', () => {
  const summary = { core: 0, netCash: 0, cashChange: 0, grossMargin: null };
  it('does not award reconciliation points for a missing balance sheet', () => {
    const missing = healthStatus({ ...summary, balanceDelta: null });
    const reconciled = healthStatus({ ...summary, balanceDelta: 0 });
    expect(missing.score).toBe(50);
    expect(reconciled.score).toBe(57);
    expect(missing.reasons).not.toContain('The latest balance sheet reconciles exactly.');
    expect(missing.reasons.some(reason => reason.includes('unknown'))).toBe(true);
  });
  it('still penalizes an observed reconciliation difference', () => {
    expect(healthStatus({ ...summary, balanceDelta: 1 }).score).toBe(30);
  });
});
