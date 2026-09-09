INSERT INTO companies (id, name, created_at, updated_at)
VALUES (1, 'My Magnates Company',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO app_settings (key, value_json, updated_at) VALUES
  ('company.activeId',        '1',                    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('app.name',                '"Ascendant Ledger"',   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('display.timezone',        '"UTC"',                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('display.currencySymbol',  '"$"',                  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('display.theme',           '"system"',             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('import.maxFileBytes',     '26214400',             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('import.maxFilesPerBatch', '20',                   strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('dashboard.showUnreconciledTail', 'true',          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO core_result_rules
  (company_id, rule_type, target, action, enabled, is_builtin, rationale, created_at, updated_at)
VALUES
  (1, 'income_statement_line', 'achievements_referrals_pa', 'exclude', 1, 1,
   'Achievements, referrals, and promotional awards are excluded from the derived Core Business Result so normal operations can be viewed separately. Official Net Income remains unchanged.',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
