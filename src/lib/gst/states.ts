/**
 * Indian GST state / UT codes (first two digits of a GSTIN).
 * `utgst: true` = Union Territory without legislature, where UTGST applies instead of SGST
 * on intra-territory supplies (used by the GST engine in Phase 5).
 * Source: GST state code list published on the GST portal. Static reference data, not tax rates.
 */
export type GstState = { code: string; name: string; utgst: boolean };

export const GST_STATES: GstState[] = [
  { code: "01", name: "Jammu and Kashmir", utgst: false },
  { code: "02", name: "Himachal Pradesh", utgst: false },
  { code: "03", name: "Punjab", utgst: false },
  { code: "04", name: "Chandigarh", utgst: true },
  { code: "05", name: "Uttarakhand", utgst: false },
  { code: "06", name: "Haryana", utgst: false },
  { code: "07", name: "Delhi", utgst: false },
  { code: "08", name: "Rajasthan", utgst: false },
  { code: "09", name: "Uttar Pradesh", utgst: false },
  { code: "10", name: "Bihar", utgst: false },
  { code: "11", name: "Sikkim", utgst: false },
  { code: "12", name: "Arunachal Pradesh", utgst: false },
  { code: "13", name: "Nagaland", utgst: false },
  { code: "14", name: "Manipur", utgst: false },
  { code: "15", name: "Mizoram", utgst: false },
  { code: "16", name: "Tripura", utgst: false },
  { code: "17", name: "Meghalaya", utgst: false },
  { code: "18", name: "Assam", utgst: false },
  { code: "19", name: "West Bengal", utgst: false },
  { code: "20", name: "Jharkhand", utgst: false },
  { code: "21", name: "Odisha", utgst: false },
  { code: "22", name: "Chhattisgarh", utgst: false },
  { code: "23", name: "Madhya Pradesh", utgst: false },
  { code: "24", name: "Gujarat", utgst: false },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu", utgst: true },
  { code: "27", name: "Maharashtra", utgst: false },
  { code: "29", name: "Karnataka", utgst: false },
  { code: "30", name: "Goa", utgst: false },
  { code: "31", name: "Lakshadweep", utgst: true },
  { code: "32", name: "Kerala", utgst: false },
  { code: "33", name: "Tamil Nadu", utgst: false },
  { code: "34", name: "Puducherry", utgst: false },
  { code: "35", name: "Andaman and Nicobar Islands", utgst: true },
  { code: "36", name: "Telangana", utgst: false },
  { code: "37", name: "Andhra Pradesh", utgst: false },
  { code: "38", name: "Ladakh", utgst: true },
  { code: "97", name: "Other Territory", utgst: true },
];

export const stateByCode = (code: string | null | undefined) =>
  GST_STATES.find((s) => s.code === code) ?? null;
