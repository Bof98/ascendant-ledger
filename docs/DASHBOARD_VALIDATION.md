# Dashboard validation — 10 September 2026

Reviewed all 18 navigation views against the ledger API and the existing capture
service. Live checks use recorded captures; their timestamps identify the age of
each observation. No gameplay actions were triggered for this audit.

## Corrections

- Captured financial statements now show headings, line labels, signed amounts,
  and subtotals from the capture schema.
- Live unit prices retain up to four decimal places. Monetary estimates retain
  cents. Potential hourly profit explicitly includes idle buildings, and company
  value shows its own capture timestamp.
- Missing imported statements show unknown amounts and source coverage. The
  quality page reports the number of balance sheets checked, without declaring
  success when there are none.
- Gross profit includes Freight Out, matching the game's statement subtotal.
  Migration 0010 preserves imported rows and official Net Income.
- Historical cash movement has an explicit observation window, separate from
  the forward forecast. Missing per-action cash estimates are not presented as
  modeled zeroes. Recorded plan comparisons identify whole-company cash and
  linked events rather than claiming causal performance attribution.
- Date presets consistently use UTC; date-only snapshot labels retain their
  calendar day in other display timezones. Irrelevant date controls are hidden;
  working date controls remain accessible on mobile.
- Full-realm CSV exports are labeled "Export all CSV". Negative numeric values
  remain numeric, while formula-like text remains escaped.
- Empty raw-data views have usable messages; virtual generated columns can be
  sorted. Expanded captured statements stay open on refresh. Navigating away
  cancels obsolete page requests.

## Evidence and limits

26 automated tests cover calculations, imports, duplicates, rollback, populated
database migration, realm boundaries, bridge restrictions, dates, and formatting.
Browser checks cover all views at desktop and 390px widths, fractional-price
search, imported report totals, UTC date labels, filters, exports, raw rows,
realm switching, rollback, and delayed navigation responses.

Synthetic imports were confined to a separate test database. Production still
uses its existing captures and its independent CSV ledger. The API's strategy
forecast and recorded-plan observations retain their backend model limitations;
the dashboard labels their scope rather than treating them as realized profits.

## Saved-capture integration validation

- Added synthetic coverage for read-only backfill, three financial report mappings,
  product attribution, original source provenance, delayed transaction arrivals,
  repeated captures, incomplete reports, year rollover, invalid dates, validation
  failure without cursor advancement, realm mismatch, and revision rollback.
- Added reconciliation coverage including exchange and customer receipts.
- Verified the populated-schema migration still preserves existing records and
  official net income. New captured statement fields default to zero for older CSVs.
- Build and all 33 tests pass. A full isolated backfill followed by an immediate
  repeat produced no duplicate transactions, statement revisions, or import batches.
- Checked 14 live ledger/data pages in Chromium, including statement values,
  populated transactions/products/buildings/market, import history, source status,
  and a 390px mobile viewport. No browser exceptions or document overflow.
- Live sync checks the source every 60 seconds. Historical statement rounding
  differences and account-history coverage gaps remain visible in Data Quality.
