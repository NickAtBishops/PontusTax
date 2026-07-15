import { describe, expect, it } from "vitest";

import { amountMatchesSourceUnits } from "./source-units";

describe("amountMatchesSourceUnits", () => {
  it("requires dollars to pass through without scaling", () => {
    expect(amountMatchesSourceUnits(59_784.2, 59_784.2, "dollars")).toBe(true);
    expect(amountMatchesSourceUnits(59_784.2, 59_784_200, "dollars")).toBe(false);
  });

  it("requires thousands and millions to be expanded to raw dollars", () => {
    expect(amountMatchesSourceUnits(59_784.2, 59_784_200, "thousands")).toBe(
      true,
    );
    expect(amountMatchesSourceUnits(1.365, 1_365_000, "millions")).toBe(true);
  });

  it("preserves negative signs during scaling", () => {
    expect(amountMatchesSourceUnits(-617.619, -617_619, "thousands")).toBe(true);
    expect(amountMatchesSourceUnits(-617.619, 617_619, "thousands")).toBe(false);
  });
});
