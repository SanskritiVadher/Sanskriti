import { and, eq, like, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { schema, type DB, type Tx } from "@/db";
import { DEFAULT_ACCOUNTS, DEFAULT_GROUPS } from "@/lib/accounting/chart-of-accounts";
import { validateGstin } from "@/lib/gst/gstin";
import { stateByCode } from "@/lib/gst/states";
import { audit } from "./audit";

import { UserFacingError } from "@/lib/errors";
export { UserFacingError };

import { financialYearFor } from "@/lib/accounting/periods";
export { financialYearFor };

export async function seedChartOfAccounts(tx: Tx, companyId: string) {
  const idByCode = new Map<string, string>();
  for (const g of DEFAULT_GROUPS) {
    const [row] = await tx.insert(schema.accountGroups).values({
      companyId, code: g.code, name: g.name, ownerLabel: g.ownerLabel, nature: g.nature,
      parentId: g.parent ? idByCode.get(g.parent)! : null,
    }).returning({ id: schema.accountGroups.id });
    idByCode.set(g.code, row.id);
  }
  const natureByCode = new Map(DEFAULT_GROUPS.map((g) => [g.code, g.nature]));
  await tx.insert(schema.accounts).values(DEFAULT_ACCOUNTS.map((a) => ({
    companyId, groupId: idByCode.get(a.group)!, code: a.code, name: a.name, ownerLabel: a.ownerLabel,
    nature: natureByCode.get(a.group)!, systemKey: a.key, isSystem: true,
  })));
}

export async function registerOwner(
  db: DB,
  input: { name: string; email: string; password: string; businessName: string },
) {
  const email = input.email.trim().toLowerCase();
  if (input.password.length < 8) throw new UserFacingError("Please use a password of at least 8 characters.", "password");
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (existing) throw new UserFacingError("An account with this email already exists. Please log in instead.", "email");
  const passwordHash = await bcrypt.hash(input.password, 10);

  return db.transaction(async (tx) => {
    const [user] = await tx.insert(schema.users).values({ name: input.name.trim(), email, passwordHash }).returning();
    const [company] = await tx.insert(schema.companies).values({ name: input.businessName.trim() }).returning();
    await tx.insert(schema.memberships).values({ userId: user.id, companyId: company.id, role: "OWNER" });
    await tx.insert(schema.warehouses).values({ companyId: company.id, name: "Main godown", isDefault: true });
    await seedChartOfAccounts(tx, company.id);
    const fy = financialYearFor(new Date());
    await tx.insert(schema.financialPeriods).values({ companyId: company.id, name: fy.name, startDate: fy.start, endDate: fy.end });
    await audit(tx, { companyId: company.id, userId: user.id, action: "company.create", entityType: "company", entityId: company.id, after: { name: company.name } });
    return { user, company };
  });
}

const DUMMY_HASH = "$2b$10$XZlaCyxgrA4OPNdDEHMYReeqpqstypUeIr2XNEYTbGmXYMpBjpOUi";
const LOCK_MINUTES = 15, MAX_PER_EMAIL = 5, MAX_PER_IP = 30;

/** Slows down password guessing: 5 wrong tries on one email, or 30 from one network, pauses sign-in for 15 minutes. */
export async function assertLoginAllowed(db: DB, email: string, ip: string | null) {
  const r = await db.execute<{ e: number; i: number; first: string | null }>(sql`
    SELECT count(*) FILTER (WHERE email = ${email})::int e, count(*) FILTER (WHERE ${ip}::text IS NOT NULL AND ip = ${ip})::int i,
      min(at) FILTER (WHERE email = ${email})::text first
    FROM login_attempts WHERE NOT ok AND at > now() - make_interval(mins => ${LOCK_MINUTES})
      AND at > coalesce((SELECT max(at) FROM login_attempts WHERE ok AND email = ${email}), '-infinity')`);
  const x = r.rows[0];
  if (x.e >= MAX_PER_EMAIL || x.i >= MAX_PER_IP) {
    const wait = x.first ? Math.max(1, Math.ceil((Date.parse(x.first) + LOCK_MINUTES * 60000 - Date.now()) / 60000)) : LOCK_MINUTES;
    throw new UserFacingError(`Too many wrong attempts. For safety, sign-in is paused — try again in ${wait} minute${wait > 1 ? "s" : ""}.`);
  }
}

export async function authenticate(db: DB, emailRaw: string, password: string, ip: string | null = null) {
  const email = emailRaw.trim().toLowerCase();
  await assertLoginAllowed(db, email, ip);
  const user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  // Same message and same work either way: don't reveal which emails exist.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.isActive || !ok) {
    await db.insert(schema.loginAttempts).values({ email, ip, ok: false });
    throw new UserFacingError("Email or password is incorrect.");
  }
  await db.insert(schema.loginAttempts).values({ email, ip, ok: true });
  const m = await db.query.memberships.findFirst({ where: eq(schema.memberships.userId, user.id) });
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  await audit(db, { companyId: m?.companyId, userId: user.id, action: "user.login", entityType: "user", entityId: user.id });
  return { user, companyId: m?.companyId ?? null };
}

