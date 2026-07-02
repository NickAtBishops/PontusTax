// Generic methodology engine. Pure functions, no I/O.
//
// Classifies each line item from the source PDF via keyword rules and
// computes seven tracker metrics — Sales, EBITDA, Interest, Rent,
// Cash, CFO, Capex — from whatever it found. The remaining tracker
// columns (EBITDA Margin, EBITDAR, Total Debt, FCF, FCCR, leverage)
// are tracker formulas that recompute themselves once these seven
// land in their cells, so the engine never produces them directly.
//
// What this engine deliberately does NOT do:
//   - Read PDFs. The extract route still does that via Claude.
//   - Touch the xlsx. The writeback route still does that.
//   - Pretend to be authoritative. The patterns cover the common case;
//     the analyst has to audit every run and tell us when a line was
//     mis-categorized so we can refine the rules.

import type { LineItem } from "@/lib/tenant-credit/methodology";

// Buckets a single line can fall into. Each one drives at most one
// tracker cell, except "ebitda_addback" which feeds the EBITDA
// reconstruction alongside "net_income". "ignore" is intentional and
// surfaces in the audit trace with a reason.
export type LineCategory =
  | "sales"
  | "net_income"
  | "ebitda_addback"
  | "interest_expense"
  | "rent_expense"
  | "cash"
  | "cfo"
  | "capex"
  | "intercompany"
  | "ignore";

export type CategoryDecision = {
  category: LineCategory;
  reason: string;
};

type Rule = {
  // Word-boundary regex matched against the lowercased, whitespace-
  // normalized label.
  pattern: RegExp;
  category: LineCategory;
  reason: string;
};

