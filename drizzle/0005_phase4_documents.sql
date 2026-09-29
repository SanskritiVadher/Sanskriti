CREATE TYPE "public"."doc_status" AS ENUM('ACTIVE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."supply_type" AS ENUM('INTRA', 'INTER', 'NONE');--> statement-breakpoint
CREATE TABLE "purchase_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"rate" numeric(18, 2) NOT NULL,
	"taxable" numeric(18, 2) NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"cgst" numeric(18, 2) NOT NULL,
	"sgst" numeric(18, 2) NOT NULL,
	"igst" numeric(18, 2) NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"number" text NOT NULL,
	"bill_number" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"taxable" numeric(18, 2) NOT NULL,
	"cgst" numeric(18, 2) NOT NULL,
	"sgst" numeric(18, 2) NOT NULL,
	"igst" numeric(18, 2) NOT NULL,
	"round_off" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"itc_claimed" boolean NOT NULL,
	"status" "doc_status" DEFAULT 'ACTIVE' NOT NULL,
	"cancel_reason" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"description" text NOT NULL,
	"hsn" text,
	"unit" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"rate" numeric(18, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"taxable" numeric(18, 2) NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"cgst" numeric(18, 2) NOT NULL,
	"sgst" numeric(18, 2) NOT NULL,
	"igst" numeric(18, 2) NOT NULL,
	"line_total" numeric(18, 2) NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"cost_value" numeric(18, 2) NOT NULL,
	"serials" text
);
--> statement-breakpoint
CREATE TABLE "sales_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"doc_type" text NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"place_of_supply" text,
	"customer_name" text NOT NULL,
	"customer_gstin" text,
	"customer_address" text,
	"customer_phone" text,
	"subtotal" numeric(18, 2) NOT NULL,
	"discount" numeric(18, 2) NOT NULL,
	"taxable" numeric(18, 2) NOT NULL,
	"cgst" numeric(18, 2) NOT NULL,
	"sgst" numeric(18, 2) NOT NULL,
	"igst" numeric(18, 2) NOT NULL,
	"round_off" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"cost_of_goods" numeric(18, 2) NOT NULL,
	"paid_at_sale" numeric(18, 2) DEFAULT '0' NOT NULL,
	"payment_entry_id" uuid,
	"status" "doc_status" DEFAULT 'ACTIVE' NOT NULL,
	"cancel_reason" text,
	"credit_override_reason" text,
	"notes" text,
	"share_token" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_bill_id_purchase_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."purchase_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_payment_entry_id_journal_entries_id_fk" FOREIGN KEY ("payment_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pb_company_number_uq" ON "purchase_bills" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "pb_party_billno_idx" ON "purchase_bills" USING btree ("company_id","party_id","bill_number");--> statement-breakpoint
CREATE INDEX "pb_company_date_idx" ON "purchase_bills" USING btree ("company_id","bill_date");--> statement-breakpoint
CREATE UNIQUE INDEX "si_company_number_uq" ON "sales_invoices" USING btree ("company_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "si_share_token_uq" ON "sales_invoices" USING btree ("share_token");--> statement-breakpoint
CREATE INDEX "si_company_date_idx" ON "sales_invoices" USING btree ("company_id","invoice_date");--> statement-breakpoint
CREATE INDEX "si_party_idx" ON "sales_invoices" USING btree ("company_id","party_id");