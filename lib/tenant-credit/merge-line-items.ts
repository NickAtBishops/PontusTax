import {
  documentTypesOverlap,
  parseSourcePeriod,
  periodInsideQuarter,
  periodsOverlap,
  quarterPeriod,
  type SourceDocumentType,
  type SourcePeriod,
  type SourceScopeType,
} from "./source-period";
import type { QuarterId } from "./tracker-layout";

export type MergeExtract = {
  source_entity: string;
  source_period: string;
  source_file_hash: string;
  source_filename: string;
  source_units: "dollars" | "thousands" | "millions";
  source_units_evidence: string;
  document_type: SourceDocumentType;
  source_scope: string;
  source_scope_type: SourceScopeType;
  source_scope_identifiers: string[];
  period_selection:
    | "printed_quarter_total"
    | "summed_months"
    | "single_period_column"
    | "point_in_time";
  line_items: {
    label: string;
    printed_amount: number;
    amount: number;
    source_reference: string;
  }[];
  // Analyst-supplied reason when this extract's own source_period does
  // NOT fall inside the selected quarter but the analyst wants it
  // included anyway (an explicit judgment call, not a mistake). Empty
  // string ("") means no override. Mirrors the existing
  // entity_override_reason pattern in the writeback route: a non-empty
  // reason is required before the mismatch is allowed through, and the
  // reason is surfaced in the audit trail (see writeback route). This
  // ONLY waives the "does this extract's period match the selected
  // quarter" check below — every other check (coverage, overlap,
  // entity-wide exclusion, unparseable-period-with-NO-override) still
  // runs and can still throw.
  period_override_reason?: string;
};

export type ExcludedExtract = {
  extract: MergeExtract;
  reason: string;
};

export type MergeResult = {
  merged: { label: string; amount: number; source_reference: string }[];
  conflicts: string[];
  includedExtracts: MergeExtract[];
  excludedExtracts: ExcludedExtract[];
};

function normalizedIdentifiers(extract: MergeExtract): Set<string> {
  return new Set(
    extract.source_scope_identifiers
      .map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ""))
      .filter(Boolean),
  );
}

function sameIdentifiers(a: MergeExtract, b: MergeExtract): boolean {
  const left = [...normalizedIdentifiers(a)].sort();
  const right = [...normalizedIdentifiers(b)].sort();
  return (
    left.length > 0 &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function disjointIdentifiers(a: MergeExtract, b: MergeExtract): boolean {
  const left = normalizedIdentifiers(a);
  const right = normalizedIdentifiers(b);
  return left.size > 0 && right.size > 0 && ![...left].some((id) => right.has(id));
}

function isComponent(extract: MergeExtract): boolean {
  return (
    extract.source_scope_type === "component_subset" ||
    extract.source_scope_type === "single_component"
  );
}

function flowDocument(type: SourceDocumentType): boolean {
  return type !== "balance_sheet";
}

function assertQuarterCoverage(
  extracts: MergeExtract[],
  periods: Map<string, SourcePeriod>,
  quarterId: QuarterId,
): void {
  const quarter = quarterPeriod(quarterId);
  // An overridden extract whose period is genuinely unparseable has no
  // entry in `periods` — it has no known months, so it cannot
  // contribute to (or be checked against) month-coverage math. It is
  // still summed into totals by the caller; this function only
  // decides whether the REMAINING extracts fully cover the quarter.
  const withKnownPeriod = extracts.filter((extract) =>
    periods.has(extract.source_file_hash),
  );
  const types = new Set(withKnownPeriod.map((extract) => extract.document_type));
  for (const type of types) {
    const sameType = withKnownPeriod.filter(
      (extract) => extract.document_type === type,
    );
    if (type === "balance_sheet") {
      for (const extract of sameType) {
        const period = periods.get(extract.source_file_hash)!;
        if (period.endMonth !== quarter.endMonth) {
          throw new Error(
            `${extract.source_filename}: a balance sheet must use the ` +
              `${quarterId.replace("_", " ")} quarter-end column.`,
          );
        }
      }
      continue;
    }
    if (!flowDocument(type)) continue;
    const coveredMonths = new Set<number>();
    for (const extract of sameType) {
      const period = periods.get(extract.source_file_hash)!;
      for (let month = period.startMonth; month <= period.endMonth; month += 1) {
        coveredMonths.add(month);
      }
    }
    for (let month = quarter.startMonth; month <= quarter.endMonth; month += 1) {
      if (!coveredMonths.has(month)) {
        throw new Error(
          `${type} sources do not cover every month in ` +
            `${quarterId.replace("_", " ")}; month ${month} is missing.`,
        );
      }
    }
  }
}

// The sheet/page a source_reference points at, or null when the
// reference carries no location we can parse. Used to tell "the same
// label on two different sheets/pages" (a repeat of one fact — dedupe
// or refuse) apart from "two rows on the same sheet" (two facts — sum).
function sheetKeyOf(reference: string): string | null {
  const bang = reference.match(/^\s*'?([^'!]+)'?!/);
  if (bang) return `sheet:${bang[1].trim().toLowerCase()}`;
  const sheet = reference.match(/\bsheet[:\s]+"?([^",]+)/i);
  if (sheet) return `sheet:${sheet[1].trim().toLowerCase()}`;
  const page = reference.match(/\bpage\s+(\d+)/i);
  if (page) return `page:${page[1]}`;
  return null;
}

