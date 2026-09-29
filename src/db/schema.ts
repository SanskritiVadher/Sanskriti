/**
 * BizOS database schema (Drizzle ORM, PostgreSQL).
 * Phase 1: companies, users, roles, audit, chart of accounts, banks, brands, settings.
 * Rule: money is numeric(18,2) handled as strings + decimal.js. Never float.
 */
import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp, date, jsonb,
  uniqueIndex, index, type AnyPgColumn,
} from "drizzle-orm/pg-core";

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
