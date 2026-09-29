/**
 * Full backup of one business: every row of every table that belongs to it, as JSON (gzipped).
 * Restore loads it into an EMPTY database (a fresh Neon database after a disaster) and then runs every
 * accounting check — a backup that can't be proven to restore correctly is not a backup.
 * Money is kept as exact text (never floating point). The file contains password hashes: keep it private.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import type { DB } from "@/db";
import { UserFacingError } from "@/lib/errors";

export const BACKUP_FORMAT = "sanskriti-backup";
const SKIP = new Set(["login_attempts"]);
/** Tables without company_id: how to find this business's rows. */
const VIA: Record<string, (cid: string) => ReturnType<typeof sql>> = {
  companies: (cid) => sql`id = ${cid}`,
  users: (cid) => sql`id IN (SELECT user_id FROM memberships WHERE company_id = ${cid})`,
  sales_invoice_lines: (cid) => sql`invoice_id IN (SELECT id FROM sales_invoices WHERE company_id = ${cid})`,
  purchase_bill_lines: (cid) => sql`bill_id IN (SELECT id FROM purchase_bills WHERE company_id = ${cid})`,
  gst_note_lines: (cid) => sql`note_id IN (SELECT id FROM gst_notes WHERE company_id = ${cid})`,
};

type Col = { table: string; column: string; type: string };
async function tableInfo(db: DB) {
  const cols = (await db.execute<{ table_name: string; column_name: string; data_type: string }>(sql`
    SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)).rows;
  const fks = (await db.execute<{ t: string; ref: string }>(sql`
    SELECT DISTINCT tc.table_name t, ccu.table_name ref FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = 'public'
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`)).rows;
  const tables = [...new Set(cols.map((c) => c.table_name))].filter((t) => !SKIP.has(t));
  const byTable = new Map<string, Col[]>(tables.map((t) => [t, cols.filter((c) => c.table_name === t).map((c) => ({ table: t, column: c.column_name, type: c.data_type }))]));
  // Parents before children (self-references handled separately).
  const deps = new Map(tables.map((t) => [t, new Set(fks.filter((f) => f.t === t && f.ref !== t && !SKIP.has(f.ref)).map((f) => f.ref))]));
  const order: string[] = [];
  while (order.length < tables.length) {
    const next = tables.find((t) => !order.includes(t) && [...deps.get(t)!].every((d) => order.includes(d)));
    if (!next) throw new Error(`Backup: circular table dependency among ${tables.filter((t) => !order.includes(t)).join(", ")}`);
    order.push(next);
  }
  return { order, byTable };
}

async function migrationCount(db: DB) {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`).catch(() => ({ rows: [{ n: 0 }] }));
  return r.rows[0].n;
}

export async function exportCompany(db: DB, companyId: string) {
  const { order, byTable } = await tableInfo(db);
  // Compact: column names once per table, then rows as arrays.
  const tables: Record<string, { columns: string[]; rows: unknown[][] }> = {};
  for (const t of order) {
    const cols = byTable.get(t)!;
    const where = cols.some((c) => c.column === "company_id") ? sql`company_id = ${companyId}` : VIA[t]?.(companyId);
    if (!where) throw new Error(`Backup doesn't know how to find this business's rows in "${t}"`);
    // Numbers as text so no rupee or paisa is ever rounded by JSON.
    const select = sql.join(cols.map((c) => c.type === "numeric" ? sql.raw(`"${c.column}"::text AS "${c.column}"`) : sql.raw(`"${c.column}"`)), sql`, `);
    const rows = (await db.execute(sql`SELECT ${select} FROM ${sql.raw(`"${t}"`)} WHERE ${where}`)).rows as Record<string, unknown>[];
    const columns = cols.map((c) => c.column);
    tables[t] = { columns, rows: rows.map((r) => columns.map((c) => r[c])) };
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.rows.length]));
  return { format: BACKUP_FORMAT, version: 1, migrations: await migrationCount(db), createdAt: new Date().toISOString(), companyId, counts, tables };
}
export type Backup = Awaited<ReturnType<typeof exportCompany>>;

