import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  METRIC_SECTION_TITLES,
  resolveTrackerTarget,
} from "./tracker-target";
import { WRITABLE_METRICS } from "./tracker-layout";

function fixture(): ExcelJS.Worksheet {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Corp Financials ");
  for (const [index, metric] of WRITABLE_METRICS.entries()) {
    const col = index + 2;
    sheet.getCell(1, col).value = METRIC_SECTION_TITLES[metric];
    sheet.getCell(3, col).value = "Q1 26";
  }
  return sheet;
}

describe("resolveTrackerTarget", () => {
  it("resolves each metric only from its exact section and quarter", () => {
    const target = resolveTrackerTarget(fixture(), "Q1_2026");
    expect(target.sheet_name).toBe("Corp Financials ");
    expect(target.cells.map((cell) => cell.col)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("rejects a quarter header with trailing whitespace", () => {
    const sheet = fixture();
    sheet.getCell(3, 2).value = "Q1 26 ";
    expect(() => resolveTrackerTarget(sheet, "Q1_2026")).toThrow(
      /Sales must have exactly one Q1 26 column.*found 0/,
    );
  });

  it("rejects a duplicate matching section/quarter", () => {
    const sheet = fixture();
    sheet.getCell("J1").value = METRIC_SECTION_TITLES.sales;
    sheet.getCell("J3").value = "Q1 26";
    expect(() => resolveTrackerTarget(sheet, "Q1_2026")).toThrow(/found 2/);
  });

  it("rejects a merged quarter header", () => {
    const sheet = fixture();
    sheet.mergeCells("B3:B4");
    expect(() => resolveTrackerTarget(sheet, "Q1_2026")).toThrow(
      /header is merged/,
    );
  });

  // Regression (2026-07-15): a known, documented data-entry typo in the
  // analyst's tracker — the Q1 2026 EBITDA header cell reads "Q4 26"
  // instead of "Q1 26" — used to be tolerated by the old hardcoded
  // column-offset resolver. This dynamic scanner dropped that tolerance
  // during the migration, so a real copy of the tracker with the typo
  // still present threw "EBITDA must have exactly one Q1 26 column
  // ...; found 0" and refused the whole batch.
  it("tolerates the known Q1 2026 EBITDA header typo (Q4 26)", () => {
    const sheet = fixture();
    const ebitdaCol = WRITABLE_METRICS.indexOf("ebitda") + 2;
    sheet.getCell(3, ebitdaCol).value = "Q4 26";
    const target = resolveTrackerTarget(sheet, "Q1_2026");
    const ebitdaCell = target.cells.find((cell) => cell.metric === "ebitda")!;
    expect(ebitdaCell.col).toBe(ebitdaCol);
    expect(ebitdaCell.header_alternate).toBe("Q4 26");
    // Every other metric is unaffected and still resolves without an
    // alternate.
    for (const cell of target.cells) {
      if (cell.metric === "ebitda") continue;
      expect(cell.header_alternate).toBeNull();
    }
  });

  it("prefers an exact Q1 26 EBITDA header over the typo alternate when both exist", () => {
    const sheet = fixture();
    const ebitdaCol = WRITABLE_METRICS.indexOf("ebitda") + 2;
    sheet.getCell(3, ebitdaCol).value = "Q1 26";
    const target = resolveTrackerTarget(sheet, "Q1_2026");
    const ebitdaCell = target.cells.find((cell) => cell.metric === "ebitda")!;
    expect(ebitdaCell.header_alternate).toBeNull();
  });

  it("does not tolerate the typo on any metric other than EBITDA", () => {
    const sheet = fixture();
    const salesCol = WRITABLE_METRICS.indexOf("sales") + 2;
    sheet.getCell(3, salesCol).value = "Q4 26";
    expect(() => resolveTrackerTarget(sheet, "Q1_2026")).toThrow(
      /Sales must have exactly one Q1 26 column.*found 0/,
    );
  });
});
