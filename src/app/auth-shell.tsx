import { APP_NAME } from "@/lib/brand";
import type { ReactNode } from "react";
export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center px-4 py-12">
    <div className="w-full max-w-md">
      <p className="mb-8 text-[15px] font-semibold tracking-tight text-brand">{APP_NAME}</p>
      <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 mb-6 text-ink-2">{subtitle}</p>
      {children}
    </div>
  </main>;
}
