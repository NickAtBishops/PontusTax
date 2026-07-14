import { describe, expect, it } from "vitest";

import { classifyLineItem, computeGeneric } from "./generic-methodology";

// Regression coverage for the two QuickBooks P&L layouts the "Total
// Income" rule has to serve at once:
//
//   1. Chart-of-accounts layout — every revenue line reads
//      "Total <account> · ..." and is ignored as a subtotal, so
//      "Total Income" must be classified as sales or the metric is
//      empty (the bug fixed on 2026-07-02).
//   2. Standard expanded layout — individual revenue lines classify as
//      sales AND "Total Income" appears, so computeGeneric must keep
//      only the subtotal or Sales comes out exactly doubled (the
//      regression the 2026-07-08 ultrareview caught).
describe("Total Income subtotal handling", () => {
  it("classifies 'Total Income' as a sales subtotal", () => {
    const decision = classifyLineItem("Total Income");
    expect(decision.category).toBe("sales");
    expect(decision.subtotal).toBe(true);
  });

  it("does not double-count on an expanded P&L (constituents + Total Income)", () => {
    const result = computeGeneric([
      { label: "Product Sales · Widget", amount: 500_000 },
      { label: "Service Revenue", amount: 300_000 },
      { label: "Total Income", amount: 800_000 },
    ]);
    // 800, not 1600: the subtotal wins, the constituents are dropped.
    expect(result.sales).toBe(800);
    expect(result.metrics.sales.contributions).toHaveLength(1);
    expect(result.metrics.sales.contributions[0].label).toBe("Total Income");
  });

  it("logs dropped constituents in unused_labels for the audit view", () => {
    const result = computeGeneric([
      { label: "Product Sales · Widget", amount: 500_000 },
      { label: "Service Revenue", amount: 300_000 },
      { label: "Total Income", amount: 800_000 },
    ]);
    const dropped = result.unused_labels.filter((l) =>
      l.includes("dropped to avoid double-count"),
    );
    expect(dropped).toHaveLength(2);
    expect(dropped[0]).toContain("Product Sales · Widget");
    expect(dropped[1]).toContain("Service Revenue");
  });

  it("still fills Sales from Total Income on a chart-of-accounts P&L", () => {
    const result = computeGeneric([
      { label: "Total Design Income · 40100", amount: 500_000 },
      { label: "Total Consulting Income · 40200", amount: 300_000 },
      { label: "Total Income", amount: 800_000 },
    ]);
    expect(result.sales).toBe(800);
    expect(result.metrics.sales.contributions).toHaveLength(1);
    expect(result.metrics.sales.contributions[0].label).toBe("Total Income");
  });

  it("sums constituents normally when no subtotal line is present", () => {
    const result = computeGeneric([
      { label: "Product Sales · Widget", amount: 500_000 },
      { label: "Service Revenue", amount: 300_000 },
    ]);
    expect(result.sales).toBe(800);
    expect(result.metrics.sales.contributions).toHaveLength(2);
  });

  it("prefers the subtotal even when the extractor missed a constituent", () => {
    // Only one of two revenue accounts made it out of the PDF, but the
    // statement's own total is complete — Sales should trust it.
    const result = computeGeneric([
      { label: "Service Revenue", amount: 300_000 },
      { label: "Total Income", amount: 800_000 },
    ]);
    expect(result.sales).toBe(800);
  });

  it("keeps ignoring EBIT-level subtotals like Net Ordinary Income", () => {
    const result = computeGeneric([
      { label: "Total Income", amount: 800_000 },
      { label: "Net Ordinary Income", amount: -551_000 },
    ]);
    expect(result.sales).toBe(800);
    expect(
      result.unused_labels.some((l) => l.includes("Net Ordinary Income")),
    ).toBe(true);
  });

  // Regression coverage for a real Oceans Healthcare statement
  // (2026-07-14): the top line is labelled "Total Revenue", not
  // QuickBooks' "Total Income", and its constituents ("Net Revenue",
  // "Grant Revenue") independently classify as sales too. Before this,
  // "Total Revenue" wasn't recognized as a subtotal at all — it hit the
  // blanket "total" ignore rule and was discarded, while its
  // constituents summed to a figure that double-counted a sub-line.
  it("treats 'Total Revenue' as the subtotal, not just 'Total Income'", () => {
    const result = computeGeneric([
      { label: "PHP Revenue", amount: 137_767 },
      { label: "Net Revenue", amount: 6_052_222 },
      { label: "Grant Revenue", amount: 110_968 },
      { label: "Total Revenue", amount: 6_169_482 },
    ]);
    expect(result.sales).toBe(6_169);
    expect(result.metrics.sales.contributions).toHaveLength(1);
    expect(result.metrics.sales.contributions[0].label).toBe("Total Revenue");
  });
});