type ConsolidatedItem = {
  label: string;
  amount: number;
  source_reference: string;
};

// Within ONE extract, the same label can repeat for two very different
// reasons. Equal amounts on different sheets/pages are one fact stated
// several times (Net Income appears on the income statement, the
// balance-sheet equity section, and the cash-flow top line) — count it
// once. Different amounts on different sheets are a consolidated
// workbook's per-location repeats (Combined + one sheet per facility,
// each with its own "Total Revenue") — summing those double-counts the
// metric, so refuse loudly and let the analyst attach the consolidated
// statement alone. Repeats on the SAME sheet stay summed: they are
// genuinely distinct rows.
function consolidateExtractItems(extract: MergeExtract): {
  items: ConsolidatedItem[];
  notes: string[];
} {
  const groups = new Map<string, MergeExtract["line_items"]>();
  const order: string[] = [];
  for (const item of extract.line_items) {
    const key = item.label.trim();
    if (!key) continue;
    if (!groups.has(key)) order.push(key);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const items: ConsolidatedItem[] = [];
  const notes: string[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      items.push({
        label: key,
        amount: group[0].amount,
        source_reference: group[0].source_reference,
      });
      continue;
    }
    const amounts = group.map((item) => item.amount);
    const allEqual =
      Math.max(...amounts) - Math.min(...amounts) < 0.01;
    const sheetKeys = new Set(
      group.map((item) => sheetKeyOf(item.source_reference)),
    );
    const distinctSheets =
      [...sheetKeys].filter((value) => value !== null).length;
    const crossSheet = distinctSheets > 1;
    if (allEqual && crossSheet) {
      notes.push(
        `${extract.source_filename}: "${key}" appears ${group.length} times ` +
          "with the identical amount on different sheets/pages " +
          `(${group.map((item) => item.source_reference).join("; ")}); ` +
          "counted once.",
      );
      items.push({
        label: key,
        amount: group[0].amount,
        source_reference: group
          .map((item) => item.source_reference)
          .join("; "),
      });
      continue;
    }
    if (!allEqual && crossSheet) {
      throw new Error(
        `${extract.source_filename}: "${key}" appears ${group.length} times ` +
          "with DIFFERENT amounts on different sheets " +
          `(${group
            .map((item) => `${item.source_reference}=${item.amount.toLocaleString()}`)
            .join("; ")}). ` +
          "This looks like a consolidated workbook with per-location " +
          "sheets — summing them would double-count. Attach the " +
          "consolidated statement on its own instead.",
      );
    }
    // Same sheet (or unparseable references): genuinely distinct rows.
    for (const item of group) {
      items.push({
        label: key,
        amount: item.amount,
        source_reference: item.source_reference,
      });
    }
    notes.push(
      `${extract.source_filename}: "${key}" appears ${group.length} times ` +
        `on the same sheet (${group
          .map((item) => item.amount.toLocaleString())
          .join(", ")}); summed as distinct rows.`,
    );
  }
  return { items, notes };
}

