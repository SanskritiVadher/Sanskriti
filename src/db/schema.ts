/**
 * BizOS database schema (Drizzle ORM, PostgreSQL).
 * Phase 1: companies, users, roles, audit, chart of accounts, banks, brands, settings.
 * Rule: money is numeric(18,2) handled as strings + decimal.js. Never float.
 */
import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, date, jsonb,
  uniqueIndex, index, numeric, check, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const roleEnum = pgEnum("role", [
  "OWNER", "ADMIN", "ACCOUNTANT", "SALESPERSON", "PURCHASE_MANAGER", "INVENTORY_MANAGER", "VIEWER",
]);
export const gstRegEnum = pgEnum("gst_registration", ["REGULAR", "COMPOSITION", "UNREGISTERED"]);
export const natureEnum = pgEnum("account_nature", ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"]);
export const valuationEnum = pgEnum("inventory_valuation", ["WEIGHTED_AVERAGE", "FIFO"]);

const ts = (n: string) => timestamp(n, { withTimezone: true });

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  phone: text("phone"),
  email: text("email"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  pincode: text("pincode"),
  stateCode: text("state_code"),
  gstRegistration: gstRegEnum("gst_registration").notNull().default("REGULAR"),
  gstin: text("gstin"),
  pan: text("pan"),
  financialYearStartMonth: integer("fy_start_month").notNull().default(4),
  inventoryValuation: valuationEnum("inventory_valuation").notNull().default("WEIGHTED_AVERAGE"),
  booksBeginOn: date("books_begin_on"),
  setupStep: integer("setup_step").notNull().default(1),
  setupCompletedAt: ts("setup_completed_at"),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  lastLoginAt: ts("last_login_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_uq").on(t.email)]);

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  role: roleEnum("role").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("memberships_user_company_uq").on(t.userId, t.companyId)]);

export const warehouses = pgTable("warehouses", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
}, (t) => [uniqueIndex("warehouses_company_name_uq").on(t.companyId, t.name)]);

export const accountGroups = pgTable("account_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  ownerLabel: text("owner_label").notNull(),
  nature: natureEnum("nature").notNull(),
  parentId: uuid("parent_id").references((): AnyPgColumn => accountGroups.id),
  isSystem: boolean("is_system").notNull().default(true),
}, (t) => [uniqueIndex("account_groups_company_code_uq").on(t.companyId, t.code)]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  groupId: uuid("group_id").notNull().references(() => accountGroups.id, { onDelete: "restrict" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  ownerLabel: text("owner_label").notNull(),
  nature: natureEnum("nature").notNull(),
  /** Stable key the posting engine looks up, e.g. INPUT_CGST. Null for user-created ledgers. */
  systemKey: text("system_key"),
  isSystem: boolean("is_system").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("accounts_company_code_uq").on(t.companyId, t.code),
  uniqueIndex("accounts_company_syskey_uq").on(t.companyId, t.systemKey),
  index("accounts_company_group_idx").on(t.companyId, t.groupId),
]);

export const bankAccounts = pgTable("bank_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  bankName: text("bank_name").notNull(),
  accountHolder: text("account_holder"),
  /** Only the last 4 digits are stored. */
  accountNumberLast4: text("account_number_last4"),
  ifsc: text("ifsc"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("bank_accounts_account_uq").on(t.accountId)]);

export const brands = pgTable("brands", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("brands_company_name_uq").on(t.companyId, t.name)]);

export const financialPeriods = pgTable("financial_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  isClosed: boolean("is_closed").notNull().default(false),
}, (t) => [uniqueIndex("periods_company_start_uq").on(t.companyId, t.startDate)]);

export const settings = pgTable("settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
}, (t) => [uniqueIndex("settings_company_key_uq").on(t.companyId, t.key)]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  source: text("source").notNull().default("app"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  index("audit_company_created_idx").on(t.companyId, t.createdAt),
  index("audit_entity_idx").on(t.entityType, t.entityId),
]);

