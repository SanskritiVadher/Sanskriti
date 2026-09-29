# Sanskriti — business operating system for a wholesale dealership

Owner-first accounting, GST, billing and inventory for an Indian wholesale business (starting with SF Sonic and Usha).

**Status: Phase 5 of 10.**
- Phase 1: setup, database, login and roles, design system, company setup wizard, default chart of accounts.
- Phase 2: double-entry posting engine (enforced by database triggers), vouchers (money in/out, cash↔bank, adjustments), reversal instead of deletion, opening balances, trial balance, account statements, day book, owner/accountant view, system health, team password reset.
- Phase 3: products (prices, HSN, owner-confirmed GST rate), weighted-average stock engine tied to the ledger, stock corrections, customers & suppliers with ledger-based dues, payments, WhatsApp reminders, Excel/CSV/Tally import with preview, guided corrections ("Fix a mistake"), stock and dues health checks.
- Phase 4: sales invoices and purchase bills (CGST/SGST/UTGST/IGST from place of supply, per-line rounding + rupee round-off), weighted-average COGS, credit-limit control with recorded override, margin/stock/e-way-bill warnings, cancellation by reversal, A4 invoice PDF, private share link + WhatsApp, FIFO receivables (overdue days, ageing, call-first ranking, payment habit), cash-rule warnings, live "what needs attention" and month-on-month change on Home.
- Phase 5: credit/debit notes (partial returns priced like the original line), GSTR-1 (B2B, B2CL > ₹1 lakh, B2CS, CDNR/CDNUR, HSN split B2B/B2C, documents issued) as portal JSON + Excel, GSTR-3B summary with legal ITC set-off order, GST payment voucher (idempotent), GSTR-2B JSON matching, GST rate table with source/status (never auto-applied), GST books-vs-documents health check.

### GST: free route
The app does not connect to the GST portal. It prepares GSTR-1 (JSON for the portal's offline tool, and Excel for the CA) and reads GSTR-2B JSON that the owner downloads. Always validate the JSON in the portal's offline tool before filing: the portal schema changes over time.
Sections that aren't built yet say so plainly. They never show sample numbers.

## Stack
Next.js 15 (App Router, TypeScript), Tailwind CSS 4, PostgreSQL, Drizzle ORM, decimal.js for all money, bcrypt + signed JWT cookie for login, Vitest.

## Run it on your computer
Requires Node.js 20+ and a Postgres database (a free Neon database works fine for local use too).

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and AUTH_SECRET
npm run db:migrate          # creates the tables
npm run dev                 # open http://localhost:3000
```

## Tests
Tests need a separate database whose name ends in `_test`. They wipe it on every run.

```bash
TEST_DATABASE_URL="postgresql://.../bizos_test" npm test
```

## Deploy (GitHub + Vercel + Neon)
1. Push this folder to a new **private** GitHub repo.
2. Create a free Postgres database at neon.tech and copy its connection string.
3. In Vercel: **Add New → Project →** import the repo.
4. Before clicking Deploy, add Environment Variables: `DATABASE_URL` and `AUTH_SECRET`.
5. Deploy. The `vercel-build` script runs database migrations first, then builds the app.
6. Check `https://<your-app>.vercel.app/api/health`. It should say `"database":"ok"`.

## Project layout
```
drizzle/                   SQL migrations (generated, committed)
scripts/migrate.ts         applies migrations
src/db/schema.ts           database tables
src/lib/accounting/        chart of accounts, posting engine, ledger reports
src/lib/gst/               GST state codes, GSTIN validation
src/lib/services/          business logic (all writes are audited)
src/lib/permissions.ts     role → permission matrix
src/app/                   pages and server actions
tests/                     unit + database tests
```

## Principles enforced in code
- Every journal entry must balance. The database itself rejects unbalanced entries, and edits or deletes of posted lines.
- Money is `numeric(18,2)` in the DB and `decimal.js` in code, never JavaScript floats.
- Every write goes through a service that records an audit log entry with before/after values.
- Money-related records are never hard-deleted (foreign keys use `ON DELETE RESTRICT`).
- A GSTIN is checked offline for format, state code and check digit. The UI says clearly that this is **not** live portal verification.
