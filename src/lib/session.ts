import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { SESSION_COOKIE, signSession, verifySession, type SessionPayload } from "./session-token";
import { can, type Permission, type Role } from "./permissions";

export async function startSession(p: SessionPayload) {
  (await cookies()).set(SESSION_COOKIE, await signSession(p), {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
}
export async function endSession() { (await cookies()).delete(SESSION_COOKIE); }

/** Re-checks the DB every request, so a deactivated user or removed membership loses access immediately. */
export async function getContext() {
  const s = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s?.companyId) return null;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, s.userId) });
  if (!user?.isActive) return null;
  const m = await db.query.memberships.findFirst({
    where: and(eq(schema.memberships.userId, s.userId), eq(schema.memberships.companyId, s.companyId)) });
  if (!m) return null;
  const company = await db.query.companies.findFirst({ where: eq(schema.companies.id, s.companyId) });
  if (!company) return null;
  return { user, company, role: m.role as Role };
}

export async function requireContext(permission?: Permission) {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  if (permission && !can(ctx.role, permission)) redirect("/home?denied=1");
  return ctx;
}
