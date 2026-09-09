# Sim Companies CSV compatibility notes

Ascendant Ledger recognizes supported exports from their **column headers**, not their filenames. This document describes the parser contract using generic field names only; it intentionally contains no player/company exports.

## Account History

Recognized columns:

- `id`
- `Timestamp`
- `Category`
- `Money`
- `Description`
- `Details`

`Details` is JSON. Known fields can include `version`, `price`, `quality`, `amount`, `building`, `building_name`, `unit_cogs`, `remaining`, `sellers`, `resource`, `buyer`, `profit`, and `level`. Unknown JSON keys are preserved rather than causing the import to fail.

Transaction IDs are deduplicated **within a Realm**. The raw CSV row and raw Details JSON are retained for provenance.

## Income Statement

Recognized columns include `Timestamp`, `Sales`, `COGS`, `Freight Out`, `Construction`, `Exchange Fees`, `Salaries`, `Training`, `Poaching`, `Achievements Referrals PA`, `Patent Conversion`, `Bond Defaults`, `Bond Writeoffs`, `Accounting Overhead`, `Bond Interest Expense`, `Bond Interest Income`, `Donations`, `Other Comprehensive Income`, and `NetIncome`.

Signed values are preserved exactly as exported. Official Net Income remains distinct from the app's derived Core Business Result.

## Cash Flow Statement

Recognized columns include `Timestamp`, `All income`, `All expenses`, retail/customer/exchange/interest/poaching inflows, supplier/exchange/employee/executive/interest/fee/accounting outflows, bond activity, and `Game income`.

## Balance Sheet

Recognized columns include `Timestamp`, `Cash`, `Accounts Receivable`, inventory categories, `Deposits`, `Investment in bonds`, `Buildings`, `Patents`, `Liabilities`, `Contributed Capital`, and `Retained Earnings`.

The app checks the accounting identity Assets = Liabilities + Equity and reports a data-quality finding when the imported snapshot does not reconcile.

## Forward compatibility

The importer tolerates extra columns, records schema warnings, and preserves unknown source fields. Missing optional columns are treated conservatively. CSV parsing supports quoted commas/quotes, UTF-8/BOM input, and malformed-row reporting.

When Sim Companies changes an export format, please open a GitHub issue with **sanitized headers and synthetic/example rows only**. Do not attach your real company exports unless you are comfortable making that information public.
