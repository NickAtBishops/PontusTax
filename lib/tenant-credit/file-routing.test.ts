import { describe, expect, it } from "vitest";

import { matchFileToTenant, matchScore } from "./file-routing";

// The actual Corp Financials roster names this matters for (from the
// real tracker workbook, column A).
const ROSTER = [
  "Fairfield Automotive Partners, LLC",
  "Dennis & Co Holdings, LLC",
  "Ethema Health Corporation",
  "Family Dollar Stores of Wisconsin, LLC",
  "Kabobs Acquisition, LLC",
  "Kraf, Inc.",
  "Olde School Industries, LLC",
  "Oceans Acquisition, Inc.",
  "Pinnacle Oil & Gas Holdings, Inc.",
  "Perfect Pizza Pie, LLC",
  "GPM Empire, LLC",
  "Solaero Technologies Corp.",
  "Trulieve, Inc.",
  "Valpak Direct Marketing Systems, Inc.",
].map((display_name, index) => ({ display_name, tenant_id: `t${index}` }));

function winnerName(path: string): string | null {
  return matchFileToTenant(path, ROSTER).winner?.display_name ?? null;
}

describe("file routing", () => {
  // Regression (2026-07-14 deep review): "corp" ⊂ "Corporate" silently
  // recommended Pinnacle's summary workbook onto Solaero's row.
  it("does not misroute 'Corporate Financials Summary' to Solaero via 'corp'", () => {
    expect(winnerName("Corporate Financials Summary (v3).xlsx")).toBeNull();
  });

  it("routes by the tenant-named FOLDER of the quarterly zip", () => {
    expect(
      winnerName("Pinnacle Oil & Gas Holdings, Inc/Corporate Financials Summary (v3).xlsx"),
    ).toBe("Pinnacle Oil & Gas Holdings, Inc.");
    expect(winnerName("Kraf/JANUARY.pdf")).toBe("Kraf, Inc.");
    expect(winnerName("Ethema Health Corporation/Evernia Q1 PL.pdf")).toBe(
      "Ethema Health Corporation",
    );
    expect(
      winnerName("Olde School Industries/03 March 2026 Financial Statements - Olde School.pdf"),
    ).toBe("Olde School Industries, LLC");
  });

  it("gives generic corporate suffixes no routing weight", () => {
    // "PAK Acquisition Corp." must not land on Kabobs Acquisition or
    // Oceans Acquisition via the word "acquisition".
    expect(winnerName("PAK Acquisition Corp. - AFS Dec 27 2025.pdf")).toBeNull();
    expect(matchScore("Acquisition Corp Holdings LLC", "Oceans Acquisition, Inc.")).toBe(0);
  });

  it("fails closed on ties and unknowns", () => {
    expect(winnerName("Q1 2026 Financials.pdf")).toBeNull();
    // "GPM Investments" shares no identity token with "GPM Empire, LLC"
    // ("gpm" is under the 4-char minimum) — manual assignment expected.
    expect(winnerName("GPM Investments/GPMI Financial Statements - 3.31.26.pdf")).toBeNull();
  });

  it("does not pool words across path segments", () => {
    // "family" and "dollar" sit in DIFFERENT segments: pooled scoring
    // would give Family Dollar 12 (6+6) and beat Statement Brothers'
    // single-segment 9; per-segment scoring caps Family Dollar at 6.
    const tenants = [
      { tenant_id: "a", display_name: "Family Dollar Stores of Wisconsin, LLC" },
      { tenant_id: "b", display_name: "Statement Brothers, LLC" },
    ];
    const result = matchFileToTenant("Dollar Tree/Family Statement.pdf", tenants);
    expect(result.winner?.display_name).toBe("Statement Brothers, LLC");
  });

  it("matches whole words only", () => {
    expect(matchScore("Trulieve Q1.pdf", "Trulieve, Inc.")).toBeGreaterThan(0);
    expect(matchScore("Trulieverified.pdf", "Trulieve, Inc.")).toBe(0);
  });
});
