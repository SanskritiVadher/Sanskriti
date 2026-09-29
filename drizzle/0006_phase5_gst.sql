CREATE TYPE "public"."gst_note_kind" AS ENUM('CREDIT_NOTE', 'DEBIT_NOTE');--> statement-breakpoint
CREATE TYPE "public"."gst_rule_status" AS ENUM('VERIFIED', 'USER_CONFIRMED', 'SECONDARY_SOURCE', 'UNVERIFIED');--> statement-breakpoint
CREATE TABLE "gst_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"source_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"rate" numeric(18, 2) NOT NULL,
	"taxable" numeric(18, 2) NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"cgst" numeric(18, 2) NOT NULL,
	"sgst" numeric(18, 2) NOT NULL,
	"igst" numeric(18, 2) NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"cost_value" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "gst_note_kind" NOT NULL,
	"party_id" uuid NOT NULL,
	"invoice_id" uuid,
	"bill_id" uuid,
	"entry_id" uuid NOT NULL,
	"number" text NOT NULL,
	"note_date" date NOT NULL,
	"reason" text NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"taxable" numeric(18, 2) NOT NULL,
	"cgst" numeric(18, 2) NOT NULL,
	"sgst" numeric(18, 2) NOT NULL,
	"igst" numeric(18, 2) NOT NULL,
	"round_off" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"cost_value" numeric(18, 2) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gst_rate_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hsn_prefix" text NOT NULL,
	"description" text NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"status" "gst_rule_status" NOT NULL,
	"source_name" text,
	"source_url" text,
	"retrieved_on" date,
	"notes" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gstr2b_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"period" text NOT NULL,
	"file_name" text NOT NULL,
	"docs" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gst_note_lines" ADD CONSTRAINT "gst_note_lines_note_id_gst_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."gst_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_note_lines" ADD CONSTRAINT "gst_note_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_notes" ADD CONSTRAINT "gst_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_notes" ADD CONSTRAINT "gst_notes_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_notes" ADD CONSTRAINT "gst_notes_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_notes" ADD CONSTRAINT "gst_notes_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_notes" ADD CONSTRAINT "gst_notes_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_notes" ADD CONSTRAINT "gst_notes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_rate_rules" ADD CONSTRAINT "gst_rate_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gst_rate_rules" ADD CONSTRAINT "gst_rate_rules_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_imports" ADD CONSTRAINT "gstr2b_imports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstr2b_imports" ADD CONSTRAINT "gstr2b_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gst_notes_company_number_uq" ON "gst_notes" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "gst_notes_company_date_idx" ON "gst_notes" USING btree ("company_id","note_date");--> statement-breakpoint
CREATE INDEX "gst_rules_company_hsn_idx" ON "gst_rate_rules" USING btree ("company_id","hsn_prefix");