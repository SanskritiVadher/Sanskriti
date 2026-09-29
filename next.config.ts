import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  serverExternalPackages: ["exceljs"],
};

export default nextConfig;