const RULES: Rule[] = [
  // -- HARD EXCLUDES first; the include rules below must not catch them.
  // Intercompany pairs net to zero; logged, never math.
  {
    pattern: /\bintercompany\b|\binter-company\b/,
    category: "intercompany",
    reason: "label contains 'intercompany'",
  },
  {
    pattern: /\bmanagement (income|fee|fees)\b/,
    category: "intercompany",
    reason: "common intercompany pair (management income/fee)",
  },

  // Rent INCOME (landlord side) is non-operating for tenants.
  {
    pattern: /\b(rent|rental|lease) income\b/,
    category: "ignore",
    reason: "rent income is non-operating for this credit tracker",
  },
  // Non-operating income lines.
  {
    pattern: /\binterest income\b|\binvestment income\b|\bdividend income\b/,
    category: "ignore",
    reason: "non-operating income (interest/investment/dividend)",
  },
  {
    pattern: /\bother income\b/,
    category: "ignore",
    reason: "'Other income' is typically non-operating; audit before including",
  },
  // QuickBooks-style EBIT-level subtotal ("Net Ordinary Income" /
  // "Ordinary Income"), sitting ABOVE Other Income/Expense and thus
  // above the statement's true bottom line. Must be excluded before
  // the generic sales catch-all below, which would otherwise match it
  // on the word "Income" and misreport it as revenue — the exact bug
  // that put Ethema's -$551K EBIT in the Sales column instead of its
  // real $1,365K revenue (2026-07-02). Deliberately NOT routed to
  // net_income either: the true bottom-line "Net Income" line already
  // feeds EBITDA correctly, and adding this one too would double it.
  {
    pattern: /\b(net )?ordinary income\b/,
    category: "ignore",
    reason: "EBIT-level subtotal (operating income before non-operating items), not top-line revenue",
  },
  // Standard QuickBooks top-line revenue total — the sum of every
  // revenue account before COGS/expenses. Must run BEFORE the blanket
  // "total" ignore rule below, since this exact label always starts
  // with "Total" and would otherwise be discarded as a subtotal,
  // leaving Sales with nothing to match at all on chart-of-accounts
  // statements where every revenue line is "Total <account> · ...".
  {
    pattern: /^total income$/,
    category: "sales",
    reason: "QuickBooks top-line revenue total (sum of all revenue accounts)",
  },
  // Subtotals: would double-count.
  {
    pattern: /\btotal\b/,
    category: "ignore",
    reason: "subtotal line; would double-count",
  },
  {
    pattern: /\b(gross|operating) (profit|margin)\b/,
    category: "ignore",
    reason: "computed metric, not a raw line item",
  },

  // -- Balance sheet: CASH ---------------------------------------------
  {
    pattern: /\bcash and (cash )?equivalents?\b/,
    category: "cash",
    reason: "balance-sheet cash & equivalents",
  },
  {
    pattern: /^cash$|\bcash on hand\b|\bcash balance\b/,
    category: "cash",
    reason: "balance-sheet cash",
  },

  // -- Cash flow statement: CFO + Capex --------------------------------
  // Capex must come BEFORE the broader CFO pattern, since "purchases of
  // property" appears inside cash-flow-from-investing lines that some
  // statements label "cash used in investing" — we want the capex bucket.
  {
    pattern: /\bcapital expenditures?\b|\bcapex\b/,
    category: "capex",
    reason: "capital expenditure line",
  },
  {
    pattern: /\bpurchases? of (property|equipment|plant)/,
    category: "capex",
    reason: "capex (purchase of fixed assets)",
  },
  {
    pattern:
      /\b(net )?cash (provided by|from|used in) operating activities\b|\boperating cash flow\b|\bcash from operations\b/,
    category: "cfo",
    reason: "cash flow from operations",
  },

  // -- Income statement bottom-line + EBITDA addbacks ------------------
  {
    pattern: /\bnet (income|earnings|loss)\b/,
    category: "net_income",
    reason: "starting point of the EBITDA reconstruction",
  },
  // Interest expense double-duties: it goes into the EBITDA addback
  // bucket AND into the Interest tracker column. We pick the more
  // specific bucket here and let the compute function copy the sum
  // into both metrics.
  {
    pattern: /\binterest (expense|paid|cost)\b|^interest$/,
    category: "interest_expense",
    reason: "interest expense (added back for EBITDA; written to Interest col)",
  },
  // Rent expense same shape: feeds EBITDA-neutral (rent is operating, so
  // NOT added back for plain EBITDA), but populates the Rent tracker col.
  {
    pattern: /\brent (expense|paid|cost)\b|\blease (expense|cost)\b/,
    category: "rent_expense",
    reason: "rent expense (written to Rent col; not an EBITDA addback)",
  },
  {
    pattern: /\bdepreciation\b/,
    category: "ebitda_addback",
    reason: "non-cash; added back for EBITDA",
  },
  {
    pattern: /\bamortization\b/,
    category: "ebitda_addback",
    reason: "non-cash; added back for EBITDA",
  },
  {
    pattern: /\bd\s*&\s*a\b/,
    category: "ebitda_addback",
    reason: "combined depreciation & amortization; added back for EBITDA",
  },
  {
    pattern: /\b(income tax|tax expense|provision for tax)/,
    category: "ebitda_addback",
    reason: "income taxes; added back for EBITDA",
  },

  // -- Sales (loose include; runs last so excludes get first crack).
  {
    pattern: /\bnet (sales|revenue)\b/,
    category: "sales",
    reason: "explicit net-of-returns top line",
  },
  {
    pattern: /\b(sales|revenue|income)\b/,
    category: "sales",
    reason: "label looks like operating revenue",
  },

  // Anything else (COGS, labor, SG&A) falls through to "ignore".
];

