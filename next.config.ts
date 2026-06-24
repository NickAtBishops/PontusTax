import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No file-tracing tweaks today. The tenant-credit writeback used to
  // need an outputFileTracingIncludes entry for
  // samples/Corporate_Financials_and_P_Ls.xlsx because Vercel only
  // bundles statically imported files; that route now receives the
  // tracker as a multipart upload, so nothing extra needs to ship.
};

export default nextConfig;
