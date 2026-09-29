"use server";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { UserFacingError } from "@/lib/errors";
import { parseStatement, readStatementFile } from "@/lib/bank/statement";
import { confirmMatch, importStatement, reconciliation, setBankLineStatus } from "@/lib/bank/reconcile";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const msg = (e: unknown, d: string) => (e instanceof UserFacingError ? e.message : d);

export async function uploadStatementAction(f: FormData) {
  const ctx = await requireContext("money.record");
  const accountId = s(f, "accountId"), file = f.get("file");
  let out = "";
  try {
    if (!(file instanceof File) || file.size === 0) throw new UserFacingError("Please choose the statement file.");
    const parsed = parseStatement(await readStatementFile(Buffer.from(await file.arrayBuffer()), file.name));
    if (parsed.balanceBreaks.length && !f.get("anyway"))
      throw new UserFacingError(`The running balance doesn't add up at row${parsed.balanceBreaks.length > 1 ? "s" : ""} ${parsed.balanceBreaks.slice(0, 5).join(", ")} of the transactions — the file may be incomplete or edited. Download it again, or tick "Import anyway".`);
    const r = await importStatement(db, { companyId: ctx.company.id, userId: ctx.user.id, accountId, fileName: file.name, parsed });
    out = `/money/bank/${accountId}?added=${r.added}&dup=${r.duplicates}&skipped=${parsed.skipped}`;
  } catch (e) { redirect(`/money/bank?error=${encodeURIComponent(msg(e, "Couldn't read that file."))}`); }
  redirect(out);
}

export async function matchAction(f: FormData) {
  const ctx = await requireContext("money.record");
  const acc = s(f, "accountId");
  try { await confirmMatch(db, { companyId: ctx.company.id, userId: ctx.user.id, bankLineId: s(f, "bankLineId"), journalLineId: s(f, "journalLineId") }); }
  catch (e) { redirect(`/money/bank/${acc}?error=${encodeURIComponent(msg(e, "Couldn't match."))}`); }
  redirect(`/money/bank/${acc}?ok=1`);
}

export async function matchAllSureAction(f: FormData) {
  const ctx = await requireContext("money.record");
  const acc = s(f, "accountId");
  const r = await reconciliation(db, ctx.company.id, acc);
  let n = 0;
  for (const x of r?.suggestions.filter((x) => x.sure) ?? []) {
    try { await confirmMatch(db, { companyId: ctx.company.id, userId: ctx.user.id, bankLineId: x.bank.id, journalLineId: x.book.id }); n++; } catch { /* left for manual review */ }
  }
  redirect(`/money/bank/${acc}?matched=${n}`);
}

export async function bankLineStatusAction(f: FormData) {
  const ctx = await requireContext("money.record");
  const acc = s(f, "accountId");
  try { await setBankLineStatus(db, { companyId: ctx.company.id, userId: ctx.user.id, bankLineId: s(f, "bankLineId"), status: s(f, "status") === "IGNORED" ? "IGNORED" : "UNMATCHED", note: s(f, "note") }); }
  catch (e) { redirect(`/money/bank/${acc}?error=${encodeURIComponent(msg(e, "Couldn't update."))}`); }
  redirect(`/money/bank/${acc}?ok=1`);
}
