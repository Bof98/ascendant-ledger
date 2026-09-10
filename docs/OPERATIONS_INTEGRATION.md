# SimCompanies dashboard integration

This fork retains Ascendant Ledger's CSV accounting system and adds live overview,
strategy, activity, and market views backed by the existing Flask capture service.
The original console remains available for its detailed controls and other views.

## Data ownership

- Ascendant Ledger owns its own SQLite database, CSV imports, and accounting reports.
- The existing Python service owns captures, strategy, scheduling, and game sessions.
- `/api/operations/:endpoint` forwards only allowlisted GET endpoints to the configured
  backend. It does not forward browser cookies or expose action/capture POST routes.
- The selected realm must match `OPERATIONS_REALM` and the backend's `/api/state`
  realm (`0` = Magnates, `1` = Entrepreneurs). A mismatch fails closed. Backend realm
  checks are cached for ten seconds.
- GET `/api/strategy` retains the existing backend's behavior, including recording
  forecast plans. No new scheduler or game automation is started by this dashboard.
- Live estimates and captured statements are displayed separately from imported
  official accounting totals. There is no automatic CSV conversion or double counting.

## Configure

Set `OPERATIONS_URL` to the internal Flask base URL, `OPERATIONS_REALM` to its
realm, and `OPERATIONS_CONSOLE_PATH` to the original console's same-origin path.
The default timeout is 30 seconds. Omit `OPERATIONS_URL` to run the standalone ledger.
All bridge endpoints inherit the ledger's authentication hook. Keep the existing
ingress access controls when changing proxy routes.

The browser uses relative assets and APIs so both root hosting and stripped proxy
mounts work. The reverse proxy must redirect the bare mount to its trailing-slash form.

## Existing server deployment

