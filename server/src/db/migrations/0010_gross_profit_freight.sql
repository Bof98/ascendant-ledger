-- Sim Companies includes Freight Out in the Gross Profit subtotal.
-- Use a virtual generated column so this upgrade also supports populated ledgers.
ALTER TABLE income_statement_facts DROP COLUMN gross_profit;
ALTER TABLE income_statement_facts ADD COLUMN gross_profit INTEGER
  GENERATED ALWAYS AS (sales + cogs + freight_out) VIRTUAL;