// ───────────────────────── Phase 2: accounting engine ─────────────────────────

export const voucherTypeEnum = pgEnum("voucher_type", [
  "OPENING", "JOURNAL", "RECEIPT", "PAYMENT", "CONTRA", "REVERSAL",
  "SALES", "PURCHASE", "CREDIT_NOTE", "DEBIT_NOTE", "STOCK_ADJUSTMENT",
]);
export const entryStatusEnum = pgEnum("entry_status", ["POSTED", "REVERSED"]);

const money = (n: string) => numeric(n, { precision: 18, scale: 2 });

export const journalEntries = pgTable("journal_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  periodId: uuid("period_id").notNull().references(() => financialPeriods.id, { onDelete: "restrict" }),
  voucherType: voucherTypeEnum("voucher_type").notNull(),
  voucherNumber: text("voucher_number").notNull(),
  entryDate: date("entry_date").notNull(),
  narration: text("narration"),
  status: entryStatusEnum("status").notNull().default("POSTED"),
  totalAmount: money("total_amount").notNull(),
  reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => journalEntries.id),
  reversedById: uuid("reversed_by_id").references((): AnyPgColumn => journalEntries.id),
  reversalReason: text("reversal_reason"),
  /** Where this entry came from, e.g. "manual", "opening", later "invoice". */
  sourceType: text("source_type").notNull().default("manual"),
  sourceId: text("source_id"),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("je_company_number_uq").on(t.companyId, t.voucherNumber),
  index("je_company_date_idx").on(t.companyId, t.entryDate),
  index("je_source_idx").on(t.sourceType, t.sourceId),
]);

export const journalLines = pgTable("journal_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  entryId: uuid("entry_id").notNull().references(() => journalEntries.id, { onDelete: "restrict" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "restrict" }),
  lineNo: integer("line_no").notNull(),
  /** Customer/supplier this line belongs to. Required on the debtors/creditors control accounts. */
  partyId: uuid("party_id").references((): AnyPgColumn => parties.id, { onDelete: "restrict" }),
  debit: money("debit").notNull().default("0"),
  credit: money("credit").notNull().default("0"),
  narration: text("narration"),
}, (t) => [
  index("jl_account_idx").on(t.companyId, t.accountId),
  index("jl_entry_idx").on(t.entryId),
  index("jl_party_idx").on(t.companyId, t.partyId),
  check("jl_non_negative", sql`${t.debit} >= 0 AND ${t.credit} >= 0`),
  check("jl_one_sided", sql`(${t.debit} = 0) <> (${t.credit} = 0)`),
]);

/** Gap-free voucher numbering per company, voucher type and financial year. Row-locked when used. */
export const voucherSequences = pgTable("voucher_sequences", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  voucherType: voucherTypeEnum("voucher_type").notNull(),
  periodId: uuid("period_id").notNull().references(() => financialPeriods.id, { onDelete: "restrict" }),
  nextNumber: integer("next_number").notNull().default(1),
}, (t) => [uniqueIndex("vseq_uq").on(t.companyId, t.voucherType, t.periodId)]);

// ───────────────────────── Phase 3: products, parties, inventory ─────────────────────────
export const partyTypeEnum = pgEnum("party_type", ["CUSTOMER", "SUPPLIER"]);
export const priceLevelEnum = pgEnum("price_level", ["DEALER", "WHOLESALE", "RETAIL"]);
export const gstRateStatusEnum = pgEnum("gst_rate_status", ["USER_CONFIRMED", "UNVERIFIED"]);
export const invTxnTypeEnum = pgEnum("inventory_txn_type", [
  "OPENING", "PURCHASE", "SALE", "PURCHASE_RETURN", "SALES_RETURN", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "TRANSFER_IN", "TRANSFER_OUT",
]);

const qty = (n: string) => numeric(n, { precision: 14, scale: 3 });

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
}, (t) => [uniqueIndex("categories_company_name_uq").on(t.companyId, t.name)]);

