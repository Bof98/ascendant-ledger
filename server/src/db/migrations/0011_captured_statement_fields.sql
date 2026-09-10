-- Preserve captured statement lines separately from their CSV counterparts.
ALTER TABLE income_statement_facts ADD COLUMN executive_royalties INTEGER NOT NULL DEFAULT 0;
ALTER TABLE income_statement_facts ADD COLUMN gain_on_sale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE income_statement_facts DROP COLUMN computed_net_income;
ALTER TABLE income_statement_facts ADD COLUMN computed_net_income INTEGER GENERATED ALWAYS AS (
 sales + cogs + freight_out + construction + exchange_fees + salaries + training + poaching +
 achievements_referrals_pa + patent_conversion + bond_defaults + bond_writeoffs + accounting_overhead +
 bond_interest_expense + bond_interest_income + donations + executive_royalties + gain_on_sale
) VIRTUAL;
ALTER TABLE balance_sheet_facts ADD COLUMN cash_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE balance_sheet_facts ADD COLUMN construction_in_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE balance_sheet_facts DROP COLUMN total_assets;
ALTER TABLE balance_sheet_facts DROP COLUMN balance_delta;
ALTER TABLE balance_sheet_facts ADD COLUMN total_assets INTEGER GENERATED ALWAYS AS (
 cash + cash_reserved + accounts_receivable + inventory_materials + inventory_research + inventory_wip +
 inventory_finished_goods + inventory_valuation_allowance + deposits + investment_in_bonds + buildings +
 construction_in_progress + patents
) VIRTUAL;
ALTER TABLE balance_sheet_facts ADD COLUMN balance_delta INTEGER GENERATED ALWAYS AS (
 total_assets - liabilities - contributed_capital - retained_earnings
) VIRTUAL;
ALTER TABLE cashflow_statement_facts ADD COLUMN from_royalties INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cashflow_statement_facts ADD COLUMN from_employees INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cashflow_statement_facts ADD COLUMN for_pa_quests INTEGER NOT NULL DEFAULT 0;
-- Captured, rounded display lines can differ from the displayed total by a few SIM$.
ALTER TABLE cashflow_statement_facts ADD COLUMN rounding_adjustment INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cashflow_statement_facts DROP COLUMN net_cash_flow;
ALTER TABLE cashflow_statement_facts DROP COLUMN unclassified_net;
ALTER TABLE cashflow_statement_facts ADD COLUMN net_cash_flow INTEGER GENERATED ALWAYS AS (
 all_income + all_expenses + rounding_adjustment
) VIRTUAL;
ALTER TABLE cashflow_statement_facts ADD COLUMN unclassified_net INTEGER GENERATED ALWAYS AS (
 all_income + all_expenses - (from_retail + from_customers + from_exchange + from_interest + from_poaching +
 from_royalties + from_employees + to_suppliers + to_exchange + to_employees + to_executives + for_interest +
 for_fees + for_accounting + for_pa_quests + investment_in_bonds + bonds + game_income)
) VIRTUAL;
