"use client";
export function PrintButton() {
  return <button type="button" onClick={() => window.print()} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[15px]">Print</button>;
}