export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  brandId: uuid("brand_id").references(() => brands.id, { onDelete: "restrict" }),
  categoryId: uuid("category_id").references(() => categories.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  hsn: text("hsn"),
  /** Owner-entered rate. Verified GST rules arrive in Phase 5; until then the status says so. */
  gstRate: numeric("gst_rate", { precision: 5, scale: 2 }),
  gstRateStatus: gstRateStatusEnum("gst_rate_status").notNull().default("UNVERIFIED"),
  unit: text("unit").notNull().default("pcs"),
  purchasePrice: money("purchase_price"),
  dealerPrice: money("dealer_price"),
  wholesalePrice: money("wholesale_price"),
  retailPrice: money("retail_price"),
  mrp: money("mrp"),
  minSellingPrice: money("min_selling_price"),
  reorderLevel: qty("reorder_level"),
  trackSerial: boolean("track_serial").notNull().default(false),
  warrantyMonths: integer("warranty_months"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("products_company_sku_uq").on(t.companyId, t.sku),
  index("products_company_name_idx").on(t.companyId, t.name),
]);

export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  type: partyTypeEnum("type").notNull(),
  name: text("name").notNull(),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  whatsapp: text("whatsapp"),
  email: text("email"),
  gstin: text("gstin"),
  stateCode: text("state_code"),
  addressLine1: text("address_line1"),
  city: text("city"),
  pincode: text("pincode"),
  creditLimit: money("credit_limit"),
  creditDays: integer("credit_days"),
  priceLevel: priceLevelEnum("price_level").notNull().default("DEALER"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("parties_company_type_name_uq").on(t.companyId, t.type, t.name),
  index("parties_company_type_idx").on(t.companyId, t.type),
]);

/** Every stock movement. Quantity is signed (+in / −out); value is signed and in rupees. Never edited. */
export const inventoryTransactions = pgTable("inventory_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  warehouseId: uuid("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  txnDate: date("txn_date").notNull(),
  type: invTxnTypeEnum("type").notNull(),
  quantity: qty("quantity").notNull(),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
  value: money("value").notNull(),
  entryId: uuid("entry_id").references(() => journalEntries.id, { onDelete: "restrict" }),
  sourceType: text("source_type").notNull().default("manual"),
  sourceId: text("source_id"),
  note: text("note"),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  index("inv_company_product_idx").on(t.companyId, t.productId),
  index("inv_entry_idx").on(t.entryId),
  check("inv_qty_nonzero", sql`${t.quantity} <> 0`),
  check("inv_sign_match", sql`(${t.quantity} > 0 AND ${t.value} >= 0) OR (${t.quantity} < 0 AND ${t.value} <= 0)`),
]);

