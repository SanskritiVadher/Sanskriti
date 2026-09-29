import type { NextConfig } from "next";

// Scripts and styles are served from this site only. Next.js needs inline scripts/styles for hydration.
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'self'", "object-src 'none'",
].join("; ");
const common = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  serverExternalPackages: ["exceljs"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: common },
      // Shared invoice links carry a secret token in the URL: never leak it to other sites, never let search engines index it.
      { source: "/i/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }, { key: "Cache-Control", value: "private, no-store" }] },
    ];
  },
};

export default nextConfig;
