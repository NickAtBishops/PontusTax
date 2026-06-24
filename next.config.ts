import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The tenant-credit writeback route reads the master tracker xlsx from
  // samples/ at request time. Vercel's default file-tracing wouldn't
  // bundle a file the build doesn't statically import, so without this
  // it would 500 with ENOENT in production. Target the one file, not
  // the whole samples/ folder, to avoid bundling lock files and the
  // PDF fixture.
  outputFileTracingIncludes: {
    "/api/tenant-credit/writeback": [
      "./samples/Corporate_Financials_and_P_Ls.xlsx",
    ],
  },
};

export default nextConfig;