export type BusinessInfo = {
  name: string; legalName?: string; phone?: string; email?: string; addressLine1?: string;
  addressLine2?: string; city?: string; pincode?: string; stateCode?: string;
};

export async function updateBusinessInfo(db: DB, companyId: string, userId: string, info: BusinessInfo) {
  if (!info.name?.trim()) throw new UserFacingError("Please enter your business name.", "name");
  if (info.stateCode && !stateByCode(info.stateCode)) throw new UserFacingError("Please choose a valid state.", "stateCode");
  if (info.pincode && !/^[1-9][0-9]{5}$/.test(info.pincode)) throw new UserFacingError("PIN code should be 6 digits.", "pincode");
  return db.transaction(async (tx) => {
    const before = await tx.query.companies.findFirst({ where: eq(schema.companies.id, companyId) });
    const clean = Object.fromEntries(Object.entries(info).map(([k, v]) => [k, typeof v === "string" ? v.trim() || null : v]));
    const [after] = await tx.update(schema.companies).set({ ...clean, name: info.name.trim(), updatedAt: new Date() })
      .where(eq(schema.companies.id, companyId)).returning();
    await audit(tx, { companyId, userId, action: "company.update", entityType: "company", entityId: companyId, before, after });
    return after;
  });
}

export async function updateGstInfo(
  db: DB, companyId: string, userId: string,
  input: { registration: "REGULAR" | "COMPOSITION" | "UNREGISTERED"; gstin?: string },
) {
  let gstin: string | null = null, pan: string | null = null, stateCode: string | undefined;
  if (input.registration !== "UNREGISTERED") {
    const r = validateGstin(input.gstin ?? "");
    if (!r.ok) throw new UserFacingError(r.message, "gstin");
    gstin = r.gstin; pan = r.pan; stateCode = r.stateCode;
  }
  return db.transaction(async (tx) => {
    const before = await tx.query.companies.findFirst({ where: eq(schema.companies.id, companyId) });
    if (before?.stateCode && stateCode && before.stateCode !== stateCode)
      throw new UserFacingError(
        `This GSTIN is registered in ${stateByCode(stateCode)?.name}, but your business address is in ${stateByCode(before.stateCode)?.name}. Please check one of them.`,
        "gstin");
    const [after] = await tx.update(schema.companies).set({
      gstRegistration: input.registration, gstin, pan, ...(stateCode ? { stateCode } : {}), updatedAt: new Date(),
    }).where(eq(schema.companies.id, companyId)).returning();
    await audit(tx, { companyId, userId, action: "company.gst_update", entityType: "company", entityId: companyId,
      before: { gstRegistration: before?.gstRegistration, gstin: before?.gstin }, after: { gstRegistration: after.gstRegistration, gstin } });
    return after;
  });
}

export async function addBankAccount(
  db: DB, companyId: string, userId: string,
  input: { bankName: string; accountHolder?: string; accountNumber?: string; ifsc?: string },
) {
  if (!input.bankName?.trim()) throw new UserFacingError("Please enter the bank name.", "bankName");
  const ifsc = input.ifsc?.trim().toUpperCase() || null;
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new UserFacingError("IFSC should look like SBIN0001234.", "ifsc");
  const digits = (input.accountNumber ?? "").replace(/\D/g, "");
  const last4 = digits ? digits.slice(-4) : null;

  return db.transaction(async (tx) => {
    const group = await tx.query.accountGroups.findFirst({
      where: and(eq(schema.accountGroups.companyId, companyId), eq(schema.accountGroups.code, "1120")) });
    if (!group) throw new Error("Bank group missing from chart of accounts");
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, companyId), like(schema.accounts.code, "112%")));
    const code = String(1121 + n);
    const label = `${input.bankName.trim()}${last4 ? ` ••${last4}` : ""}`;
    const [acc] = await tx.insert(schema.accounts).values({
      companyId, groupId: group.id, code, name: label, ownerLabel: label, nature: "ASSET",
    }).returning();
    const [bank] = await tx.insert(schema.bankAccounts).values({
      companyId, accountId: acc.id, bankName: input.bankName.trim(), accountHolder: input.accountHolder?.trim() || null,
      accountNumberLast4: last4, ifsc,
    }).returning();
    await audit(tx, { companyId, userId, action: "bank.create", entityType: "bank_account", entityId: bank.id, after: { ...bank } });
    return bank;
  });
}

export async function addBrand(db: DB, companyId: string, userId: string, nameRaw: string) {
  const name = nameRaw.trim();
  if (!name) throw new UserFacingError("Please enter a brand name.", "name");
  const dup = await db.query.brands.findFirst({
    where: and(eq(schema.brands.companyId, companyId), sql`lower(${schema.brands.name}) = lower(${name})`) });
  if (dup) throw new UserFacingError(`${dup.name} is already added.`, "name");
  const [b] = await db.insert(schema.brands).values({ companyId, name }).returning();
  await audit(db, { companyId, userId, action: "brand.create", entityType: "brand", entityId: b.id, after: b });
  return b;
}

