CREATE TYPE "public"."gst_rate_status" AS ENUM('USER_CONFIRMED', 'UNVERIFIED');--> statement-breakpoint
CREATE TYPE "public"."inventory_txn_type" AS ENUM('OPENING', 'PURCHASE', 'SALE', 'PURCHASE_RETURN', 'SALES_RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_IN', 'TRANSFER_OUT');--> statement-breakpoint
CREATE TYPE "public"."party_type" AS ENUM('CUSTOMER', 'SUPPLIER');--> statement-breakpoint
CREATE TYPE "public"."price_level" AS ENUM('DEALER', 'WHOLESALE', 'RETAIL');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"rows" jsonb NOT NULL,
	"status" text DEFAULT 'PREVIEW' NOT NULL,
	"summary" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"txn_date" date NOT NULL,
	"type" "inventory_txn_type" NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost" numeric(18, 4) NOT NULL,
	"value" numeric(18, 2) NOT NULL,
	"entry_id" uuid,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inv_qty_nonzero" CHECK ("inventory_transactions"."quantity" <> 0),
	CONSTRAINT "inv_sign_match" CHECK (("inventory_transactions"."quantity" > 0 AND "inventory_transactions"."value" >= 0) OR ("inventory_transactions"."quantity" < 0 AND "inventory_transactions"."value" <= 0))
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "party_type" NOT NULL,
	"name" text NOT NULL,
	"contact_person" text,
	"phone" text,
	"whatsapp" text,
	"email" text,
	"gstin" text,
	"state_code" text,
	"address_line1" text,
	"city" text,
	"pincode" text,
	"credit_limit" numeric(18, 2),
	"credit_days" integer,
	"price_level" "price_level" DEFAULT 'DEALER' NOT NULL,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"brand_id" uuid,
	"category_id" uuid,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"hsn" text,
	"gst_rate" numeric(5, 2),
	"gst_rate_status" "gst_rate_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"purchase_price" numeric(18, 2),
	"dealer_price" numeric(18, 2),
	"wholesale_price" numeric(18, 2),
	"retail_price" numeric(18, 2),
	"mrp" numeric(18, 2),
	"min_selling_price" numeric(18, 2),
	"reorder_level" numeric(14, 3),
	"track_serial" boolean DEFAULT false NOT NULL,
	"warranty_months" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "party_id" uuid;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_company_name_uq" ON "categories" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "inv_company_product_idx" ON "inventory_transactions" USING btree ("company_id","product_id");--> statement-breakpoint
CREATE INDEX "inv_entry_idx" ON "inventory_transactions" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_company_type_name_uq" ON "parties" USING btree ("company_id","type","name");--> statement-breakpoint
CREATE INDEX "parties_company_type_idx" ON "parties" USING btree ("company_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_sku_uq" ON "products" USING btree ("company_id","sku");--> statement-breakpoint
CREATE INDEX "products_company_name_idx" ON "products" USING btree ("company_id","name");--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jl_party_idx" ON "journal_lines" USING btree ("company_id","party_id");