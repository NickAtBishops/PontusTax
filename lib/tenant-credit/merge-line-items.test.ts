import { describe, expect, it } from "vitest";

import { mergeLineItems, type MergeExtract } from "./merge-line-items";

function source(
  filename: string,
  period: string,
  amount: number,
  overrides: Partial<MergeExtract> = {},
): MergeExtract {
  const hashSeed = Array.from(filename)
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return {
    source_entity: "Example Tenant LLC",
    source_period: period,
    source_file_hash: (hashSeed + "0".repeat(64)).slice(0, 64),
    source_filename: filename,
    source_units: "dollars",
    source_units_evidence: "$ with cents",
    document_type: "income_statement",
    source_scope: "entire entity",
    source_scope_type: "entity_wide",
    source_scope_identifiers: [],
    period_selection: "single_period_column",
    line_items: [
      {
        label: "Total Income",
        printed_amount: amount,
        amount,
        source_reference: "page 1, Total column",
      },
    ],
    ...overrides,
  };
}

describe("mergeLineItems", () => {
  it("sums non-overlapping monthly entity-wide statements", () => {
    const result = mergeLineItems(
      [
        source("jan.pdf", "Jan 2026", 100_000),
        source("feb.pdf", "Feb 2026", 250_000),
        source("mar.pdf", "Mar 2026", 50_000),
      ],
      "Q1_2026",
    );
    expect(result.merged).toEqual([
      {
        label: "Total Income",
        amount: 400_000,
        source_reference:
          "jan.pdf: page 1, Total column | feb.pdf: page 1, Total column | " +
          "mar.pdf: page 1, Total column",
      },
    ]);
    expect(result.conflicts[0]).toContain("summed to 400,000");
  });

  it("uses one entity-wide rollup and excludes overlapping CU details", () => {
    const rollup = source(
      "Pinnacle Holding INC_Income Statement_Q1_2026.pdf",
      "Jan 2026 - Mar 2026",
      59_784_204.82,
      { period_selection: "printed_quarter_total" },
    );
    const component = source(
      "Consolidated P&L CU 40 to CU 45_Q1 2026.pdf",
      "Q1 2026",
      2_624_228.49,
      {
        source_scope: "CU 40 through CU 45",
        source_scope_type: "component_subset",
        source_scope_identifiers: [
          "CU 40",
          "CU 41",
          "CU 42",
          "CU 43",
          "CU 44",
          "CU 45",
        ],
      },
    );
    const result = mergeLineItems([rollup, component], "Q1_2026");
    expect(result.merged[0].amount).toBe(59_784_204.82);
    expect(result.includedExtracts.map((item) => item.source_filename)).toEqual([
      rollup.source_filename,
    ]);
    expect(result.excludedExtracts[0].reason).toContain("entity-wide rollup");
  });

  it("allows overlapping component statements only when identifiers are disjoint", () => {
    const left = source("cu40.pdf", "Q1 2026", 100_000, {
      source_scope: "CU 40",
      source_scope_type: "single_component",
      source_scope_identifiers: ["CU 40"],
    });
    const right = source("cu61.pdf", "Q1 2026", 250_000, {
      source_scope: "CU 61",
      source_scope_type: "single_component",
      source_scope_identifiers: ["CU 61"],
    });
    expect(mergeLineItems([left, right], "Q1_2026").merged[0].amount).toBe(
      350_000,
    );
  });

  it("rejects overlapping component scopes", () => {
    const parent = source("cu27-97.pdf", "Q1 2026", 100_000, {
      source_scope: "selected cost units",
      source_scope_type: "component_subset",
      source_scope_identifiers: ["CU 27", "CU 61", "CU 97"],
    });
    const subset = source("cu61.pdf", "Q1 2026", 25_000, {
      source_scope: "CU 61",
      source_scope_type: "single_component",
      source_scope_identifiers: ["CU 61"],
    });
    expect(() => mergeLineItems([parent, subset], "Q1_2026")).toThrow(
      /without provably disjoint scopes/,
    );
  });

  it("rejects an incomplete monthly packet", () => {
    expect(() =>
      mergeLineItems(
        [
          source("jan.pdf", "Jan 2026", 100_000),
          source("mar.pdf", "Mar 2026", 50_000),
        ],
        "Q1_2026",
      ),
    ).toThrow(/month 2 is missing/);
  });

  it("rejects a source outside the selected quarter", () => {
    expect(() =>
      mergeLineItems(
        [source("q2.pdf", "Apr 2026 - Jun 2026", 100_000)],
        "Q1_2026",
      ),
    ).toThrow(/does not fall inside Q1 2026/);
  });

  it("rejects an exact duplicate file hash", () => {
    const first = source("first.pdf", "Q1 2026", 100_000);
    const duplicate = source("second.pdf", "Q1 2026", 100_000, {
      source_file_hash: first.source_file_hash,
    });
    expect(() => mergeLineItems([first, duplicate], "Q1_2026")).toThrow(
      /exact file is attached more than once/,
    );
  });

  // Within-extract repeats (2026-07-14 deep review). A consolidated
  // workbook with per-facility sheets repeats "Total Revenue" once per
  // sheet with DIFFERENT amounts — summing writes ~2x the true figure
  // (real shape: Oceans "Q1 2026 Pontus P&Ls.xlsx", Combined + 6
  // facilities). Equal amounts on different sheets are one fact stated
  // twice (Net Income on the income statement AND the cash-flow top
  // line) and must count once. Same-sheet repeats are distinct rows.
  it("refuses per-sheet repeats with different amounts inside one workbook", () => {
    const workbook = source("oceans.xlsx", "Q1 2026", 0, {
      line_items: [
        {
          label: "Total Revenue",
          printed_amount: 6_169_482,
          amount: 6_169_482,
          source_reference: "Combined!B14",
        },
        {
          label: "Total Revenue",
          printed_amount: 1_000_000,
          amount: 1_000_000,
          source_reference: "Abilene!B14",
        },
      ],
    });
    expect(() => mergeLineItems([workbook], "Q1_2026")).toThrow(
      /DIFFERENT amounts on different sheets/,
    );
  });

  it("counts an equal-amount cross-statement repeat once", () => {
    const packet = source("package.pdf", "Q1 2026", 0, {
      line_items: [
        {
          label: "Net Income",
          printed_amount: 100_000,
          amount: 100_000,
          source_reference: "page 3, income statement",
        },
        {
          label: "Net Income",
          printed_amount: 100_000,
          amount: 100_000,
          source_reference: "page 5, cash flow statement",
        },
      ],
    });
    const result = mergeLineItems([packet], "Q1_2026");
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].amount).toBe(100_000);
    expect(result.conflicts.some((note) => note.includes("counted once"))).toBe(
      true,
    );
  });

  it("still sums genuinely distinct rows on the same sheet", () => {
    const workbook = source("stores.xlsx", "Q1 2026", 0, {
      line_items: [
        {
          label: "Rent",
          printed_amount: 5_000,
          amount: 5_000,
          source_reference: "P&L!B10",
        },
        {
          label: "Rent",
          printed_amount: 5_000,
          amount: 5_000,
          source_reference: "P&L!B22",
        },
      ],
    });
    const result = mergeLineItems([workbook], "Q1_2026");
    expect(result.merged).toHaveLength(1);
    expect(result.merged[0].amount).toBe(10_000);
  });
});
