export function healthStatus(summary: {
  core: number;
  netCash: number;
  cashChange: number;
  balanceDelta: number | null;
  grossMargin: number | null;
}): { status: string; score: number; reasons: string[] } {
  let score = 50;
  const reasons: string[] = [];
  if (summary.core > 0) { score += 18; reasons.push('Core business result is profitable.'); }
  else if (summary.core < 0) { score -= 18; reasons.push('Core business result is negative.'); }
  if (summary.netCash > 0) { score += 12; reasons.push('Net cash flow is positive for the selected period.'); }
  else if (summary.netCash < 0) { score -= 12; reasons.push('Net cash flow is negative for the selected period.'); }
  if (summary.cashChange > 0) { score += 8; reasons.push('Cash increased from the previous balance-sheet snapshot.'); }
  else if (summary.cashChange < 0) { score -= 8; reasons.push('Cash decreased from the previous balance-sheet snapshot.'); }
  if (summary.balanceDelta === 0) { score += 7; reasons.push('The latest balance sheet reconciles exactly.'); }
  else if (summary.balanceDelta !== null) { score -= 20; reasons.push('The latest balance sheet is out of balance.'); }
  else { reasons.push('No balance sheet is available in this range; reconciliation is unknown.'); }
  if (summary.grossMargin !== null && summary.grossMargin >= 0.3) { score += 5; reasons.push('Gross margin is at least 30%.'); }
  else if (summary.grossMargin !== null && summary.grossMargin < 0.1) { score -= 8; reasons.push('Gross margin is below 10%.'); }
  score = Math.max(0, Math.min(100, score));
  const status = score >= 80 ? 'Strong' : score >= 65 ? 'Healthy' : score >= 48 ? 'Watch' : score >= 30 ? 'Warning' : 'Critical';
  return { status, score, reasons };
}
