import type ExcelJS from "exceljs";

import {
  METRIC_LABELS,
  WRITABLE_METRICS,
  quarterLabel,
  type MetricCell,
  type MetricKey,
  type QuarterId,
} from "./tracker-layout";

export const TARGET_SHEET_NAME = "Corp Financials ";

export const METRIC_SECTION_TITLES: Record<MetricKey, string> = {
  sales: "Sales (000s)",
  ebitda: "EBITDA (000s)",
  interest: "Interest (000s)",
  rent: "Rent (000s)",
  cash: "Cash (000s)",
  cfo: "CFO (000s)",
  capex: "Capex (000s)",
};

export function cellExactText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text ?? "").join("");
    }
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value && (value as { result?: unknown }).result != null) {
      return cellExactText((value as { result: ExcelJS.CellValue }).result);
    }
  }
  return "";
}

// A known, documented data-entry typo in the analyst's source
// spreadsheet: cell AI3 (the Q1 2026 EBITDA header) has repeatedly
// shipped as "Q4 26" instead of "Q1 26" in copies of the tracker. This
// tolerance existed in the previous hardcoded column-offset resolver
// and was dropped by accident when this dynamic scanner replaced it —
// restoring it here rather than requiring every analyst copy to be
// hand-corrected first. A workbook with the header spelled correctly
// is unaffected: the exact match always wins when both exist.
const KNOWN_HEADER_TYPOS: Partial<Record<MetricKey, Record<string, string>>> = {
  ebitda: { "Q1 26": "Q4 26" },
};

export function resolveTrackerTarget(
  sheet: ExcelJS.Worksheet,
  quarterId: QuarterId,
): { sheet_name: string; header_row: number; cells: MetricCell[] } {
  const expectedQuarter = quarterLabel(quarterId);
  const cells = WRITABLE_METRICS.map((metric) => {
    const alternateQuarter = KNOWN_HEADER_TYPOS[metric]?.[expectedQuarter] ?? null;
    const candidates: number[] = [];
    const alternateCandidates: number[] = [];
    for (let col = 1; col <= sheet.columnCount; col += 1) {
      const section = cellExactText(sheet.getCell(1, col).value);
      if (section !== METRIC_SECTION_TITLES[metric]) continue;
      const period = cellExactText(sheet.getCell(3, col).value);
      if (period === expectedQuarter) candidates.push(col);
      else if (alternateQuarter !== null && period === alternateQuarter) {
        alternateCandidates.push(col);
      }
    }
    // Prefer an exact match; only fall back to the known-typo alternate
    // when no column carries the correct header at all.
    const usingAlternate = candidates.length === 0 && alternateCandidates.length === 1;
    const resolved = usingAlternate ? alternateCandidates : candidates;
    if (resolved.length !== 1) {
      throw new Error(
        `${METRIC_LABELS[metric]} must have exactly one ${expectedQuarter} ` +
          `column under "${METRIC_SECTION_TITLES[metric]}"; found ` +
          `${resolved.length}.`,
      );
    }
    const col = resolved[0];
    if (sheet.getCell(3, col).isMerged) {
      throw new Error(
        `${METRIC_LABELS[metric]} ${expectedQuarter} header is merged. ` +
          "Refusing ambiguous target.",
      );
    }
    return {
      metric,
      col,
      header_expected: expectedQuarter,
      header_alternate: usingAlternate ? alternateQuarter : null,
    };
  });
  return { sheet_name: TARGET_SHEET_NAME, header_row: 3, cells };
}