The supplied `deploy/ascendant-ledger.service` expects this checkout at
`/home/ubuntu/SimCompanies/ascendant-ledger`, built with Node 22. Create the persistent
`data` directory before starting the service. Its environment file must set `HOST`,
`PORT`, `DATA_DIR`, `OPERATIONS_URL`, and appropriate authentication/proxy settings.

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` in `server`.
The build copies SQL migrations, allowing `npm start` to work outside Docker too.

Example Caddy routes (use the actual configured ports):

```caddyfile
redir /simcompanies /simcompanies/
handle_path /simcompanies/* {
    reverse_proxy 172.18.0.1:5011
}
redir /simcompanies-classic /simcompanies-classic/
handle_path /simcompanies-classic/* {
    reverse_proxy 172.18.0.1:5010
}
```

Rollback: restore `/simcompanies/*` to the Flask service on port 5010 and reload
the validated proxy configuration. No Python database migration is required.

## Validation

Tests cover bridge realm isolation, allowlisting, bounded queries, upstream failures,
credential isolation, root/subpath URL construction, and missing-balance-sheet health
scoring, in addition to upstream's six CSV/realm installation tests.

License and NullBot attribution are retained. Never commit environment files,
captures, exported company records, SQLite databases, or local backup files.

## Automatic capture backfill and sync

Set `OPERATIONS_DB_PATH` to the existing capture service's SQLite file to opt in.
`OPERATIONS_URL` must also be set: each sync verifies the live service realm
against `OPERATIONS_REALM` before importing. `CAPTURE_SYNC_INTERVAL_MS` defaults
to 60000. The source database is opened read-only with `query_only`; this does
not trigger game capture, collection, trading, or any other game action.

The source database must contain history exclusively for the configured realm.
Its historical rows have no realm column: current realm verification cannot
establish the realm of old rows. Do not point this connection at a mixed-realm
database. Stop the connection before switching that capture database's realm.

Saved `cashflow_entries` use their genuine game transaction IDs. Every sync
checks IDs so late historical arrivals are included. Statement snapshots use
their own UTC accounting dates and period starts, with years anchored to the
capture timestamp. Repeated snapshots become one daily report. Only changed
values create revisions; preparation placeholders and incomplete/unsupported
reports cannot overwrite complete statements. Cursor progress is saved after
successful import. Source failures preserve the existing ledger and retry on
the next timer. `/api/capture-sync?realm=magnates` reports status and skipped
capture diagnostics without exposing the source path.

Captured values travel through the existing CSV import pipeline as generated
files named `captured-*.csv`; they are not presented as downloaded game CSVs.
Original statement JSON, capture IDs/times, period starts, transaction category
codes and description keys remain in raw source rows. Import History records
an explicit automatic-sync note. Normal CSV uploads remain supported and
transaction IDs deduplicate across both sources.

Rounded display lines occasionally differ by 1–2 SIM$ from the displayed
cash-flow total. An explicit rounding-adjustment field preserves both values;
a difference over 5 SIM$ rejects that capture. Small captured balance-sheet
rounding differences are informational quality findings. All other existing
reconciliation checks remain visible, including gaps in account history.
Financial statement periods and transaction coverage need not start together.

Disable `OPERATIONS_DB_PATH` and restart the ledger to stop automatic sync.
Rollback still works for imported revisions, but while sync is active removed
captured transaction IDs will be backfilled again. To reprocess all snapshots
(e.g. after extending a field mapping), disable sync, back up the ledger, remove
only `app_settings` key `capture-sync:<realm>`, then restart with sync enabled.

## Automatic official CSV downloads

Configure `CSV_STORAGE_STATE_PATH` with the existing Playwright login-state file
and `CSV_COMPANY_ID` with the intended game's numeric company ID. The session
file is only read; session renewal remains with the capture service's normal
login flow. `OPERATIONS_REALM` selects the ledger destination. Downloads do not
switch companies or realms and do not perform gameplay actions.

The ledger watches `capture_sources.json` next to `OPERATIONS_DB_PATH`. When the
capture worker marks a new accounting-page visit, it downloads the CSVs once.
Other page visits, dashboard/status requests, and elapsed hours do not trigger
CSV downloads. There is no independent CSV timer. A persisted visit timestamp
prevents repeats across restarts; a new visit while the ledger was offline is
picked up once on restart. Failures retry at the next accounting-page visit.
When switching from the former hourly mode, the existing marker becomes the
baseline without fetching it again. Each attempt checks company ID and realm through
the game's `/api/v3/companies/auth-data/` endpoint, downloads Account History,
Income Statement, Balance Sheet, and Cash Flow Statement from the game's CSV
endpoints, then checks identity again before importing. Requests are GET-only,
restricted to `https://www.simcompanies.com`, reject redirects, and forward only
unexpired cookies scoped to that host and request path. Response sizes and
request durations are bounded. Login pages, mismatched identities, rate limits,
and invalid/empty exports leave existing imports intact and appear in status.

All four files are validated before importing. Exact original bytes are retained
under `DATA_DIR/csv-downloads/<realm>/<sha256>-<filename>` with private file
permissions. Unchanged exports reuse their stored file and do not create another
import batch. New files use the existing transactional import pipeline and its
transaction-ID deduplication. Import History distinguishes downloaded originals
from generated capture files. `/api/csv-sync?realm=magnates` shows the most recent
attempt, success, error, triggering capture timestamp, file hashes and row counts; it never
exposes session cookies or the session-file path.

Official uploaded or downloaded CSV statements take precedence over rounded
screen captures. The capture sync still fills in recent account activity and
statement dates that have no official CSV yet. This precedence is checked again
inside the import transaction, so a capture staged before a concurrent CSV import
cannot overwrite it. To disable downloads, remove both CSV session and company
settings and restart only the ledger service. Archives remain available locally;
include the data directory in normal backups.

Some official export schemas omit fields present in captured reports (notably
construction in progress). For those specific fields only, absent CSV columns
are supplemented from a retained capture of the same statement date. Values
actually supplied by the CSV always win. The revision's raw source row records
`Captured supplemental fields` with the contributing capture revision ID and
values; the archived downloaded file is never edited. Captured cash-flow
rounding adjustments are not carried into CSV totals.
