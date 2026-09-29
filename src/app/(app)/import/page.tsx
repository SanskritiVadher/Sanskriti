import { requireContext } from "@/lib/session";
import { Button, Card, Field, Input, Notice, PageHeader } from "@/components/ui";
import { uploadImportAction } from "@/app/actions-phase3";

const K = {
  customers: { title: "Import customers", tally: "Ledgers under Sundry Debtors (Display More Reports → List of Accounts, or Group Summary of Sundry Debtors)" },
  suppliers: { title: "Import suppliers", tally: "Ledgers under Sundry Creditors" },
  products: { title: "Import products", tally: "Stock Summary (or List of Stock Items)" },
} as const;

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ kind?: string; error?: string }> }) {
  await requireContext();
  const sp = await searchParams;
  const kind = (sp.kind && sp.kind in K ? sp.kind : "customers") as keyof typeof K;
  return <>
    <PageHeader title={K[kind].title} subtitle="Nothing is saved until you review and confirm." />
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card className="mb-6">
      <form action={uploadImportAction} className="space-y-4">
        <input type="hidden" name="kind" value={kind} />
        <Field label="Excel (.xlsx) or CSV file" hint="Up to 5 MB, 5,000 rows"><Input type="file" name="file" accept=".xlsx,.csv" required /></Field>
        <Button>Upload and preview</Button>
      </form>
    </Card>
    <Card>
      <h2 className="text-[17px] font-semibold">Where to get the file</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] text-ink-2">
        <li><b>From Tally:</b> open {K[kind].tally}, press <b>Alt+E</b> (Export), choose <b>Excel</b>. The app understands Tally&rsquo;s column names, the title rows at the top, and &ldquo;Dr / Cr&rdquo; amounts.</li>
        <li><b>From your own Excel:</b> any sheet with a <b>Name</b> column works. Other columns are matched by their heading.
          <a className="ml-1 text-brand underline" href={`/api/templates/${kind}`}>Download a sample sheet</a>.</li>
        <li>If something doesn&rsquo;t match, you&rsquo;ll see exactly which rows and why before anything is saved.</li>
      </ul>
    </Card>
  </>;
}