export const packBackup = (b: Backup) => gzipSync(Buffer.from(JSON.stringify(b)), { level: 9 });
export function unpackBackup(buf: Buffer): Backup {
  let b: Backup;
  try { b = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString("utf8")); }
  catch { throw new UserFacingError("This isn't a readable backup file."); }
  if (b?.format !== BACKUP_FORMAT || b.version !== 1 || typeof b.tables !== "object") throw new UserFacingError("This isn't a Sanskriti backup file.");
  for (const [t, v] of Object.entries(b.tables))
    if (!Array.isArray(v?.rows) || !Array.isArray(v.columns) || v.rows.length !== b.counts[t] || v.rows.some((r) => !Array.isArray(r) || r.length !== v.columns.length))
      throw new UserFacingError(`The backup file is damaged (table ${t}).`);
  return b;
}

/** Loads a backup into this database. Refuses if the business or any of its users already exist here. All-or-nothing. */
export async function restoreCompany(db: DB, b: Backup) {
  if ((await migrationCount(db)) !== b.migrations)
    throw new UserFacingError(`This database is at a different version (${await migrationCount(db)} updates) from the backup (${b.migrations}). Deploy the same version of the app first.`);
  const { order, byTable } = await tableInfo(db);
  const unknown = Object.keys(b.tables).filter((t) => !byTable.has(t));
  if (unknown.length) throw new UserFacingError(`The backup has tables this app doesn't: ${unknown.join(", ")}.`);
  const exists = await db.execute(sql`SELECT 1 FROM companies WHERE id = ${b.companyId}`);
  if (exists.rows.length) throw new UserFacingError("This business is already in this database. Restore into a new, empty database.");
  const objs = (t: string) => { const v = b.tables[t]; return v ? v.rows.map((r) => Object.fromEntries(v.columns.map((c, i) => [c, r[i]]))) : []; };
  const emails = objs("users").map((u) => String(u.email));
  if (emails.length) {
    const clash = await db.execute<{ email: string }>(sql`SELECT email FROM users WHERE email IN ${sql.raw(`(${emails.map((e) => `'${e.replace(/'/g, "''")}'`).join(",")})`)}`);
    if (clash.rows.length) throw new UserFacingError(`These logins already exist here: ${clash.rows.map((r) => r.email).join(", ")}.`);
  }
  await db.transaction(async (tx) => {
    for (const t of order) {
      let rows = objs(t);
      if (!rows.length) continue;
      if (t === "account_groups") { // parents first
        const done = new Set<string>(), sorted: typeof rows = [];
        while (sorted.length < rows.length) {
          const before = sorted.length;
          for (const r of rows) if (!done.has(r.id as string) && (!r.parent_id || done.has(r.parent_id as string) || !rows.some((x) => x.id === r.parent_id))) { sorted.push(r); done.add(r.id as string); }
          if (sorted.length === before) throw new UserFacingError("The backup file is damaged (account groups).");
        }
        rows = sorted;
      }
      if (t === "journal_entries") {
        // The ledger only allows POSTED → REVERSED, so load every entry as posted (originals before their reversals), then mark reversals.
        rows = [...rows].sort((a, c) => String(a.created_at).localeCompare(String(c.created_at)) || (a.reversal_of_id ? 1 : 0) - (c.reversal_of_id ? 1 : 0));
        const first = rows.map((r) => ({ ...r, status: "POSTED", reversed_by_id: null }));
        for (let i = 0; i < first.length; i += 500)
          await tx.execute(sql`INSERT INTO journal_entries SELECT * FROM json_populate_recordset(null::journal_entries, ${JSON.stringify(first.slice(i, i + 500))}::json)`);
        for (const r of rows.filter((x) => x.status === "REVERSED"))
          await tx.execute(sql`UPDATE journal_entries SET status = 'REVERSED', reversed_by_id = ${r.reversed_by_id as string} WHERE id = ${r.id as string}`);
        continue;
      }
      for (let i = 0; i < rows.length; i += 500)
        await tx.execute(sql`INSERT INTO ${sql.raw(`"${t}"`)} SELECT * FROM json_populate_recordset(null::${sql.raw(`"${t}"`)}, ${JSON.stringify(rows.slice(i, i + 500))}::json)`);
    }
  });
  return { companyId: b.companyId, counts: b.counts };
}
