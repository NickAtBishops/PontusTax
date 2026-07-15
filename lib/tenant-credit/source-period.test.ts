import { describe, expect, it } from "vitest";

import { parseSourcePeriod, periodInsideQuarter } from "./source-period";

describe("parseSourcePeriod", () => {
  it("accepts tracker and abbreviated quarter labels", () => {
    expect(parseSourcePeriod("Q1 2026")).toEqual({
      startMonth: 1,
      endMonth: 3,
      year: 2026,
    });
    expect(parseSourcePeriod("Q1'26")).toEqual({
      startMonth: 1,
      endMonth: 3,
      year: 2026,
    });
  });

  it("parses month ranges and slash dates", () => {
    expect(parseSourcePeriod("January through March 2026")).toEqual({
      startMonth: 1,
      endMonth: 3,
      year: 2026,
    });
    expect(parseSourcePeriod("01/01/2026 - 03/31/2026")).toEqual({
      startMonth: 1,
      endMonth: 3,
      year: 2026,
    });
  });

  it("expands three-month-ended language to a full quarter", () => {
    expect(parseSourcePeriod("Three months ended March 31, 2026")).toEqual({
      startMonth: 1,
      endMonth: 3,
      year: 2026,
    });
  });

  it("rejects a six-month YTD period for a single quarter", () => {
    const period = parseSourcePeriod("Six months ended June 30, 2026");
    expect(period).toEqual({ startMonth: 1, endMonth: 6, year: 2026 });
    expect(periodInsideQuarter(period!, "Q2_2026")).toBe(false);
  });

  // Regression (2026-07-15): these phrasings used to fall through to
  // the month-name fallback and parse as a SINGLE MONTH, letting an
  // annual or trailing-12-month statement through the quarter gate
  // whenever its fiscal year ends inside the selected quarter (real
  // inputs: "GPMI Financial Statements - 3.31.26" is a fiscal year
  // ending in Q1; "Riverhead Trailing 12 Months March 2026").
  it("refuses annual and rolling-window phrasings instead of guessing", () => {
    for (const phrase of [
      "Fiscal year ended March 31, 2026",
      "Year ended December 27, 2025",
      "Years ended December 27, 2025 and December 28, 2024",
      "Trailing 12 Months March 2026",
      "Trailing twelve months ended March 2026",
      "LTM March 2026",
      "Year-to-date March 2026",
      "Annual report December 2025",
    ]) {
      expect(parseSourcePeriod(phrase), phrase).toBeNull();
    }
  });

  it("still accepts genuine monthly and quarterly phrasings", () => {
    expect(parseSourcePeriod("Month ended February 28, 2026")).toEqual({
      startMonth: 2,
      endMonth: 2,
      year: 2026,
    });
    expect(parseSourcePeriod("As of March 31, 2026")).toEqual({
      startMonth: 3,
      endMonth: 3,
      year: 2026,
    });
    expect(parseSourcePeriod("Jan 2026 - Mar 2026")).toEqual({
      startMonth: 1,
      endMonth: 3,
      year: 2026,
    });
  });
});
