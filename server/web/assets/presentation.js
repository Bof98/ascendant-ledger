export function formatAmount(value, symbol = '$', digits = 2) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return `${n < 0 ? '-' : ''}${symbol}${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

export function capturedStatementLines(rows, formatMoney) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (row.k === 'h') return [row.text || 'Section', ''];
    return [row.label || (row.k === 's' ? 'Subtotal' : 'Line item'),
      row.value == null ? (row.raw || row.text || '—') : formatMoney(row.value)];
  });
}

export function forecastSummary(data) {
  const actions = new Set(['produce', 'retail', 'buy_resource', 'sell_to_exchange', 'build', 'upgrade']);
  const recommendations = (data.recommendations || []).filter(rec => actions.has(rec.action));
  const modeled = recommendations.filter(rec => typeof rec.params?.expected_cash_delta === 'number' && Number.isFinite(rec.params.expected_cash_delta));
  return {
    available: recommendations.length > 0 && modeled.length === recommendations.length,
    modeledCount: modeled.length,
    actionCount: recommendations.length,
  };
}

export function utcDateRange(preset, now = new Date()) {
  const ymd = d => d.toISOString().slice(0, 10);
  let from = '', to = '';
  if (preset === 'today') from = to = ymd(now);
  else if (preset === 'yesterday' || /^\d+$/.test(preset)) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - (preset === 'yesterday' ? 1 : Number(preset) - 1));
    from = ymd(d); to = preset === 'yesterday' ? from : ymd(now);
  } else if (preset === 'month') {
    from = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))); to = ymd(now);
  } else if (preset === 'previousMonth') {
    from = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    to = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)));
  }
  return { from, to };
}