function normalize(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export function classifyLineItem(label: string): CategoryDecision {
  const norm = normalize(label);
  for (const rule of RULES) {
    if (rule.pattern.test(norm)) {
      return { category: rule.category, reason: rule.reason };
    }
  }
  return { category: "ignore", reason: "no rule matched; assumed non-revenue" };
}

// One contributing line in a metric trace. Both raw and tracker-units
// amounts are recorded so the audit log can show both views.
export type MetricContribution = {
  label: string;
  amount_source: number;
  amount_tracker: number;
  reason: string;
};

// One metric's full trace. result is the integer the writer will put
// into the cell; contributions is the audit list. null result means
// the PDF didn't carry anything we could classify into this bucket;
// the writer leaves the cell empty for the analyst to fill in by hand.
export type MetricTrace = {
  metric:
    | "sales" | "ebitda" | "interest" | "rent"
    | "cash" | "cfo" | "capex";
  formula: string;
  contributions: MetricContribution[];
  total_tracker_unrounded: number;
  result_tracker: number | null;
};

export type IntercompanyObservation = {
  income_label: string;
  expense_label: string;
  income_amount_source: number;
  expense_amount_source: number;
  amounts_match: boolean;
};

// What the engine returns. The seven metrics live in `metrics` keyed by
// MetricKey so the writer can iterate them in WRITABLE_METRICS order
// without branching per metric. Convenience scalars (`sales`, `ebitda`,
// ...) duplicate the same numbers for code paths that just want one
// value (e.g. the results table in the UI).
export type ComputeResult = {
  sales: number | null;
  ebitda: number | null;
  interest: number | null;
  rent: number | null;
  cash: number | null;
  cfo: number | null;
  capex: number | null;
  metrics: Record<MetricTrace["metric"], MetricTrace>;
  intercompany_observed: IntercompanyObservation[];
  // Lines the classifier dropped, with the reason. The dashboard shows
  // these so the analyst can spot a mis-categorization (e.g. a new
  // revenue line we didn't match).
  unused_labels: string[];
};

function findIntercompanyPairs(
  items: LineItem[],
  classifications: Map<string, CategoryDecision>,
): IntercompanyObservation[] {
  const ic = items.filter(
    (i) => classifications.get(i.label)?.category === "intercompany",
  );
  if (ic.length === 0) return [];

  const incomeLegs = ic.filter((i) => /\bincome\b/.test(normalize(i.label)));
  const expenseLegs = ic.filter((i) => !/\bincome\b/.test(normalize(i.label)));

  const observed: IntercompanyObservation[] = [];
  const matched = new Set<string>();
  for (const income of incomeLegs) {
    let best: { expense: LineItem; diff: number } | null = null;
    for (const expense of expenseLegs) {
      if (matched.has(expense.label)) continue;
      const diff = Math.abs(
        Math.abs(income.amount) - Math.abs(expense.amount),
      );
      if (best === null || diff < best.diff) best = { expense, diff };
    }
    if (best === null) continue;
    matched.add(best.expense.label);
    observed.push({
      income_label: income.label,
      expense_label: best.expense.label,
      income_amount_source: income.amount,
      expense_amount_source: best.expense.amount,
      amounts_match: best.diff < 0.01,
    });
  }
  return observed;
}

// Build one metric's trace from the line items classified into a given
// bucket. `formulaLabel` controls how the audit string reads, e.g.
// "Net Income + Depreciation Expense + Interest Paid" for EBITDA.
function traceFor(
  metric: MetricTrace["metric"],
  items: LineItem[],
  classifications: Map<string, CategoryDecision>,
  contributions: { item: LineItem; sign: 1 | -1 }[],
): MetricTrace {
  const _ = [items, classifications]; // keep signature symmetrical
  void _;

  const trace: MetricContribution[] = contributions.map(({ item }) => {
    const decision = classifications.get(item.label);
    return {
      label: item.label,
      amount_source: item.amount,
      amount_tracker: item.amount / 1000,
      reason: decision?.reason ?? "matched",
    };
  });

  const formula =
    contributions.length === 0
      ? "no matching lines found in the PDF"
      : contributions
          .map((c, i) =>
            i === 0
              ? c.item.label
              : c.sign > 0
                ? `+ ${c.item.label}`
                : `- ${c.item.label}`,
          )
          .join(" ");

  const totalSource = contributions.reduce(
    (acc, c) => acc + c.sign * c.item.amount,
    0,
  );
  const totalTracker = totalSource / 1000;
  // A null result tells the writer "no source data — leave the cell
  // alone". Zero is a real value (e.g. paid off all debt) and gets
  // written.
  const result = contributions.length === 0 ? null : Math.round(totalTracker);

  return {
    metric,
    formula,
    contributions: trace,
    total_tracker_unrounded: totalTracker,
    result_tracker: result,
  };
}

export function computeGeneric(items: LineItem[]): ComputeResult {
  const classifications = new Map<string, CategoryDecision>();
  for (const item of items) {
    classifications.set(item.label, classifyLineItem(item.label));
  }

  // Bucket every input by category for easy access below.
  const byCategory = new Map<LineCategory, LineItem[]>();
  for (const item of items) {
    const c = classifications.get(item.label)!.category;
    const bucket = byCategory.get(c) ?? [];
    bucket.push(item);
    byCategory.set(c, bucket);
  }
  const grab = (c: LineCategory) => byCategory.get(c) ?? [];

  // Sales: every operating-revenue line, summed.
  const salesTrace = traceFor(
    "sales",
    items,
    classifications,
    grab("sales").map((item) => ({ item, sign: 1 })),
  );

  // EBITDA reconstruction: Net Income + addbacks + interest expense
  // (interest is always added back for EBITDA, regardless of whether it
  // also feeds the Interest tracker column).
  const ebitdaContribs: { item: LineItem; sign: 1 | -1 }[] = [
    ...grab("net_income").map((item) => ({ item, sign: 1 as const })),
    ...grab("ebitda_addback").map((item) => ({ item, sign: 1 as const })),
    ...grab("interest_expense").map((item) => ({ item, sign: 1 as const })),
  ];
  const ebitdaTrace = traceFor(
    "ebitda",
    items,
    classifications,
    ebitdaContribs,
  );

  // Interest tracker column: the interest-expense lines themselves.
  const interestTrace = traceFor(
    "interest",
    items,
    classifications,
    grab("interest_expense").map((item) => ({ item, sign: 1 })),
  );

  // Rent tracker column: rent expense (tenant pays it). NOT an EBITDA
  // addback because rent is operating; subtracting it would inflate
  // EBITDA artificially.
  const rentTrace = traceFor(
    "rent",
    items,
    classifications,
    grab("rent_expense").map((item) => ({ item, sign: 1 })),
  );

  // Balance-sheet and cash-flow metrics: each is just the sum of
  // whatever lines the classifier matched into the bucket.
  const cashTrace = traceFor(
    "cash",
    items,
    classifications,
    grab("cash").map((item) => ({ item, sign: 1 })),
  );
  const cfoTrace = traceFor(
    "cfo",
    items,
    classifications,
    grab("cfo").map((item) => ({ item, sign: 1 })),
  );
  // Capex amounts on cash-flow statements appear as outflows (negative
  // values or labelled as such). The extractor reports magnitudes, and
  // the tracker convention stores Capex as a positive magnitude too.
  // No sign flip needed; we just sum.
  const capexTrace = traceFor(
    "capex",
    items,
    classifications,
    grab("capex").map((item) => ({ item, sign: 1 })),
  );

  const intercompany_observed = findIntercompanyPairs(items, classifications);

  const unused_labels = items
    .filter((i) => classifications.get(i.label)?.category === "ignore")
    .map((i) => `${i.label} (${classifications.get(i.label)?.reason})`);

  return {
    sales: salesTrace.result_tracker,
    ebitda: ebitdaTrace.result_tracker,
    interest: interestTrace.result_tracker,
    rent: rentTrace.result_tracker,
    cash: cashTrace.result_tracker,
    cfo: cfoTrace.result_tracker,
    capex: capexTrace.result_tracker,
    metrics: {
      sales: salesTrace,
      ebitda: ebitdaTrace,
      interest: interestTrace,
      rent: rentTrace,
      cash: cashTrace,
      cfo: cfoTrace,
      capex: capexTrace,
    },
    intercompany_observed,
    unused_labels,
  };
}
