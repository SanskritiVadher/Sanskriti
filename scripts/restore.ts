/** Restore a backup file into the database in DATABASE_URL (must be migrated and not already contain this business).
 *  Usage: DATABASE_URL=... npx tsx scripts/restore.ts path/to/Sanskriti-backup.json.gz */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/db/schema";
import { restoreCompany, unpackBackup } from "../src/lib/services/backup";
import { ledgerHealth } from "../src/lib/accounting/reports";
import type { DB } from "../src/db";

async function main() {
  const file = process.argv[2], url = process.env.DATABASE_URL;
  if (!file || !url) throw new Error("Usage: DATABASE_URL=... npx tsx scripts/restore.ts backup.json.gz");
  const pool = new Pool({ connectionString: url, ssl: /sslmode=require|neon\.tech/.test(url) ? true : undefined });
  const db = drizzle(pool, { schema }) as unknown as DB;
  const r = await restoreCompany(db, unpackBackup(readFileSync(file)));
  const failed = (await ledgerHealth(db, r.companyId)).filter((h) => !h.ok);
  console.log(`Restored ${Object.values(r.counts).reduce((a, n) => a + n, 0)} rows.`, failed.length ? `CHECKS FAILED: ${failed.map((f) => f.name).join(", ")}` : "All accounting checks pass.");
  await pool.end();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
