ALTER TABLE companies ADD COLUMN realm TEXT;

UPDATE companies
SET realm = 'magnates'
WHERE id = 1 AND realm IS NULL;

CREATE UNIQUE INDEX uq_companies_realm
  ON companies (realm)
  WHERE realm IS NOT NULL;

INSERT INTO companies (name, created_at, updated_at, realm)
SELECT 'My Entrepreneurs Company',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       'entrepreneurs'
WHERE NOT EXISTS (SELECT 1 FROM companies WHERE realm = 'entrepreneurs');

INSERT OR IGNORE INTO core_result_rules
  (company_id, rule_type, target, action, enabled, is_builtin, rationale, created_at, updated_at)
SELECT
  c.id, 'income_statement_line', 'achievements_referrals_pa', 'exclude', 1, 1,
  'Achievements, referrals, and promotional awards are excluded from the derived Core Business Result so normal operations can be viewed separately. Official Net Income remains unchanged.',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM companies c
WHERE c.realm = 'entrepreneurs';
