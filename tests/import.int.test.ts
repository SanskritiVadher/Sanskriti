import { describe, it, expect, afterAll, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner } from "@/lib/services/company";
import { createPreview, confirmImport, parseTallyAmount, type PreviewRow } from "@/lib/services/importer";
import { partyBalances } from "@/lib/services/parties";
import { stockList, inventoryReconciliation } from "@/lib/services/inventory";
import { trialBalance } from "@/lib/accounting/reports";
import { gstinCheckChar } from "@/lib/gst/gstin";

afterAll(async () => { await pool.end(); });
let cid = "", uid = "";
beforeAll(async () => {
  const r = await registerOwner(db, { name: "Imp", email: `imp_${Date.now()}@t.in`, password: "secret123", businessName: "Imp Co" });
  cid = r.company.id; uid = r.user.id;
});
const g = (b: string) => b + gstinCheckChar(b);

describe("amount parsing", () => {
  it("reads Tally Dr/Cr amounts", () => {
    expect(parseTallyAmount("84,000.00 Dr")).toMatchObject({ side: "dr" });
    expect((parseTallyAmount("₹1,50,000 Cr") as { amount: { toString(): string } }).amount.toString()).toBe("150000");
    expect(parseTallyAmount("abc")).toBe("INVALID");
    expect(parseTallyAmount("")).toBeNull();
  });
});

describe("customer import from a Tally-style CSV", () => {
  it("skips title rows, maps headers, previews, then imports balances", async () => {
    const csv = [
      "Imp Co", "List of Ledgers", "1-Apr-2026 to 31-Mar-2027", "",
      "Ledger Name,Mobile No,GSTIN/UIN,State,Opening Balance",
      `Ravi Traders,+91 98765 43210,${g("21ABCDE1234F1Z")},Odisha,"84,000.00 Dr"`,
      "Sahu Auto,9437000000,,odisha,12000 Cr",
      "Bad Phone Shop,12345,,Odisha,",
      "Ravi Traders,9876543210,,Odisha,1 Dr",
      "Unknown State Co,9437000001,,Atlantis,",
      "Grand Total,,,,",
    ].join("\n");
    const b = await createPreview(db, cid, uid, "customers", "ledgers.csv", Buffer.from(csv));
    const rows = b.rows as PreviewRow[];
    const by = (n: string) => rows.find((r) => r.data.name === n)!;
    expect(by("Ravi Traders").status).toBe("ok");
    expect(by("Sahu Auto").status).toBe("ok");
    expect(by("Bad Phone Shop").status).toBe("error");
    expect(by("Unknown State Co").message).toMatch(/not recognised/);
    expect(rows.filter((r) => r.data.name === "Ravi Traders")[1].status).toBe("skip");
    expect(rows.find((r) => r.data.name === "Grand Total")).toBeUndefined();

    const n = await confirmImport(db, cid, uid, b.id, "2026-04-01");
    expect(n).toBe(2);
    const bal = await partyBalances(db, cid, "CUSTOMER");
    const parties = await db.query.parties.findMany({ where: eq(schema.parties.companyId, cid) });
    const ravi = parties.find((p) => p.name === "Ravi Traders")!, sahu = parties.find((p) => p.name === "Sahu Auto")!;
    expect(ravi.phone).toBe("9876543210");
    expect(bal.get(ravi.id)!.balance.toFixed(2)).toBe("84000.00");
    expect(bal.get(sahu.id)!.balance.toFixed(2)).toBe("-12000.00"); // customer advance (Cr)
    expect((await trialBalance(db, cid, "2027-03-31")).balanced).toBe(true);
    await expect(confirmImport(db, cid, uid, b.id, "2026-04-01")).rejects.toThrow(/already completed/);

    const again = await createPreview(db, cid, uid, "customers", "ledgers.csv", Buffer.from(csv));
    expect((again.rows as PreviewRow[]).find((r) => r.data.name === "Ravi Traders")!.status).toBe("skip");
  });
});

describe("product import from xlsx", () => {
  it("imports products with opening stock valued from Tally's Value column", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Stock Summary");
    ws.addRow(["Imp Co"]); ws.addRow(["Stock Summary"]); ws.addRow([]);
    ws.addRow(["Particulars", "Stock Group", "HSN/SAC", "Quantity", "Value"]);
    ws.addRow(["SF Sonic 35Ah", "SF Sonic", "8507", "20 pcs", 90000]);
    ws.addRow(["Usha Fan 1200mm", "Usha", "8414", 10, 18500]);
    ws.addRow(["Mystery Item", "", "", 5, ""]);
    ws.addRow(["Grand Total", "", "", "", 108500]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const b = await createPreview(db, cid, uid, "products", "stock.xlsx", buf);
    const rows = b.rows as PreviewRow[];
    expect(rows.find((r) => r.data.name === "SF Sonic 35Ah")!.status).toBe("ok");
    expect(rows.find((r) => r.data.name === "SF Sonic 35Ah")!.message).toMatch(/New brand "SF Sonic"/);
    expect(rows.find((r) => r.data.name === "Mystery Item")!.status).toBe("error");
    expect(await confirmImport(db, cid, uid, b.id, "2026-04-01")).toBe(2);
    const list = await stockList(db, cid);
    const sf = list.find((x) => x.name === "SF Sonic 35Ah")!;
    expect(sf.qty.toString()).toBe("20"); expect(sf.value.toFixed(2)).toBe("90000.00"); expect(sf.brand).toBe("SF Sonic");
    expect(list.find((x) => x.name === "Usha Fan 1200mm")!.value.toFixed(2)).toBe("18500.00");
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
  });

  it("rolls back the whole import if one row fails at commit", async () => {
    const csv = "Name,Opening Qty,Opening Rate\nGood Item A,1,100\nGood Item B,1,100\n";
    const b = await createPreview(db, cid, uid, "products", "p.csv", Buffer.from(csv));
    // Someone creates "Good Item B" between preview and confirm
    const { createProduct } = await import("@/lib/services/inventory");
    await createProduct(db, cid, uid, { name: "Good Item B" });
    await expect(confirmImport(db, cid, uid, b.id, "2026-04-01")).rejects.toThrow(/Row 3 .*Nothing was imported/);
    const list = await stockList(db, cid);
    expect(list.find((x) => x.name === "Good Item A")).toBeUndefined();
  });

  it("rejects files without a name column and old .xls", async () => {
    await expect(createPreview(db, cid, uid, "products", "x.csv", Buffer.from("Foo,Bar\n1,2\n"))).rejects.toThrow(/Name/);
    await expect(createPreview(db, cid, uid, "products", "x.xls", Buffer.from("x"))).rejects.toThrow(/xlsx/);
  });
});
