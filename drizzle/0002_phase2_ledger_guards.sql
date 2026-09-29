-- Database-level guarantees for the ledger. These hold even if application code has a bug
-- or someone writes to the database directly.

-- 1) Every journal entry must balance (debits = credits = total_amount) and have at least 2 lines.
--    Checked at COMMIT (deferred), so the entry and its lines can be inserted in one transaction.
CREATE OR REPLACE FUNCTION ledger_check_entry_balanced() RETURNS trigger AS $$
DECLARE
  eid uuid;
  d numeric; c numeric; n int; total numeric;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN eid := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN eid := OLD.entry_id;
  ELSE eid := NEW.entry_id; END IF;

  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO d, c, n
    FROM journal_lines WHERE entry_id = eid;
  SELECT total_amount INTO total FROM journal_entries WHERE id = eid;

  IF n < 2 THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: entry % has % line(s); at least 2 are required', eid, n;
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: entry % debits % <> credits %', eid, d, c;
  END IF;
  IF total IS DISTINCT FROM d THEN
    RAISE EXCEPTION 'LEDGER_UNBALANCED: entry % total_amount % <> line total %', eid, total, d;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_balanced();
--> statement-breakpoint

-- 2) Posted lines are permanent. Corrections are made by reversal, never by editing or deleting.
CREATE OR REPLACE FUNCTION ledger_lines_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_IMMUTABLE: journal lines cannot be %; post a reversal instead', lower(TG_OP);
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_lines_no_change BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_lines_immutable();
--> statement-breakpoint

-- 3) Entries cannot be deleted; the only allowed update is marking POSTED -> REVERSED once.
CREATE OR REPLACE FUNCTION ledger_entries_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LEDGER_IMMUTABLE: journal entries cannot be deleted; post a reversal instead';
  END IF;
  IF OLD.status <> 'POSTED' OR NEW.status <> 'REVERSED' OR NEW.reversed_by_id IS NULL
     OR NEW.company_id <> OLD.company_id OR NEW.period_id <> OLD.period_id
     OR NEW.voucher_type <> OLD.voucher_type OR NEW.voucher_number <> OLD.voucher_number
     OR NEW.entry_date <> OLD.entry_date OR NEW.total_amount <> OLD.total_amount
     OR NEW.narration IS DISTINCT FROM OLD.narration OR NEW.created_by <> OLD.created_by
     OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id THEN
    RAISE EXCEPTION 'LEDGER_IMMUTABLE: a posted entry can only be marked as reversed';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_entries_guard BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_guard();
--> statement-breakpoint

-- 4) A line's account and entry must belong to the same company as the line.
CREATE OR REPLACE FUNCTION ledger_line_company_check() RETURNS trigger AS $$
BEGIN
  IF (SELECT company_id FROM accounts WHERE id = NEW.account_id) <> NEW.company_id
     OR (SELECT company_id FROM journal_entries WHERE id = NEW.entry_id) <> NEW.company_id THEN
    RAISE EXCEPTION 'LEDGER_COMPANY_MISMATCH: line account/entry belong to a different company';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_lines_company BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_line_company_check();
