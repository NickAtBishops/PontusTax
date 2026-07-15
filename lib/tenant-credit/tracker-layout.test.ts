import { describe, expect, it } from "vitest";

import { trackerColumnsForQuarter } from "./tracker-layout";

describe("trackerColumnsForQuarter", () => {
  it("does not accept a Q4 26 alternate header for Q1 2026 EBITDA", () => {
    const target = trackerColumnsForQuarter("Q1_2026");
    const ebitda = target.cells.find((c) => c.metric === "ebitda");
    expect(ebitda).toMatchObject({
      header_expected: "Q1 26",
      header_alternate: null,
    });
  });
});
