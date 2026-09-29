export const ROLES = ["OWNER", "ADMIN", "ACCOUNTANT", "SALESPERSON", "PURCHASE_MANAGER", "INVENTORY_MANAGER", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner", ADMIN: "Admin", ACCOUNTANT: "Accountant", SALESPERSON: "Salesperson",
  PURCHASE_MANAGER: "Purchase manager", INVENTORY_MANAGER: "Inventory manager", VIEWER: "Viewer (read only)",
};

export type Permission =
  | "company.edit" | "users.manage" | "gst.configure" | "reports.financial" | "exports"
  | "sales.create" | "purchases.create" | "inventory.adjust" | "transactions.cancel"
  | "ledger.post_manual" | "view.dashboard";

const ALL: Permission[] = [
  "company.edit", "users.manage", "gst.configure", "reports.financial", "exports", "sales.create",
  "purchases.create", "inventory.adjust", "transactions.cancel", "ledger.post_manual", "view.dashboard",
];

const MATRIX: Record<Role, Permission[]> = {
  OWNER: ALL,
  ADMIN: ALL.filter((p) => p !== "ledger.post_manual"),
  ACCOUNTANT: ["gst.configure", "reports.financial", "exports", "sales.create", "purchases.create", "transactions.cancel", "ledger.post_manual", "view.dashboard"],
  SALESPERSON: ["sales.create", "view.dashboard"],
  PURCHASE_MANAGER: ["purchases.create", "view.dashboard"],
  INVENTORY_MANAGER: ["inventory.adjust", "view.dashboard"],
  VIEWER: ["view.dashboard"],
};

export const can = (role: Role, p: Permission) => MATRIX[role].includes(p);
