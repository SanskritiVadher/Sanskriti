-- Customer/supplier rules on ledger lines, enforced by the database.
CREATE OR REPLACE FUNCTION ledger_line_party_check() RETURNS trigger AS $$
DECLARE
  k text; ptype text; pcomp uuid;
BEGIN
  SELECT system_key INTO k FROM accounts WHERE id = NEW.account_id;
  IF NEW.party_id IS NOT NULL THEN
    SELECT type::text, company_id INTO ptype, pcomp FROM parties WHERE id = NEW.party_id;
    IF pcomp IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'LEDGER_PARTY: party belongs to a different company';
    END IF;
    IF k IN ('DEBTORS_CONTROL', 'CUSTOMER_ADVANCES') AND ptype <> 'CUSTOMER' THEN
      RAISE EXCEPTION 'LEDGER_PARTY: % needs a customer', k;
    ELSIF k IN ('CREDITORS_CONTROL', 'SUPPLIER_ADVANCES') AND ptype <> 'SUPPLIER' THEN
      RAISE EXCEPTION 'LEDGER_PARTY: % needs a supplier', k;
    ELSIF k IS NULL OR k NOT IN ('DEBTORS_CONTROL', 'CUSTOMER_ADVANCES', 'CREDITORS_CONTROL', 'SUPPLIER_ADVANCES') THEN
      RAISE EXCEPTION 'LEDGER_PARTY: a customer/supplier can only be tagged on dues or advance accounts';
    END IF;
  ELSIF k IN ('DEBTORS_CONTROL', 'CREDITORS_CONTROL') THEN
    RAISE EXCEPTION 'LEDGER_PARTY: % lines must name the customer/supplier', k;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_lines_party BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_line_party_check();
--> statement-breakpoint

-- Stock movements are permanent; corrections are new movements.
CREATE OR REPLACE FUNCTION inventory_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'INVENTORY_IMMUTABLE: stock movements cannot be %; record a correcting movement instead', lower(TG_OP);
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER inventory_no_change BEFORE UPDATE OR DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION inventory_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION inventory_company_check() RETURNS trigger AS $$
BEGIN
  IF (SELECT company_id FROM products WHERE id = NEW.product_id) <> NEW.company_id
     OR (SELECT company_id FROM warehouses WHERE id = NEW.warehouse_id) <> NEW.company_id THEN
    RAISE EXCEPTION 'INVENTORY_COMPANY_MISMATCH';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER inventory_company BEFORE INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION inventory_company_check();
