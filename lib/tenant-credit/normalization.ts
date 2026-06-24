// Label normalization. Sits between the PDF extractor (Phase 3) and the
// methodology engine (Phase 2). The extractor pulls labels verbatim from
// the source statement; the engine wants canonical labels exactly as the
// per-tenant config lists them. This module bridges the two.
//
// Why a normalization layer at all (rather than telling Claude what
// labels to use during extraction): future tenants may use synonyms or
// abbreviations on their statements ("D&A" instead of "Depreciation
// Expense", "Net Income (Loss)" instead of "Net Income"). Encoding the
// known variants as aliases per tenant lets the engine stay strict while
// the extractor stays honest about what the PDF actually said.
//
// What this module deliberately does not do:
//   - Fuzzy or Levenshtein matching. Silent "close enough" matches are
//     exactly the failure mode CLAUDE.md tells us to avoid. We do
//     case-insensitive and whitespace-tolerant matching only.
//   - Cross-tenant aliases. Aliases live with each tenant's config.

import type { LineItem } from "@/lib/tenant-credit/methodology";

// A canonical label paired with the variants the extractor might emit.
// Example: { "Depreciation Expense": ["Depreciation", "D&A"] }.
// The canonical key is the label the engine's TenantConfig refers to.
export type LabelAliases = Record<string, string[]>;

export type NormalizationMatchType =
  // The raw label was already in the canonical form. No change.
  | "exact"
  // Differed only in case and/or whitespace from the canonical form.
  | "case_or_whitespace"
  // The raw label was one of the configured aliases.
  | "alias";

// One audit record per raw label that the normalizer transformed. Items
// whose label was already canonical (match_type "exact") do NOT appear
// here, because there's nothing to record. The Firestore audit log
// includes this list so an analyst can see exactly what changed.
export type NormalizationApplied = {
  raw_label: string;
  canonical_label: string;
  match_type: Exclude<NormalizationMatchType, "exact">;
};

export type NormalizationResult = {
  // Line items with canonical labels (engine-ready). Order matches the
  // input items.
  normalized: LineItem[];
  // Transformations that were applied. Empty when every input was either
  // already canonical or unrecognized.
  applied: NormalizationApplied[];
  // Raw labels the normalizer did NOT recognize; these pass through
  // unchanged. The engine reports them in unused_labels for the analyst
  // to review.
  passed_through: string[];
};

// Reduce a label to its "matchable" form for lookup: trimmed, lowercased,
// internal whitespace collapsed to single spaces. This is the ONLY
// fuzziness the normalizer applies. We deliberately do NOT strip
// punctuation, hyphens, or parentheses because those carry meaning
// (e.g. "Net Income (Loss)" is a real label distinct from "Net Income").
export function normalForm(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

// Per-canonical lookup entry. `isAlias` distinguishes whether the key is
// the canonical's own normalized form (false) or one of the variants
// (true); the match_type on the result reflects that distinction.
type LookupEntry = { canonical: string; isAlias: boolean };

// Build the normalForm -> canonical lookup. Throws on a config conflict
// (two canonicals or two aliases that share a normalized form) because
// that would silently make one canonical unreachable. Exported so
// callers can pre-validate aliases at registry-load time.
export function buildAliasLookup(
  aliases: LabelAliases,
): Map<string, LookupEntry> {
  const lookup = new Map<string, LookupEntry>();

  for (const [canonical, variants] of Object.entries(aliases)) {
    const canonicalForm = normalForm(canonical);
    const existingForCanonical = lookup.get(canonicalForm);
    if (existingForCanonical && existingForCanonical.canonical !== canonical) {
      throw new Error(
        `Alias config conflict: canonical labels "${canonical}" and ` +
          `"${existingForCanonical.canonical}" share normalized form ` +
          `"${canonicalForm}". One would be unreachable. Fix the config.`,
      );
    }
    lookup.set(canonicalForm, { canonical, isAlias: false });

    for (const variant of variants) {
      const variantForm = normalForm(variant);
      const existing = lookup.get(variantForm);
      if (existing) {
        if (existing.canonical === canonical) {
          // Same canonical listing the variant redundantly. Harmless.
          continue;
        }
        // A different canonical already claimed this normalized form.
        // That's a real conflict.
        throw new Error(
          `Alias config conflict: variant "${variant}" (normalized form ` +
            `"${variantForm}") is claimed by both canonical "${canonical}" ` +
            `and "${existing.canonical}". Fix the config.`,
        );
      }
      lookup.set(variantForm, { canonical, isAlias: true });
    }
  }

  return lookup;
}

// Normalize a list of raw line items against an alias map.
//
// Behavior:
//   - Exact canonical match: emit unchanged.
//   - Case/whitespace-only difference: emit canonical, record as applied.
//   - Alias match: emit canonical, record as applied.
//   - No match: pass through, list in passed_through.
//
// Throws on a normalization collision (two raw labels in the input
// mapping to the same canonical). That's almost always either an
// extractor bug (the same line read twice with different labels) or an
// over-eager alias map. The right resolution is human review, not a
// silent guess.
export function normalizeLineItems(
  items: LineItem[],
  aliases: LabelAliases,
): NormalizationResult {
  const lookup = buildAliasLookup(aliases);

  type Classified = {
    item: LineItem;
    canonical: string | null;
    match_type: NormalizationMatchType | "passthrough";
  };

  const classified: Classified[] = items.map((item) => {
    const form = normalForm(item.label);
    const hit = lookup.get(form);
    if (!hit) {
      return { item, canonical: null, match_type: "passthrough" };
    }
    if (item.label === hit.canonical) {
      return { item, canonical: hit.canonical, match_type: "exact" };
    }
    return {
      item,
      canonical: hit.canonical,
      match_type: hit.isAlias ? "alias" : "case_or_whitespace",
    };
  });

  // Detect collisions: more than one raw label mapped to the same
  // canonical. Build the report up front so the error message names
  // every offending pair, not just the first one we find.
  const byCanonical = new Map<
    string,
    { raw_label: string; amount: number }[]
  >();
  for (const c of classified) {
    if (c.canonical === null) continue;
    const list = byCanonical.get(c.canonical) ?? [];
    list.push({ raw_label: c.item.label, amount: c.item.amount });
    byCanonical.set(c.canonical, list);
  }
  for (const [canonical, list] of byCanonical) {
    if (list.length > 1) {
      const detail = list
        .map((x) => `"${x.raw_label}" (${x.amount})`)
        .join(", ");
      throw new Error(
        `Normalization collision: multiple raw labels mapped to canonical ` +
          `"${canonical}". Raw labels and amounts: ${detail}. Resolve by ` +
          `fixing the extractor, the source statement, or the alias map.`,
      );
    }
  }

  const normalized: LineItem[] = [];
  const applied: NormalizationApplied[] = [];
  const passedThrough: string[] = [];

  for (const c of classified) {
    if (c.canonical === null) {
      normalized.push(c.item);
      passedThrough.push(c.item.label);
      continue;
    }
    normalized.push({ label: c.canonical, amount: c.item.amount });
    if (c.match_type !== "exact") {
      applied.push({
        raw_label: c.item.label,
        canonical_label: c.canonical,
        match_type: c.match_type as Exclude<NormalizationMatchType, "exact">,
      });
    }
  }

  return { normalized, applied, passed_through: passedThrough };
}
