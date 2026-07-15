import type { RawExtractionResult } from "./extraction";

export type ScopeGuardResult = {
  extraction: RawExtractionResult;
  applied: boolean;
  evidence: string | null;
};

const NON_SCOPE_SUFFIXES = new Set([
  "audited",
  "copy",
  "corrected",
  "draft",
  "final",
  "revised",
  "revision",
  "signed",
  "unaudited",
  "update",
  "updated",
  "version",
]);

function normalizedWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isPeriodWord(word: string): boolean {
  return (
    /^q[1-4]$/.test(word) ||
    /^(?:19|20)\d{2}$/.test(word) ||
    /^\d{1,2}$/.test(word) ||
    /^(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)$/.test(
      word,
    )
  );
}

function filenameLocationSuffix(filename: string): string | null {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  const markers = [
    /\bp\s*&\s*l\b/gi,
    /\bp\s+and\s+l\b/gi,
    /\bprofit\s*(?:&|and)?\s*loss\b/gi,
    /\bincome\s+statement\b/gi,
    /\bpnl\b/gi,
    /\bpl\b/gi,
  ];
  let markerEnd = -1;
  for (const marker of markers) {
    for (const match of stem.matchAll(marker)) {
      markerEnd = Math.max(markerEnd, (match.index ?? -1) + match[0].length);
    }
  }
  if (markerEnd < 0) return null;

  const originalTail = stem.slice(markerEnd).trim();
  if (!originalTail) return null;
  const words = normalizedWords(originalTail).filter(
    (word) => !isPeriodWord(word),
  );
  while (words.length > 0 && NON_SCOPE_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
  }
  if (
    words.length === 0 ||
    words.length > 4 ||
    words.every((word) => NON_SCOPE_SUFFIXES.has(word))
  ) {
    return null;
  }
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

// Some accounting exports retain the parent legal entity in the PDF header
// even when the filename and line items clearly identify one location. Keep
// that model mistake from turning a component P&L into a second entity-wide
// rollup. The guard is intentionally narrow: it needs a statement marker,
// a meaningful filename suffix, and matching text inside an extracted row.
export function applyFilenameScopeGuard(
  extraction: RawExtractionResult,
  sourceFilename: string,
): ScopeGuardResult {
  if (extraction.source_scope_type !== "entity_wide") {
    return { extraction, applied: false, evidence: null };
  }
  const location = filenameLocationSuffix(sourceFilename);
  if (!location) return { extraction, applied: false, evidence: null };

  const locationWords = normalizedWords(location);
  const sourceText = normalizedWords(
    extraction.line_items
      .map((item) => `${item.label} ${item.source_reference}`)
      .join(" "),
  );
  const sourceWordSet = new Set(sourceText);
  if (!locationWords.every((word) => sourceWordSet.has(word))) {
    return { extraction, applied: false, evidence: null };
  }

  const evidence =
    `Filename suffix "${location}" matches extracted line-item text; ` +
    "classified as a single component despite the parent-entity header.";
  return {
    extraction: {
      ...extraction,
      source_scope: `${location} component (${evidence})`,
      source_scope_type: "single_component",
      source_scope_identifiers: [location],
    },
    applied: true,
    evidence,
  };
}
