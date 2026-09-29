import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { Card, Notice, PageHeader } from "@/components/ui";

export default async function Backup() {
  const ctx = await requireContext("company.edit");
  const last = await db.execute<{ at: string | null; who: string | null }>(sql`
    SELECT max(a.created_at)::text at, (array_agg(u.name ORDER BY a.created_at DESC))[1] who FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.company_id = ${ctx.company.id} AND a.action = 'backup.download'`);
  const l = last.rows[0];
  const days = l.at ? Math.floor((Date.now() - Date.parse(l.at)) / 86400000) : null;
  return <>
    <PageHeader title="Backup" subtitle="A complete copy of your books that you keep yourself." />
    <Card className="mb-6">
      <p>{l.at ? <>Last backup: <b>{days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}</b>{l.who ? ` by ${l.who}` : ""}.</> : <b>No backup downloaded yet.</b>}</p>
      {ctx.role === "OWNER" ? <form method="get" action="/api/backup" className="mt-4">
          <button className="rounded-lg bg-brand px-4 py-2.5 font-medium text-brand-ink">Download backup now</button></form>
        : <p className="mt-3 text-[14px] text-ink-2">Only the owner can download a backup, because it contains everyone&rsquo;s login details.</p>}
      <ul className="mt-4 list-disc space-y-1 pl-5 text-[14px] text-ink-2">
        <li>Download one every week, and before any big change. Keep it on your computer <b>and</b> in Google Drive or email to yourself.</li>
        <li>It contains everything: bills, payments, stock, GST, customers, and team logins (passwords are stored scrambled, but still keep the file private).</li>
        <li>Your database provider (Neon) keeps its own short history too — that protects against a mistake today. Your own file protects against losing the account or the provider.</li>
      </ul>
    </Card>
    <Card><h2 className="text-[17px] font-semibold">If you ever need to restore</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-[14px] text-ink-2">
        <li>Create a new, empty database in Neon and put its address in Vercel as DATABASE_URL, then redeploy the same version of the app.</li>
        <li>Open the site. Because the database is empty, the sign-up page shows <b>&ldquo;Restore from a backup&rdquo;</b>. Upload the file.</li>
        <li>Log in with the same email and password as before. Every accounting check is run on the restored books.</li>
      </ol>
      <div className="mt-3"><Notice tone="info" title="The restore never mixes with existing data.">It only works into an empty database, so it can&rsquo;t overwrite or duplicate your current books.</Notice></div>
    </Card>
  </>;
}
