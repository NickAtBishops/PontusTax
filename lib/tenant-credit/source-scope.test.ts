import { describe, expect, it } from "vitest";

import type { RawExtractionResult } from "./extraction";
import { applyFilenameScopeGuard } from "./source-scope";

function entityWide(labels: string[]): RawExtractionResult {
  return {
    source_entity: "Evernia Health Center LLC",
    source_period: "January through March 2026",
    source_units: "dollars",
    source_units_evidence: "Amounts show cents",
    document_type: "income_statement",
    source_scope: "entire entity",
    source_scope_type: "entity_wide",
    source_scope_identifiers: [],
    period_selection: "printed_quarter_total",
    line_items: labels.map((label) => ({
      label,
      printed_amount: 100,
      amount: 100,
      source_reference: "TOTAL column",
    })),
  };
}

describe("applyFilenameScopeGuard", () => {
  it("reclassifies the actual Evernia Boca filename when Boca appears in the rows", () => {
    const guarded = applyFilenameScopeGuard(
      entityWide(["6401002 - Rent - Boca cove", "Net Income"]),
      "Evernia Q1 PL Boca.pdf",
    );

    expect(guarded.applied).toBe(true);
    expect(guarded.extraction.source_scope_type).toBe("single_component");
    expect(guarded.extraction.source_scope_identifiers).toEqual(["Boca"]);
  });

  it("leaves the entity-wide Evernia rollup unchanged", () => {
    const input = entityWide(["Total Income", "Rent - Boca cove"]);
    const guarded = applyFilenameScopeGuard(input, "Evernia Q1 PL.pdf");

    expect(guarded).toEqual({ extraction: input, applied: false, evidence: null });
  });

  it("does not treat revision metadata as a location", () => {
    const input = entityWide(["Total Income", "Net Income"]);
    const guarded = applyFilenameScopeGuard(input, "Evernia Q1 PL Revised.pdf");

    expect(guarded.applied).toBe(false);
  });

  it("does not reclassify a suffix without matching source evidence", () => {
    const input = entityWide(["Total Income", "Net Income"]);
    const guarded = applyFilenameScopeGuard(input, "Evernia Q1 PL Boca.pdf");

    expect(guarded.applied).toBe(false);
  });

  it("ignores quarter tokens after an ordinary income-statement filename", () => {
    const input = entityWide(["Total for Income", "Net Income"]);
    const guarded = applyFilenameScopeGuard(
      input,
      "Pinnacle Holding INC_Income Statement_Q1_2026.pdf",
    );

    expect(guarded.applied).toBe(false);
  });
});
