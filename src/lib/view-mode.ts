import "server-only";
import { cookies } from "next/headers";
export type ViewMode = "owner" | "accountant";
export async function getViewMode(): Promise<ViewMode> {
  return (await cookies()).get("view_mode")?.value === "accountant" ? "accountant" : "owner";
}
