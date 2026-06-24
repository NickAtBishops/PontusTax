// Pinnacle Oil & Gas Holdings, Inc. — tracker row 14.
//
// This recipe was reverse-engineered from the formulas already in the Q1-Q4
// 2025 tracker cells (see docs/methodology_pinnacle.md for the full
// walkthrough). It is validated against the Q1 2026 source statement:
// the engine fed these line items must produce {sales: 51700, ebitda: 7461}
// in tracker units (thousands of dollars).
//
// Known issue (not encoded here): the Q1 2025 EBITDA cell in the tracker is
// `=4252.541+430.088`, two pieces instead of the three this recipe uses.
// We assume that quarter bundled or omitted D&A; the question is open with
// Michael Press. The Q1 2026 recipe stays three-piece because that matches
// Q2-Q4 2025.

import type { TenantConfig } from "@/lib/tenant-credit/methodology";
import type { LabelAliases } from "@/lib/tenant-credit/normalization";

export const pinnacleConfig: TenantConfig = {
  tenant_id: "pinnacle",
  tenant_name: "Pinnacle Oil & Gas Holdings, Inc.",
  tracker_row: 14,

  // Sales for Pinnacle is the operating revenue from the convenience-store
  // and fuel business: gas at the pump, items sold inside, and lottery.
  // Other Income (rent income, ATM commissions, management income, etc.)
  // is NOT counted; the historical tracker cells confirm this.
  sales_lines: ["Gasoline Sales", "Inside Sales", "Lottery Sales"],

  // EBITDA reconstruction: start from Net Income (the bottom line of the
  // statement) and add back the non-operating-performance items. For
  // Pinnacle that's Depreciation and Interest. Taxes and Amortization are
  // either zero or already in the operating line on this statement.
  ebitda_base: "Net Income",
  ebitda_addbacks: ["Depreciation Expense", "Interest Paid"],

  // The Q1 2026 statement records Management Income on one side and
  // Management Fee on the other for the same dollar amount. Both pass
  // through Net Income, so EBITDA is unaffected. We still recognize and
  // log the pair so the audit record shows we saw it.
  intercompany_pairs: [["Management Income", "Management Fee"]],

  source_units: "dollars",
  tracker_units: "thousands",
};

// Label aliases for the PDF extractor (Phase 3). The keys are the
// canonical labels the engine config above uses; the values are the
// plausible variants the source PDF might use. Case and whitespace are
// normalized by the matcher, so don't list trivial casing variants here.
//
// The Q1 2026 Pinnacle PDF uses the canonical labels verbatim, so all
// these aliases are forward-looking: a future quarter's statement could
// title the same line "D&A" instead of "Depreciation Expense" and we'd
// rather absorb that here than re-extract or hand-correct.
//
// Anything the extractor returns that doesn't match a canonical or an
// alias passes through unchanged. The engine's unused_labels then
// surfaces it for the analyst in the Phase 4 preview.
export const pinnacleLabelAliases: LabelAliases = {
  "Gasoline Sales": ["Gas Sales", "Fuel Sales", "Gasoline"],
  "Inside Sales": [
    "Merchandise Sales",
    "Convenience Store Sales",
    "Store Sales",
    "Inside Sales (Net)",
  ],
  "Lottery Sales": ["Lottery", "Lottery Sales (Net)", "Lottery Revenue"],
  // Bookkeepers vary on capitalization and on "(Loss)" suffix; the
  // matcher already handles case so we only need the suffix variants.
  "Net Income": ["Net Income (Loss)", "Net Profit", "Net Loss", "Net Earnings"],
  "Depreciation Expense": [
    "Depreciation",
    "Depreciation and Amortization",
    "Depreciation & Amortization",
    "D&A",
    "Total Depreciation",
  ],
  "Interest Paid": ["Interest Expense", "Interest", "Total Interest"],
  // Intercompany pair labels. Pinnacle's PDF uses these verbatim, so
  // these lists exist mostly to absorb plural/punctuation variants.
  "Management Income": ["Management Fee Income", "Management Revenue"],
  "Management Fee": ["Management Fees", "Management Fee Expense"],
};