export async function setSetupStep(db: DB, companyId: string, step: number, complete = false) {
  await db.update(schema.companies).set({
    setupStep: step, ...(complete ? { setupCompletedAt: new Date() } : {}), updatedAt: new Date(),
  }).where(eq(schema.companies.id, companyId));
}

export async function addUser(
  db: DB, companyId: string, actorId: string,
  input: { name: string; email: string; password: string; role: "ADMIN" | "ACCOUNTANT" | "SALESPERSON" | "PURCHASE_MANAGER" | "INVENTORY_MANAGER" | "VIEWER" },
) {
  const email = input.email.trim().toLowerCase();
  if (!input.name.trim()) throw new UserFacingError("Please enter a name.", "name");
  if (input.password.length < 8) throw new UserFacingError("Password must be at least 8 characters.", "password");
  if (await db.query.users.findFirst({ where: eq(schema.users.email, email) }))
    throw new UserFacingError("Someone with this email already has an account.", "email");
  const passwordHash = await bcrypt.hash(input.password, 10);
  return db.transaction(async (tx) => {
    const [u] = await tx.insert(schema.users).values({ name: input.name.trim(), email, passwordHash }).returning();
    await tx.insert(schema.memberships).values({ userId: u.id, companyId, role: input.role });
    await audit(tx, { companyId, userId: actorId, action: "user.create", entityType: "user", entityId: u.id, after: { email, role: input.role } });
    return u;
  });
}

// ───────────── Team management (Phase 2) ─────────────

async function assertCanManage(db: DB, companyId: string, actorId: string, targetUserId: string) {
  const [actor, target] = await Promise.all([
    db.query.memberships.findFirst({ where: and(eq(schema.memberships.companyId, companyId), eq(schema.memberships.userId, actorId)) }),
    db.query.memberships.findFirst({ where: and(eq(schema.memberships.companyId, companyId), eq(schema.memberships.userId, targetUserId)) }),
  ]);
  if (!target) throw new UserFacingError("That person isn't part of this business.");
  if (target.role === "OWNER" && actor?.role !== "OWNER") throw new UserFacingError("Only the owner can change the owner's account.");
  return target;
}

/** Owner/admin sets a new password for a team member (no email service needed). */
export async function resetUserPassword(db: DB, companyId: string, actorId: string, targetUserId: string, newPassword: string) {
  if (newPassword.length < 8) throw new UserFacingError("New password must be at least 8 characters.", "password");
  await assertCanManage(db, companyId, actorId, targetUserId);
  await db.update(schema.users).set({ passwordHash: await bcrypt.hash(newPassword, 10), sessionsValidAfter: new Date() }).where(eq(schema.users.id, targetUserId));
  await audit(db, { companyId, userId: actorId, action: "user.password_reset", entityType: "user", entityId: targetUserId });
}

export async function setUserActive(db: DB, companyId: string, actorId: string, targetUserId: string, active: boolean) {
  if (actorId === targetUserId) throw new UserFacingError("You can't deactivate your own account.");
  const t = await assertCanManage(db, companyId, actorId, targetUserId);
  if (t.role === "OWNER") throw new UserFacingError("The owner account can't be deactivated.");
  await db.update(schema.users).set({ isActive: active }).where(eq(schema.users.id, targetUserId));
  await audit(db, { companyId, userId: actorId, action: active ? "user.activate" : "user.deactivate", entityType: "user", entityId: targetUserId });
}

/** "Log out everywhere": every existing session for this user stops working. */
export async function logoutEverywhere(db: DB, userId: string) {
  await db.update(schema.users).set({ sessionsValidAfter: new Date() }).where(eq(schema.users.id, userId));
  await audit(db, { userId, action: "user.logout_all", entityType: "user", entityId: userId });
}

/** Signup is open only for the very first account, unless ALLOW_SIGNUP=true. Everyone else is added by the owner. */
export async function signupOpen(db: DB) {
  if (process.env.ALLOW_SIGNUP === "true") return true;
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM users`);
  return r.rows[0].n === 0;
}

/** Any user changes their own password (needs the current one). */
export async function changeOwnPassword(db: DB, userId: string, current: string, next: string) {
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!u || !(await bcrypt.compare(current, u.passwordHash))) throw new UserFacingError("Current password is incorrect.", "current");
  if (next.length < 8) throw new UserFacingError("New password must be at least 8 characters.", "password");
  // Signs out every other device; the caller issues a fresh session for this one.
  await db.update(schema.users).set({ passwordHash: await bcrypt.hash(next, 10), sessionsValidAfter: new Date() }).where(eq(schema.users.id, userId));
  await audit(db, { userId, action: "user.password_change", entityType: "user", entityId: userId });
}
