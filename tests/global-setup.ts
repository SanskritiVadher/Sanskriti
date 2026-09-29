import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/** Fresh schema for every test run. Refuses to touch anything but a *_test database. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://bizos:bizos@localhost:5432/bizos_test";
  if (!/_test(\?|$)/.test(url)) throw new Error("Tests must run against a database whose name ends in _test");
  const pool = new Pool({ connectionString: url });
  await pool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  await pool.end();
}
