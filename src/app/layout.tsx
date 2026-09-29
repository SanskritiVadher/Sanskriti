import { APP_NAME } from "@/lib/brand";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: APP_NAME, description: "Your business, explained simply." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en-IN"><body>{children}</body></html>;
}