/** Parsed uploads waiting for the owner to review and confirm. */
export const importBatches = pgTable("import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  kind: text("kind").notNull(), // products | customers | suppliers
  fileName: text("file_name").notNull(),
  rows: jsonb("rows").notNull(),
  status: text("status").notNull().default("PREVIEW"), // PREVIEW | IMPORTED | DISCARDED
  summary: jsonb("summary"),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

// ───────────────────────── Phase 4: sales & purchase documents ─────────────────────────
export const docStatusEnum = pgEnum("doc_status", ["ACTIVE", "CANCELLED"]);
export const supplyTypeEnum = pgEnum("supply_type", ["INTRA", "INTER", "NONE"]);

/** Sales invoice. Its number is the ledger voucher number (gap-free). Figures are stored as issued. */
export const salesInvoices = pgTable("sales_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "restrict" }),
  entryId: uuid("entry_id").notNull().references(() => journalEntries.id, { onDelete: "restrict" }),
  number: text("number").notNull(),
  invoiceDate: date("invoice_date").notNull(),
  dueDate: date("due_date").notNull(),
  docType: text("doc_type").notNull(), // TAX_INVOICE | BILL_OF_SUPPLY
  supplyType: supplyTypeEnum("supply_type").notNull(),
  placeOfSupply: text("place_of_supply"),
  customerName: text("customer_name").notNull(),
  customerGstin: text("customer_gstin"),
  customerAddress: text("customer_address"),
  customerPhone: text("customer_phone"),
  subtotal: money("subtotal").notNull(),
  discount: money("discount").notNull(),
  taxable: money("taxable").notNull(),
  cgst: money("cgst").notNull(),
  sgst: money("sgst").notNull(),
  igst: money("igst").notNull(),
  roundOff: money("round_off").notNull(),
  total: money("total").notNull(),
  costOfGoods: money("cost_of_goods").notNull(),
  paidAtSale: money("paid_at_sale").notNull().default("0"),
  paymentEntryId: uuid("payment_entry_id").references(() => journalEntries.id, { onDelete: "restrict" }),
  status: docStatusEnum("status").notNull().default("ACTIVE"),
  cancelReason: text("cancel_reason"),
  creditOverrideReason: text("credit_override_reason"),
  notes: text("notes"),
  shareToken: text("share_token").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("si_company_number_uq").on(t.companyId, t.number),
  uniqueIndex("si_share_token_uq").on(t.shareToken),
  index("si_company_date_idx").on(t.companyId, t.invoiceDate),
  index("si_party_idx").on(t.companyId, t.partyId),
]);

export const salesInvoiceLines = pgTable("sales_invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull().references(() => salesInvoices.id, { onDelete: "restrict" }),
  lineNo: integer("line_no").notNull(),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  description: text("description").notNull(),
  hsn: text("hsn"),
  unit: text("unit").notNull(),
  quantity: qty("quantity").notNull(),
  rate: money("rate").notNull(),
  discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  taxable: money("taxable").notNull(),
  gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull(),
  cgst: money("cgst").notNull(),
  sgst: money("sgst").notNull(),
  igst: money("igst").notNull(),
  lineTotal: money("line_total").notNull(),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
  costValue: money("cost_value").notNull(),
  serials: text("serials"),
});

/** Supplier bill. `billNumber` is the supplier's own number; `number` is our ledger voucher number. */
export const purchaseBills = pgTable("purchase_bills", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
  partyId: uuid("party_id").notNull().references(() => parties.id, { onDelete: "restrict" }),
  entryId: uuid("entry_id").notNull().references(() => journalEntries.id, { onDelete: "restrict" }),
  number: text("number").notNull(),
  billNumber: text("bill_number").notNull(),
  billDate: date("bill_date").notNull(),
  dueDate: date("due_date").notNull(),
  supplyType: supplyTypeEnum("supply_type").notNull(),
  taxable: money("taxable").notNull(),
  cgst: money("cgst").notNull(),
  sgst: money("sgst").notNull(),
  igst: money("igst").notNull(),
  roundOff: money("round_off").notNull(),
  total: money("total").notNull(),
  itcClaimed: boolean("itc_claimed").notNull(),
  status: docStatusEnum("status").notNull().default("ACTIVE"),
  cancelReason: text("cancel_reason"),
  notes: text("notes"),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("pb_company_number_uq").on(t.companyId, t.number),
  index("pb_party_billno_idx").on(t.companyId, t.partyId, t.billNumber),
  index("pb_company_date_idx").on(t.companyId, t.billDate),
]);

export const purchaseBillLines = pgTable("purchase_bill_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  billId: uuid("bill_id").notNull().references(() => purchaseBills.id, { onDelete: "restrict" }),
  lineNo: integer("line_no").notNull(),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  quantity: qty("quantity").notNull(),
  rate: money("rate").notNull(),
  taxable: money("taxable").notNull(),
  gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull(),
  cgst: money("cgst").notNull(),
  sgst: money("sgst").notNull(),
  igst: money("igst").notNull(),
  unitCost: numeric("unit_cost", { precision: 18, scale: 4 }).notNull(),
});
