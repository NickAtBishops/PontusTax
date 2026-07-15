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

  // Regression (2026-07-15): the month-name fallback branch used a
  // 4-digit-only year regex, so a real filename/period shape like
  // "Jan - Mar 25" (meaning January-March 2025) fell through to null
  // even though both month names were found — "25" simply never
  // matched \b(20\d{2})\b. The quarter-abbreviation branch already
  // tolerated 2-digit years via fourDigitYear(); the fallback needed
  // the same tolerance.
  it("accepts 2-digit years in the month-name fallback", () => {
    expect(parseSourcePeriod("Jan - Mar 25")).toEqual({
      startMonth: 1,
      endMonth: 3,
      year: 2025,
    });
    expect(parseSourcePeriod("Jan 26 - Mar 26")).toEqual({
      startMonth: 1,
      endMonth: 3,
      year: 2026,
    });
    expect(parseSourcePeriod("As of March 31, 26")).toEqual({
      startMonth: 3,
      endMonth: 3,
      year: 2026,
    });
  });

  // A day-of-month digit sitting next to a real 4-digit year must not
  // be misread as a conflicting 2-digit year candidate ("28" in
  // "February 28, 2026" is a day, not a year).
  it("does not let a day-of-month digit collide with a 4-digit year", () => {
    expect(parseSourcePeriod("Month ended February 28, 2026")).toEqual({
      startMonth: 2,
      endMonth: 2,
      year: 2026,
    });
  });

  // monthsEnded ("N months ended <month> <year>") gets the same
  // 2-digit-year tolerance as the quarter and month-name branches.
  it("accepts a 2-digit year in months-ended phrasing", () => {
    expect(
      parseSourcePeriod("Three months ended March 31, 25"),
    ).toEqual({ startMonth: 1, endMonth: 3, year: 2025 });
    expect(
      parseSourcePeriod("Six months ended June 30, 26"),
    ).toEqual({ startMonth: 1, endMonth: 6, year: 2026 });
  });

  // The annual/rolling-window refusal must still fire even with
  // 2-digit years now tolerated elsewhere in the function.
  it("still refuses annual and rolling-window phrasings with 2-digit years", () => {
    for (const phrase of [
      "Fiscal year ended March 31, 26",
      "Trailing 12 Months March 26",
      "LTM March 26",
    ]) {
      expect(parseSourcePeriod(phrase), phrase).toBeNull();
    }
  });

  // Regression (2026-07-15 adversarial review): the first version of
  // the 2-digit-year fallback scanned the WHOLE string for any bare
  // 2-digit number, so a suite number, invoice number, or street
  // address sitting anywhere near an unrelated month name was misread
  // as the year. The fix anchors the year to directly follow the last
  // month token; these must return null.
  it("does not mistake a nearby unrelated 2-digit number for the year", () => {
    for (const phrase of [
      "123 March Street Suite 25",
      "Invoice #25 for March",
      "March Rent Roll for Unit 25",
    ]) {
      expect(parseSourcePeriod(phrase), phrase).toBeNull();
    }
  });

  // A genuine period phrase surrounded by other prose is still found,
  // as long as the year directly follows the month with only
  // whitespace/dash in between — the surrounding words don't make the
  // date wrong, they're just noise around it.
  it("still finds a genuine period phrase embedded in surrounding prose", () => {
    expect(
      parseSourcePeriod("Statement for the period Jan-Mar-25 covering Suite 25B"),
    ).toEqual({ startMonth: 1, endMonth: 3, year: 2025 });
  });
});
