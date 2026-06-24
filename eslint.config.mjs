import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Python worker dirs ship their own venv, vendored JS (skyvern), and
    // generated artifacts. None of it is part of the Next.js app so it
    // would only generate noise.
    "worker/**",
    // Vercel build state.
    ".vercel/**",
    // Pre-existing root dirs that ship Python venvs or vendored code
    // and are not part of the Next.js app (see CLAUDE.md housekeeping).
    "python/**",
    "web/**",
    "legacy/**",
    // Node CLI scripts intentionally use CommonJS require(); they're
    // not part of the Next.js bundle and aren't worth converting.
    "scripts/**",
  ]),
]);

export default eslintConfig;
