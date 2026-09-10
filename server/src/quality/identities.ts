import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { nowIso } from '../domain/time.js';

/**
 * Cross-statement reconciliation.
 *
 * Five identities were verified against the reference exports during schema
 * design. They hold exactly, so any future deviation is real signal: either the
 * export changed or something went wrong on import. Each is checked after every
 * import and written to `data_quality_findings` rather than thrown, because the
 * spec is explicit that unexpected data is reported and preserved, never
 * discarded.
 *
 *   1. NetIncome = sum of every Income Statement line except Other
 *      Comprehensive Income.                                   (4/4 exact)
 *   2. Assets = Liabilities + Equity.                          (4/4 exact)
 *   3. Change in Retained Earnings
 *        = (NetIncome - Achievements Referrals PA) + OCI.      (3/3 exact)
 *   4. Change in Contributed Capital = Achievements Referrals PA. (3/3 exact)
 *   5. Income Statement Sales - cash receipts from retail, exchange and customers
 *        = change in Accounts Receivable.                      (3/3 exact)
 *
 * Identities 1 and 2 are enforced structurally by stored generated columns, so
 * the checks here read the pre-computed delta. Identities 3, 4 and 5 span
 * consecutive periods and two different statements, which no single generated
 * column can express, so they are computed here.
 *
 * The company's first snapshot is exempt. At inception, opening capital and
 * buildings appear with no matching transactions and identities 3-5 genuinely do
 * not hold; reporting that every time would train the user to ignore the panel.
 */

export type FindingSeverity = 'info' | 'warning' | 'error';

export interface Finding {
  checkCode: string;
  severity: FindingSeverity;
  subjectType: 'statement_period' | 'transaction' | 'import_file' | 'catalog' | 'global';
  subjectId: string | null;
  occurredAt: string | null;
  message: string;
  details: Record<string, unknown>;
}

