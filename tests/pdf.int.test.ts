import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import { db, pool } from "@/db";
import { registerOwner, updateBusinessInfo, updateGstInfo, addBankAccount } from "@/lib/services/company";
import { createParty } from "@/lib/services/parties";
import { createProduct } from "@/lib/services/inventory";
import { createSale, cancelSale, getInvoice } from "@/lib/services/sales";
import { invoicePdf } from "@/lib/pdf/invoice";
import { gstinCheckChar } from "@/lib/gst/gstin";

afterAll(async () => { await pool.end(); });
const g = (b: string) => b + gstinCheckChar(b);
let cid = "", uid = "", intraId = "", interId = "";
beforeAll(async () => {
  const r = await registerOwner(db, { name: "Pdf", email: `pdf_${Date.now()}@t.in`, password: "secret123", businessName: "Sharma Battery House" });
  cid = r.company.id; uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "Sharma Battery House", stateCode: "21", city: "Cuttack", addressLine1: "Link Road", pincode: "753001", phone: "9437000000" });
  await updateGstInfo(db, cid, uid, { registration: "REGULAR", gstin: g("21AAAAA1111A1Z") });
  await addBankAccount(db, cid, uid, { bankName: "State Bank of India", accountHolder: "Sharma Battery House", accountNumber: "30012345678", ifsc: "SBIN0001234" });
  const products = await Promise.all(["SF Sonic FS1080-DIN 35Ah Automotive Battery", "Usha Striker Galaxy 1200mm Ceiling Fan"].map((n, i) =>
    createProduct(db, cid, uid, { name: n, hsn: i ? "8414" : "8507", gstRate: "18", gstConfirmed: true, openingQty: "50", openingRate: i ? "1850" : "4500" })));
  const c1 = await createParty(db, cid, uid, "CUSTOMER", { name: "Ravi Traders", gstin: g("21CCCCC3333C1Z"), addressLine1: "College Square", city: "Cuttack", phone: "9876543210", creditDays: "30" });
  const c2 = await createParty(db, cid, uid, "CUSTOMER", { name: "Ranchi Auto Centre", stateCode: "20", city: "Ranchi", creditDays: "15" });
  intraId = (await createSale(db, { companyId: cid, userId: uid, partyId: c1.id, date: "2026-09-05", notes: "Warranty as per company terms.",
    lines: [{ productId: products[0].id, qty: "5", rate: "5000", serials: "SF35A1001, SF35A1002, SF35A1003, SF35A1004, SF35A1005" }, { productId: products[1].id, qty: "3", rate: "2199.99", discountPct: "2.5" }] })).invoice.id;
  interId = (await createSale(db, { companyId: cid, userId: uid, partyId: c2.id, date: "2026-09-06", lines: [{ productId: products[0].id, qty: "10", rate: "5000" }] })).invoice.id;
});

describe("invoice PDF", () => {
  it("renders intra-state, inter-state and cancelled invoices", async () => {
    for (const [id, file] of [[intraId, "intra"], [interId, "inter"]]) {
      const pdf = await invoicePdf((await getInvoice(db, { companyId: cid, id }))!);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      writeFileSync(`/tmp/claude-0/sample-invoice-${file}.pdf`, pdf);
    }
    await cancelSale(db, { companyId: cid, userId: uid, invoiceId: interId, reason: "test" });
    const c = await invoicePdf((await getInvoice(db, { companyId: cid, id: interId }))!);
    expect(c.subarray(0, 5).toString()).toBe("%PDF-");
    writeFileSync("/tmp/claude-0/sample-invoice-cancelled.pdf", c);
  });
});
