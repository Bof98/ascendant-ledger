# Contributing

Contributions are welcome.

Before opening a pull request:

1. Do not include real Sim Companies exports or another player's private data.
2. Use synthetic/anonymized fixtures for tests.
3. Run `npm run preflight` inside `server`, or `./preflight.sh` from the repository root.
4. Preserve accounting sign conventions and the separation between official statement totals and Account History analytics.
5. Keep Realm-specific financial data scoped by `company_id`.
6. Add a new migration instead of editing a migration already released to users.

Bug reports should include the application version and a sanitized description of the affected CSV schema. Never attach a real database unless you intentionally want to disclose its contents.
