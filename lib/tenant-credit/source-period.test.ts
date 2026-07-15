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
});