// Regression coverage for a real GPM Investments statement (2026-07-14):
// "TTL Gross Income" is gross profit after cost of fuel, not revenue,
// but the word "income" alone used to route it into the sales
// catch-all — the only line on that sheet that did, understating Sales
// by roughly three orders of magnitude.
describe("gross-profit lines are not revenue", () => {
  it("does not classify 'Gross Income' labels as sales", () => {
    const decision = classifyLineItem("TTL Gross Income");
    expect(decision.category).toBe("ignore");
  });

  it("leaves Sales null when the only line is a gross-profit figure", () => {
    const result = computeGeneric([
      { label: "TTL Gross Income", amount: 620_343.98 },
    ]);
    expect(result.sales).toBeNull();
  });
});

// Regression coverage for a real tenant PDF (2026-07-14): plain "Rent"
// (no "Expense"/"Paid"/"Cost" suffix) is extremely common phrasing and
// previously fell through to "ignore", leaving the Rent tracker column
// blank despite a real dollar figure on the statement.
describe("bare 'Rent' labels", () => {
  it("classifies bare 'Rent' as rent expense", () => {
    expect(classifyLineItem("Rent").category).toBe("rent_expense");
    expect(classifyLineItem("Rent - Boca cove").category).toBe("rent_expense");
  });

  it("still excludes rent income", () => {
    expect(classifyLineItem("Rent Income").category).toBe("ignore");
  });

  it("excludes balance-sheet rent items (receivable/deposit/prepaid)", () => {
    expect(classifyLineItem("Rent Receivable").category).toBe("ignore");
    expect(classifyLineItem("Prepaid Rent").category).toBe("ignore");
  });

  it("populates the Rent metric from a bare 'Rent' line", () => {
    const result = computeGeneric([{ label: "Rent", amount: 145_000 }]);
    expect(result.rent).toBe(145);
  });
});

// Regression coverage: an intercompany line with no matching counterpart
// used to vanish from every audit surface — not "ignore" (so absent from
// unused_labels) and unpaired (so absent from intercompany_observed).
describe("orphaned intercompany lines", () => {
  it("surfaces an unpaired intercompany line in unused_labels", () => {
    const result = computeGeneric([
      { label: "Net Income", amount: 443_000 },
      { label: "Intercompany Mgmt Fees", amount: 85_000 },
    ]);
    expect(result.intercompany_observed).toHaveLength(0);
    expect(
      result.unused_labels.some((l) => l.includes("Intercompany Mgmt Fees")),
    ).toBe(true);
  });

  it("recognizes 'Interco' as intercompany shorthand", () => {
    expect(classifyLineItem("Interco - Rent").category).toBe("intercompany");
  });

  it("does not surface a properly paired intercompany line as orphaned", () => {
    const result = computeGeneric([
      { label: "Management Income", amount: 50_000 },
      { label: "Management Fee", amount: 50_000 },
    ]);
    expect(result.intercompany_observed).toHaveLength(1);
    expect(
      result.unused_labels.some((l) => l.includes("no matching counterpart")),
    ).toBe(false);
  });
});
