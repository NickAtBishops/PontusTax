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

  it("does not double-count duplicate subtotal labels with the same amount", () => {
    const result = computeGeneric([
      { label: "Total Income", amount: 800_000 },
      { label: "Total for Income", amount: 800_000 },
    ]);
    expect(result.sales).toBe(800);
    expect(result.metrics.sales.contributions).toHaveLength(1);
    expect(result.unused_labels.some((l) => l.includes("duplicate subtotal"))).toBe(
      true,
    );
  });

  it("prefers Total Income over a nested Total Sales subtotal", () => {
    const result = computeGeneric([
      { label: "Total Sales", amount: 750_000 },
      { label: "Total Income", amount: 800_000 },
    ]);
    expect(result.sales).toBe(800);
    expect(result.metrics.sales.contributions[0].label).toBe("Total Income");
    expect(result.unused_labels.some((label) => label.includes("nested subtotal"))).toBe(
      true,
    );
  });

  it("fails loudly when same-priority income subtotals disagree", () => {
    expect(() =>
      computeGeneric([
        { label: "Total Income", amount: 800_000 },
        { label: "Total for Income", amount: 810_000 },
      ]),
    ).toThrow(/Multiple conflicting subtotal lines/);
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

  it("logs paired management fees without adding either leg to EBITDA", () => {
    const result = computeGeneric([
      { label: "Net Income", amount: 100_000 },
      { label: "Management Income", amount: 50_000 },
      { label: "Management Fee", amount: 50_000 },
    ]);
    expect(result.ebitda).toBe(100);
    expect(result.intercompany_observed).toHaveLength(1);
    expect(result.metrics.ebitda.contributions.map((item) => item.label)).toEqual([
      "Net Income",
    ]);
  });
});

describe("non-standard but common financial labels", () => {
  it("classifies Turnover as sales", () => {
    const result = computeGeneric([{ label: "Turnover", amount: 1_200_000 }]);
    expect(result.sales).toBe(1_200);
  });

  it("uses a statement-provided PBITDA line as EBITDA", () => {
    const result = computeGeneric([{ label: "PBITDA", amount: 300_000 }]);
    expect(result.ebitda).toBe(300);
    expect(result.metrics.ebitda.contributions[0].label).toBe("PBITDA");
  });
});

describe("unmatched label surfacing", () => {
  it("puts no-rule-matched labels in unused_labels", () => {
    const result = computeGeneric([{ label: "Payroll Expenses", amount: 120_000 }]);
    expect(result.unused_labels).toEqual([
      "Payroll Expenses (no rule matched; assumed non-revenue)",
    ]);
  });
});

describe("economic signs and rounding", () => {
  it("keeps a Net Loss negative when reconstructing EBITDA", () => {
    const result = computeGeneric([
      { label: "Net Loss", amount: -1_500_000 },
      { label: "Depreciation Expense", amount: 200_000 },
      { label: "Interest Expense", amount: 100_000 },
    ]);
    expect(result.ebitda).toBe(-1_200);
  });

  it("rounds negative half-thousands away from zero", () => {
    expect(computeGeneric([{ label: "Net Loss", amount: -1_500 }]).ebitda).toBe(
      -2,
    );
  });

  it("stores cash-flow capex as a positive magnitude", () => {
    const result = computeGeneric([
      { label: "Purchases of property and equipment", amount: -250_000 },
    ]);
    expect(result.capex).toBe(250);
  });

  it("rejects disagreeing direct EBITDA figures instead of summing them", () => {
    expect(() =>
      computeGeneric([
        { label: "EBITDA", amount: 300_000 },
        { label: "PBITDA", amount: 325_000 },
      ]),
    ).toThrow(/direct EBITDA\/PBITDA figures disagree/);
  });
});

describe("Pinnacle Q1 2026 tracker regression", () => {
  it("uses Total Income rather than the nested Total Sales subtotal", () => {
    const result = computeGeneric([
      { label: "Total for Sales", amount: 51_700_008.54 },
      { label: "Total for Income", amount: 59_784_204.82 },
      { label: "Net Income", amount: 5_258_230.36 },
      { label: "Depreciation Expense", amount: 821_457.93 },
      { label: "Interest Paid", amount: 1_381_082.34 },
      { label: "Rent", amount: 9_905_979.21 },
      { label: "Management Income", amount: 355_360 },
      { label: "Management Fee", amount: 355_360 },
    ]);
    expect(result.sales).toBe(59_784);
    expect(result.ebitda).toBe(7_461);
    expect(result.interest).toBe(1_381);
    expect(result.rent).toBe(9_906);
  });
});

describe("Ethema/Evernia Q1 2026 tracker regression", () => {
  it("handles split-word amortization and excludes rent smoothing", () => {
    const result = computeGeneric([
      { label: "Total Income", amount: 1_365_000 },
      { label: "Net Income", amount: -617_618.71 },
      { label: "Depreciation", amount: 35_025.39 },
      { label: "Discount Amorti ation", amount: 38_468.95 },
      { label: "Interest Expense", amount: 28_478.93 },
      { label: "Rent - Boca cove", amount: 94_423.47 },
      { label: "Rent - Other buildings", amount: 18_000 },
      { label: "Rent Smoothing", amount: -948.81 },
      { label: "Interco - Rent", amount: 229_227.45 },
    ]);
    expect(result.sales).toBe(1_365);
    expect(result.ebitda).toBe(-516);
    expect(result.interest).toBe(28);
    expect(result.rent).toBe(112);
    expect(result.unused_labels.some((label) => label.includes("Rent Smoothing"))).toBe(
      true,
    );
  });
});