export async function runIdentityChecks(
  db: Kysely<Database>,
  companyId: number,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  const income = await db
    .selectFrom('income_statement_facts as f')
    .innerJoin('statement_periods as p', 'p.id', 'f.period_id')
    .select([
      'p.id as period_id',
      'p.snapshot_date',
      'p.snapshot_at',
      'p.is_inception',
      'f.snapshot_at_us',
      'f.sales',
      'f.net_income',
      'f.computed_net_income',
      'f.achievements_referrals_pa',
      'f.other_comprehensive_income',
    ])
    .where('f.company_id', '=', companyId)
    .orderBy('f.snapshot_at_us', 'asc')
    .execute();

  const balance = await db
    .selectFrom('balance_sheet_facts as f')
    .innerJoin('statement_revisions as r', 'r.id', 'f.revision_id')
    .innerJoin('statement_periods as p', 'p.id', 'f.period_id')
    .select([
      'p.id as period_id',
      'p.snapshot_date',
      'p.is_inception',
      'f.snapshot_at_us',
      'r.raw_row_json',
      'f.balance_delta',
      'f.total_assets',
      'f.liabilities',
      'f.total_equity',
      'f.retained_earnings',
      'f.contributed_capital',
      'f.accounts_receivable',
    ])
    .where('f.company_id', '=', companyId)
    .orderBy('f.snapshot_at_us', 'asc')
    .execute();

  const cashflow = await db
    .selectFrom('cashflow_statement_facts as f')
    .innerJoin('statement_periods as p', 'p.id', 'f.period_id')
    .select([
      'p.id as period_id',
      'p.snapshot_date',
      'f.snapshot_at_us',
      'f.from_retail',
      'f.from_exchange',
      'f.from_customers',
      'f.net_cash_flow',
      'f.unclassified_net',
    ])
    .where('f.company_id', '=', companyId)
    .orderBy('f.snapshot_at_us', 'asc')
    .execute();

  // Identity 1 — reads the generated column.
  for (const row of income) {
    if (row.net_income !== row.computed_net_income) {
      findings.push({
        checkCode: 'income_statement_net_income_mismatch',
        severity: 'error',
        subjectType: 'statement_period',
        subjectId: String(row.period_id),
        occurredAt: row.snapshot_at,
        message: `Income Statement for ${row.snapshot_date}: reported Net Income ${row.net_income} does not equal the sum of its line items excluding Other Comprehensive Income (${row.computed_net_income}).`,
        details: {
          reported: row.net_income,
          computed: row.computed_net_income,
          difference: row.net_income - row.computed_net_income,
        },
      });
    }
  }

  // Identity 2 — reads the generated column.
  for (const row of balance) {
    if (row.balance_delta !== 0) {
      const roundedCapture = JSON.parse(row.raw_row_json)['Source kind'] === 'saved game capture' && Math.abs(row.balance_delta) <= 5;
      findings.push({
        checkCode: roundedCapture ? 'captured_balance_rounding_difference' : 'balance_sheet_unbalanced',
        severity: roundedCapture ? 'info' : 'error',
        subjectType: 'statement_period',
        subjectId: String(row.period_id),
        occurredAt: row.snapshot_date,
        message: `${roundedCapture ? 'Rounded captured balance-sheet lines' : 'Balance Sheet'} for ${row.snapshot_date} differ. Assets ${row.total_assets} against Liabilities plus Equity ${row.liabilities + row.total_equity}, a difference of ${row.balance_delta}.`,
        details: {
          totalAssets: row.total_assets,
          liabilities: row.liabilities,
          totalEquity: row.total_equity,
          difference: row.balance_delta,
        },
      });
    }
  }

  const incomeByDate = new Map(income.map((r) => [r.snapshot_date, r]));
  const cashflowByDate = new Map(cashflow.map((r) => [r.snapshot_date, r]));

  // Identities 3, 4 and 5 need consecutive balance sheets.
  for (let i = 1; i < balance.length; i += 1) {
    const previous = balance[i - 1]!;
    const current = balance[i]!;
    const is = incomeByDate.get(current.snapshot_date);
    const cf = cashflowByDate.get(current.snapshot_date);

    // Skip the pair that straddles inception; see the note above.
    if (previous.is_inception === 1) continue;

    if (is) {
      const actualRetained = current.retained_earnings - previous.retained_earnings;
      const expectedRetained =
        is.net_income - is.achievements_referrals_pa + is.other_comprehensive_income;

      if (actualRetained !== expectedRetained) {
        findings.push({
          checkCode: 'retained_earnings_bridge_mismatch',
          severity: 'warning',
          subjectType: 'statement_period',
          subjectId: String(current.period_id),
          occurredAt: current.snapshot_date,
          message: `Retained Earnings moved by ${actualRetained} on ${current.snapshot_date}, but Net Income less Achievements plus Other Comprehensive Income predicts ${expectedRetained}.`,
          details: {
            actual: actualRetained,
            expected: expectedRetained,
            netIncome: is.net_income,
            achievements: is.achievements_referrals_pa,
            otherComprehensiveIncome: is.other_comprehensive_income,
          },
        });
      }

      const actualContributed = current.contributed_capital - previous.contributed_capital;
      if (actualContributed !== is.achievements_referrals_pa) {
        findings.push({
          checkCode: 'contributed_capital_bridge_mismatch',
          severity: 'warning',
          subjectType: 'statement_period',
          subjectId: String(current.period_id),
          occurredAt: current.snapshot_date,
          message: `Contributed Capital moved by ${actualContributed} on ${current.snapshot_date}, but Achievements Referrals PA reports ${is.achievements_referrals_pa}.`,
          details: { actual: actualContributed, expected: is.achievements_referrals_pa },
        });
      }

      if (cf) {
        const actualReceivable = current.accounts_receivable - previous.accounts_receivable;
        const expectedReceivable = is.sales - cf.from_retail - cf.from_exchange - cf.from_customers;
        if (actualReceivable !== expectedReceivable) {
          findings.push({
            checkCode: 'accrual_cash_bridge_mismatch',
            severity: 'warning',
            subjectType: 'statement_period',
            subjectId: String(current.period_id),
            occurredAt: current.snapshot_date,
            message: `Accounts Receivable moved by ${actualReceivable} on ${current.snapshot_date}, but accrual Sales ${is.sales} less cash from retail, exchange and customers ${cf.from_retail + cf.from_exchange + cf.from_customers} predicts ${expectedReceivable}.`,
            details: {
              actual: actualReceivable,
              expected: expectedReceivable,
              sales: is.sales,
              fromRetail: cf.from_retail,
              fromExchange: cf.from_exchange,
              fromCustomers: cf.from_customers,
            },
          });
        }
      }
    }
  }

  // Informational: cash flow component columns do not always sum to the two
  // authoritative totals. Observed on 2 of the 4 reference days. The totals are
  // treated as authoritative and the residual is surfaced, not hidden.
  for (const row of cashflow) {
    if (row.unclassified_net !== 0) {
      findings.push({
        checkCode: 'cashflow_unclassified_residual',
        severity: 'info',
        subjectType: 'statement_period',
        subjectId: String(row.period_id),
        occurredAt: row.snapshot_date,
        message: `Cash Flow for ${row.snapshot_date} has ${row.unclassified_net} of movement not attributed to any named component column. The reported totals remain authoritative.`,
        details: { residual: row.unclassified_net, netCashFlow: row.net_cash_flow },
      });
    }
  }

  return findings;
}

/**
 * Reconciles Account History against Cash Flow over each snapshot window.
 *
 * Verified exact on all four reference windows: the sum of transaction `Money`
 * inside `(previous snapshot, this snapshot]` equals `All income + All expenses`.
 *
 * Note the window is NOT a calendar day. Statement snapshots land around
 * 01:00-01:15 UTC and drift, so grouping transactions by UTC date and comparing
 * would produce a spurious mismatch every single day.
 */