// Merge one quarter's source packet without double-counting parent and
// component statements. An entity-wide rollup wins over overlapping location
// or cost-unit details. Component statements can be added only when their
// structured identifiers prove their scopes are disjoint. Every exclusion is
// returned for analyst review and audit; ambiguous scope fails closed.
export function mergeLineItems(
  extracts: MergeExtract[],
  quarterId: QuarterId,
): MergeResult {
  if (extracts.length === 0) throw new Error("No source extracts to merge.");

  // Extracts whose own period doesn't match the selected quarter but
  // carry an analyst-supplied period_override_reason skip ONLY the two
  // throws below (unparseable period / outside the quarter). Every
  // other check in this function — coverage, overlap, entity-wide
  // exclusion — still runs against them unchanged. When the period IS
  // parseable (just outside the quarter), it's still recorded in
  // `periods` so overlap/coverage math has a real period to use. When
  // it's genuinely unparseable even with the override, the extract has
  // no entry in `periods` at all: it is still summed into totals below,
  // but excluded from month-coverage accounting (assertQuarterCoverage)
  // and from any check that requires comparing periods, since there is
  // no period to compare. See `hasKnownPeriod` guards below.
  const periods = new Map<string, SourcePeriod>();
  const hashes = new Set<string>();
  for (const extract of extracts) {
    if (!extract.source_file_hash) {
      throw new Error(`${extract.source_filename}: extraction has no source hash.`);
    }
    if (hashes.has(extract.source_file_hash)) {
      throw new Error(
        `${extract.source_filename}: this exact file is attached more than once.`,
      );
    }
    hashes.add(extract.source_file_hash);
    const overridden = Boolean(extract.period_override_reason);
    const period = parseSourcePeriod(extract.source_period);
    if (!period) {
      if (overridden) continue;
      throw new Error(
        `${extract.source_filename}: source period "${extract.source_period}" ` +
          "could not be converted to a calendar period. Refusing to guess.",
      );
    }
    if (!periodInsideQuarter(period, quarterId) && !overridden) {
      throw new Error(
        `${extract.source_filename}: source period "${extract.source_period}" ` +
          `does not fall inside ${quarterId.replace("_", " ")}.`,
      );
    }
    periods.set(extract.source_file_hash, period);
  }

  // An overridden extract with a genuinely unparseable period has no
  // entry in `periods` (see the loop above). It cannot be compared by
  // period to anything else, so it can neither be excluded as
  // overlapping a rollup nor flag ANOTHER extract as overlapping it —
  // it simply skips every period-comparison check below and goes
  // straight to the sum.
  const hasKnownPeriod = (extract: MergeExtract): boolean =>
    periods.has(extract.source_file_hash);

  const excluded = new Map<string, string>();
  for (const rollup of extracts.filter(
    (extract) => extract.source_scope_type === "entity_wide" && hasKnownPeriod(extract),
  )) {
    const rollupPeriod = periods.get(rollup.source_file_hash)!;
    const overlappingRollups = extracts.filter((candidate) => {
      if (candidate.source_file_hash === rollup.source_file_hash) return false;
      if (candidate.source_scope_type !== "entity_wide") return false;
      if (!hasKnownPeriod(candidate)) return false;
      return (
        documentTypesOverlap(rollup.document_type, candidate.document_type) &&
        periodsOverlap(rollupPeriod, periods.get(candidate.source_file_hash)!)
      );
    });
    if (overlappingRollups.length > 0) {
      throw new Error(
        `${rollup.source_filename} and ${overlappingRollups[0].source_filename} ` +
          "are overlapping entity-wide statements. Keep exactly one rollup.",
      );
    }
    for (const component of extracts.filter(
      (extract) => isComponent(extract) && hasKnownPeriod(extract),
    )) {
      if (
        documentTypesOverlap(rollup.document_type, component.document_type) &&
        periodsOverlap(rollupPeriod, periods.get(component.source_file_hash)!)
      ) {
        excluded.set(
          component.source_file_hash,
          `Excluded because ${rollup.source_filename} is an overlapping ` +
            "entity-wide rollup.",
        );
      }
    }
  }

  const included = extracts.filter(
    (extract) => !excluded.has(extract.source_file_hash),
  );
  for (let i = 0; i < included.length; i += 1) {
    for (let j = i + 1; j < included.length; j += 1) {
      const left = included[i];
      const right = included[j];
      if (!hasKnownPeriod(left) || !hasKnownPeriod(right)) continue;
      if (!documentTypesOverlap(left.document_type, right.document_type)) continue;
      const overlap = periodsOverlap(
        periods.get(left.source_file_hash)!,
        periods.get(right.source_file_hash)!,
      );
      if (overlap) {
        if (isComponent(left) && isComponent(right) && disjointIdentifiers(left, right)) {
          continue;
        }
        throw new Error(
          `${left.source_filename} and ${right.source_filename} contain ` +
            "overlapping statement periods without provably disjoint scopes.",
        );
      }
      const compatibleMonthlyScope =
        (left.source_scope_type === "entity_wide" &&
          right.source_scope_type === "entity_wide") ||
        (isComponent(left) && isComponent(right) && sameIdentifiers(left, right));
      if (!compatibleMonthlyScope) {
        throw new Error(
          `${left.source_filename} and ${right.source_filename} cover different ` +
            "months but not the same entity scope. Refusing an incomplete rollup.",
        );
      }
    }
  }

  assertQuarterCoverage(included, periods, quarterId);

  const totals = new Map<string, number>();
  const references = new Map<string, string[]>();
  const seenAmounts = new Map<string, number[]>();
  const withinFileNotes: string[] = [];
  for (const extract of included) {
    const { items, notes } = consolidateExtractItems(extract);
    withinFileNotes.push(...notes);
    for (const item of items) {
      const key = item.label;
      totals.set(key, (totals.get(key) ?? 0) + item.amount);
      references.set(key, [
        ...(references.get(key) ?? []),
        `${extract.source_filename}: ${item.source_reference}`,
      ]);
      seenAmounts.set(key, [...(seenAmounts.get(key) ?? []), item.amount]);
    }
  }

  const conflicts: string[] = [...withinFileNotes];
  for (const [label, amounts] of seenAmounts) {
    if (amounts.length <= 1) continue;
    const total = totals.get(label) ?? 0;
    conflicts.push(
      `"${label}" appeared ${amounts.length} times across included files ` +
        `(${amounts.map((amount) => amount.toLocaleString()).join(", ")}); ` +
        `summed to ${total.toLocaleString()}.`,
    );
  }

  return {
    merged: Array.from(totals.entries()).map(([label, amount]) => ({
      label,
      amount,
      source_reference: (references.get(label) ?? []).join(" | "),
    })),
    conflicts,
    includedExtracts: included,
    excludedExtracts: extracts
      .filter((extract) => excluded.has(extract.source_file_hash))
      .map((extract) => ({
        extract,
        reason: excluded.get(extract.source_file_hash)!,
      })),
  };
}
