CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"ip" text,
	"ok" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sessions_valid_after" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "login_attempts_email_idx" ON "login_attempts" USING btree ("email","at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip","at");--> statement-breakpoint
CREATE INDEX "gnl_note_idx" ON "gst_note_lines" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "pbl_bill_idx" ON "purchase_bill_lines" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "pbl_product_idx" ON "purchase_bill_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sil_invoice_idx" ON "sales_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "sil_product_idx" ON "sales_invoice_lines" USING btree ("product_id");