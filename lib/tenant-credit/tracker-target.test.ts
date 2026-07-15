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
});