export async function runTransactionReconciliation(
  db: Kysely<Database>,
  companyId: number,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  const periods = await db
    .selectFrom('cashflow_statement_facts as f')
    .innerJoin('statement_periods as p', 'p.id', 'f.period_id')
    .select([
      'p.id as period_id',
      'p.snapshot_date',
      'p.snapshot_at_us',
      'p.period_start_at_us',
      'p.is_inception',
      'f.net_cash_flow',
    ])
    .where('f.company_id', '=', companyId)
    .orderBy('p.snapshot_at_us', 'asc')
    .execute();

  for (const period of periods) {
    if (period.is_inception === 1 || period.period_start_at_us === null) continue;

    const result = await db
      .selectFrom('account_transactions')
      .select((eb) => eb.fn.sum<number>('money').as('total'))
      .where('company_id', '=', companyId)
      .where('occurred_at_us', '>', period.period_start_at_us)
      .where('occurred_at_us', '<=', period.snapshot_at_us)
      .executeTakeFirst();

    const total = Number(result?.total ?? 0);
    if (total !== period.net_cash_flow) {
      findings.push({
        checkCode: 'transaction_cashflow_window_mismatch',
        severity: 'warning',
        subjectType: 'statement_period',
        subjectId: String(period.period_id),
        occurredAt: period.snapshot_date,
        message: `Account History transactions in the window ending ${period.snapshot_date} total ${total}, but the Cash Flow statement reports net movement of ${period.net_cash_flow}.`,
        details: { transactionTotal: total, netCashFlow: period.net_cash_flow },
      });
    }
  }

  return findings;
}

/**
 * Reports transactions newer than the most recent statement snapshot.
 *
 * These are real and correctly stored, but no official statement covers them
 * yet. The dashboard labels the gap rather than blending operational totals into
 * authoritative accounting figures.
 */
export async function findUnreconciledTail(
  db: Kysely<Database>,
  companyId: number,
): Promise<Finding | null> {
  const latest = await db
    .selectFrom('statement_periods')
    .select(['snapshot_at_us', 'snapshot_date'])
    .where('company_id', '=', companyId)
    .orderBy('snapshot_at_us', 'desc')
    .executeTakeFirst();

  if (!latest) return null;

  const tail = await db
    .selectFrom('account_transactions')
    .select((eb) => [eb.fn.countAll<number>().as('count'), eb.fn.sum<number>('money').as('total')])
    .where('company_id', '=', companyId)
    .where('occurred_at_us', '>', latest.snapshot_at_us)
    .executeTakeFirst();

  const count = Number(tail?.count ?? 0);
  if (count === 0) return null;

  return {
    checkCode: 'unreconciled_transaction_tail',
    severity: 'info',
    subjectType: 'global',
    subjectId: null,
    occurredAt: latest.snapshot_date,
    message: `${count} transaction${count === 1 ? '' : 's'} occurred after the most recent statement snapshot (${latest.snapshot_date}), totalling ${Number(tail?.total ?? 0)}. These are not yet reflected in official accounting totals.`,
    details: { count, total: Number(tail?.total ?? 0), latestSnapshot: latest.snapshot_date },
  };
}

/** Upserts findings, keyed by (check, subject) so a re-run updates in place. */
export async function persistFindings(
  db: Kysely<Database>,
  companyId: number,
  findings: readonly Finding[],
): Promise<void> {
  const now = nowIso();
  const seen = new Set<string>();

  for (const finding of findings) {
    seen.add(`${finding.checkCode}::${finding.subjectType}::${finding.subjectId ?? ''}`);
    await db
      .insertInto('data_quality_findings')
      .values({
        company_id: companyId,
        check_code: finding.checkCode,
        severity: finding.severity,
        subject_type: finding.subjectType,
        subject_id: finding.subjectId ?? '',
        occurred_at: finding.occurredAt,
        message: finding.message,
        details_json: JSON.stringify(finding.details),
        detected_at: now,
        resolved_at: null,
        acknowledged_at: null,
      })
      .onConflict((oc) =>
        oc
          .columns(['company_id', 'check_code', 'subject_type', 'subject_id'])
          .doUpdateSet({
            severity: finding.severity,
            message: finding.message,
            details_json: JSON.stringify(finding.details),
            detected_at: now,
            resolved_at: null,
          }),
      )
      .execute();
  }

  // Anything previously recorded but no longer reproducible has been fixed by a
  // later import. Marked resolved rather than deleted, so the history survives.
  const open = await db
    .selectFrom('data_quality_findings')
    .select(['id', 'check_code', 'subject_type', 'subject_id'])
    .where('company_id', '=', companyId)
    .where('resolved_at', 'is', null)
    .execute();

  for (const row of open) {
    const key = `${row.check_code}::${row.subject_type}::${row.subject_id}`;
    if (!seen.has(key)) {
      await db
        .updateTable('data_quality_findings')
        .set({ resolved_at: now })
        .where('id', '=', row.id)
        .execute();
    }
  }
}
