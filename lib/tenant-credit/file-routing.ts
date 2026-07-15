// Filename/path → tenant routing for the zip importer. Pure functions,
// no I/O, so the matching rules are unit-testable outside the page.
//
// Lessons encoded here (2026-07-14 deep review):
//   - Substring matching misroutes: the tenant token "corp" (from
//     "Solaero Technologies Corp.") is a substring of "Corporate
//     Financials Summary (v3).xlsx", which silently recommended
//     Pinnacle's workbook onto Solaero's row. Tokens must match WHOLE
//     WORDS of the filename.
//   - Corporate suffixes ("Inc", "LLC", "Corp", "Holdings",
//     "Acquisition"...) appear in many tenants and many filenames;
//     they carry no identity and must never contribute to a match.
//   - The tenant identity usually lives in the FOLDER name of the
//     quarterly zip ("Kraf/JANUARY.pdf", "Ethema Health Corporation/
//     Evernia Q1 PL.pdf"), so every path segment is scored, not just
//     the basename.
//   - Ambiguity fails closed: a tie between tenants recommends nobody.

// Words that appear in company names without identifying the company.
// Scoring ignores them entirely — matching on "acquisition" or "corp"
// is how files land on the wrong tenant.
const GENERIC_NAME_TOKENS = new Set([
  "inc",
  "incorporated",
  "llc",
  "llp",
  "lp",
  "ltd",
  "plc",
  "corp",
  "corporation",
  "co",
  "company",
  "companies",
  "holdings",
  "holding",
  "group",
  "acquisition",
  "acquisitions",
  "partners",
  "partnership",
  "enterprises",
  "capital",
  "stores",
]);

const MIN_TOKEN_LENGTH = 4;

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Identity-bearing tokens of a tenant display name: long enough to be
// distinctive and not a generic corporate word.
function tenantTokens(tenantName: string): string[] {
  return normalizeForMatch(tenantName)
    .split(" ")
    .filter(
      (token) =>
        token.length >= MIN_TOKEN_LENGTH && !GENERIC_NAME_TOKENS.has(token),
    );
}

// How strongly one piece of text (a filename or a folder name) points
// at a tenant: the summed length of the tenant's identity tokens that
// appear as WHOLE WORDS in the text. 0 = no signal.
export function matchScore(text: string, tenantName: string): number {
  const words = new Set(normalizeForMatch(text).split(" "));
  let score = 0;
  for (const token of tenantTokens(tenantName)) {
    if (words.has(token)) score += token.length;
  }
  return score;
}

export type FileRouteResult<T> = {
  winner: T | null;
  tied: boolean;
};

// Route one zip entry (full path, e.g. "Kraf/JANUARY.pdf") to the
// best-matching tenant. Each path segment is scored independently and
// the tenant's best segment wins, so folder names — where the tenant
// identity usually lives — count as much as basenames, but words from
// different segments never pool into a spurious combined match.
export function matchFileToTenant<T extends { display_name: string }>(
  path: string,
  tenants: T[],
): FileRouteResult<T> {
  const segments = path.split("/").filter((segment) => segment.trim() !== "");
  let bestScore = 0;
  let winner: T | null = null;
  let tied = false;
  for (const tenant of tenants) {
    const score = Math.max(
      0,
      ...segments.map((segment) => matchScore(segment, tenant.display_name)),
    );
    if (score === 0) continue;
    if (score > bestScore) {
      bestScore = score;
      winner = tenant;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  return { winner: tied ? null : winner, tied };
}
