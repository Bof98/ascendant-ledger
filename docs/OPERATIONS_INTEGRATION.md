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