// Regression coverage (2026-07-14 deep review): labels that carry
// revenue words but are NOT revenue used to reach the sales catch-all.
// Because expense magnitudes arrive positive, "Cost of Sales" was
// ADDED to Sales — {Revenue 1.5M, COGS 0.9M} reported Sales of 2.4M
// whenever no authoritative "Total ..." subtotal existed to mask it.
describe("cost and contra-revenue labels are not revenue", () => {
  it("ignores COGS-family labels", () => {
    expect(classifyLineItem("Cost of Sales").category).toBe("ignore");
    expect(classifyLineItem("Cost of Goods Sold").category).toBe("ignore");
    expect(classifyLineItem("COGS").category).toBe("ignore");
    expect(classifyLineItem("Cost of Revenue").category).toBe("ignore");
  });

  it("ignores contra-revenue labels", () => {
    expect(classifyLineItem("Sales Discounts").category).toBe("ignore");
    expect(classifyLineItem("Sales Returns and Allowances").category).toBe(
      "ignore",
    );
    expect(classifyLineItem("Revenue Discounts").category).toBe("ignore");
  });

  it("ignores balance-sheet accrual labels that carry revenue words", () => {
    expect(classifyLineItem("Sales Tax Payable").category).toBe("ignore");
    expect(classifyLineItem("Deferred Revenue").category).toBe("ignore");
    expect(classifyLineItem("Unearned Revenue").category).toBe("ignore");
    expect(classifyLineItem("Accounts Receivable").category).toBe("ignore");
  });

  it("does not add Cost of Sales into the Sales metric", () => {
    const result = computeGeneric([
      { label: "Product Revenue", amount: 1_000_000 },
      { label: "Service Revenue", amount: 500_000 },
      { label: "Cost of Sales", amount: 900_000 },
    ]);
    expect(result.sales).toBe(1_500);
    expect(
      result.unused_labels.some((label) => label.includes("Cost of Sales")),
    ).toBe(true);
  });

  it("drops a gross revenue line when the statement's net line is present", () => {
    const result = computeGeneric([
      { label: "Gross Sales", amount: 100_000 },
      { label: "Sales Discounts", amount: 2_000 },
      { label: "Net Sales", amount: 98_000 },
    ]);
    expect(result.sales).toBe(98);
    expect(
      result.unused_labels.some((label) => label.includes("Gross Sales")),
    ).toBe(true);
  });

  it("keeps a gross revenue line when it is the only revenue line", () => {
    const result = computeGeneric([
      { label: "Gross Sales", amount: 100_000 },
      { label: "Payroll", amount: 40_000 },
    ]);
    expect(result.sales).toBe(100);
  });
});

// Regression coverage (2026-07-14 deep review): "Net Profit" (and
// "Profit for the period") are the standard non-US bottom-line
// phrasings. They fell through to "ignore", so EBITDA was silently
// reconstructed from addbacks alone — {Net Profit 100k, D&A 50k}
// wrote EBITDA 50 instead of 150.
describe("non-US bottom-line phrasings feed EBITDA", () => {
  it("classifies Net Profit variants as the bottom line", () => {
    expect(classifyLineItem("Net Profit").category).toBe("net_income");
    expect(classifyLineItem("Net Profit/(Loss)").category).toBe("net_income");
    expect(classifyLineItem("Profit for the period").category).toBe(
      "net_income",
    );
    expect(classifyLineItem("Profit for the year").category).toBe("net_income");
  });

  it("does not treat pre-tax profit as the bottom line", () => {
    expect(classifyLineItem("Profit before tax").category).not.toBe(
      "net_income",
    );
  });

  it("reconstructs EBITDA from a Net Profit bottom line", () => {
    const result = computeGeneric([
      { label: "Net Profit", amount: 100_000 },
      { label: "Depreciation", amount: 50_000 },
    ]);
    expect(result.ebitda).toBe(150);
  });

  it("leaves EBITDA blank when addbacks exist but no bottom line was recognized", () => {
    const result = computeGeneric([
      { label: "Bottom line phrased unrecognizably", amount: 100_000 },
      { label: "Depreciation", amount: 50_000 },
      { label: "Interest Expense", amount: 20_000 },
    ]);
    expect(result.ebitda).toBeNull();
    // Interest still feeds its own tracker column.
    expect(result.interest).toBe(20);
    expect(
      result.unused_labels.some((label) => label.includes("EBITDA left blank")),
    ).toBe(true);
  });
});

// Regression coverage (2026-07-14 deep review): plural and prefixed
// top-line totals ("Total Revenues", "Total Operating Revenues") hit
// the blanket "total" ignore rule, so Sales was silently rebuilt from
// constituents — or left empty on chart-of-accounts statements.
describe("plural top-line totals are subtotals", () => {
  it("classifies plural and operating revenue totals as sales subtotals", () => {
    for (const label of [
      "Total Revenues",
      "Total Operating Revenues",
      "Total Net Revenues",
    ]) {
      const decision = classifyLineItem(label);
      expect(decision.category).toBe("sales");
      expect(decision.subtotal).toBe(true);
    }
  });

  it("prefers Total Revenues over its constituents", () => {
    const result = computeGeneric([
      { label: "PHP Revenue", amount: 137_767 },
      { label: "Net Revenue", amount: 6_052_222 },
      { label: "Total Revenues", amount: 6_169_482 },
    ]);
    expect(result.sales).toBe(6_169);
    expect(result.metrics.sales.contributions).toHaveLength(1);
  });
});
