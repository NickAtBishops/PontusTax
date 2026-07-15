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
  | "ebitda_direct"
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
  // The line is the statement's own sum of other lines in the same
  // bucket (e.g. QuickBooks "Total Income"). computeGeneric keeps the
  // subtotal and drops its constituents when both appear.
  subtotal?: boolean;
  subtotalPriority?: number;
};

type Rule = {
  // Word-boundary regex matched against the lowercased, whitespace-
  // normalized label.
  pattern: RegExp;
  category: LineCategory;
  reason: string;
  subtotal?: true;
  subtotalPriority?: number;
};

const RULES: Rule[] = [
  // -- HARD EXCLUDES first; the include rules below must not catch them.
  // Intercompany pairs net to zero; logged, never math.
  {
    pattern: /\bintercompany\b|\binter-company\b|\binterco\b/,
    category: "intercompany",
    reason: "label contains 'intercompany' (or its common 'interco' shorthand)",
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
  // Standard top-line revenue total — the sum of every revenue account
  // before COGS/expenses. Must run BEFORE the blanket "total" ignore
  // rule below, since these labels always start with "Total" and would
  // otherwise be discarded as a subtotal, leaving Sales with nothing to
  // match at all on chart-of-accounts statements where every revenue
  // line is "Total <account> · ...". Covers QuickBooks' "Total Income"
  // as well as the "Total Revenue" / "Total Sales" phrasing common
  // outside QuickBooks (e.g. a healthcare P&L that builds up to a
  // "Total Revenue" line from Net Revenue + Grant Revenue + Other
  // Income — without matching that label too, the constituents survive
  // individually via the "net revenue" / loose-income rules below and
  // double-count against the real total; verified against a real
  // Oceans Healthcare statement, 2026-07-14).
  // Marked `subtotal` so that on expanded statements — where the
  // individual revenue lines ALSO classify as sales — computeGeneric
  // keeps only this line instead of doubling the metric.
  {
    pattern: /^total (?:for )?income:?$/,
    category: "sales",
    reason: "authoritative total income for the reporting period",
    subtotal: true,
    subtotalPriority: 30,
  },
  // Plural ("Total Revenues") and "Total Operating Revenues" are the
  // same authoritative top line; before the plural was accepted these
  // fell through to the blanket "total" ignore and Sales was silently
  // rebuilt from constituents (or left empty).
  {
    pattern: /^total (?:for )?(?:operating )?revenues?:?$/,
    category: "sales",
    reason: "authoritative total revenue for the reporting period",
    subtotal: true,
    subtotalPriority: 20,
  },
  {
    pattern: /^total (?:for )?(sales|net sales|net revenues?):?$/,
    category: "sales",
    reason: "sales subtotal nested within broader income totals",
    subtotal: true,
    subtotalPriority: 10,
  },
  // Subtotals: would double-count.
  {
    pattern: /\btotal\b/,
    category: "ignore",
    reason: "subtotal line; would double-count",
  },
  // "Gross Income" (not just "Gross Profit"/"Gross Margin") is a real
  // label on cost-plus P&Ls (e.g. a fuel distributor's gross profit on
  // fuel after cost of fuel) and matched the loose sales catch-all below
  // via the word "income" alone before this covered it — verified
  // against a real GPM Investments statement, 2026-07-14, where it was
  // the ONLY line reaching the sales bucket and understated Sales by
  // roughly three orders of magnitude.
  {
    pattern: /\b(gross|operating) (profit|margin|income)\b/,
    category: "ignore",
    reason: "computed metric (gross profit/margin), not a raw revenue line item",
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
  // "Net Profit" and "Profit/(Loss) for the period" are the standard
  // non-US phrasings of the same bottom line; without them the EBITDA
  // reconstruction silently proceeds from addbacks alone. "Profit
  // before tax" must NOT land here — taxes are added back separately,
  // so a pre-tax line would double them.
  {
    pattern:
      /\bnet (income|earnings|loss|profit)\b|\b(profit|loss)(?: or loss)?(?:\s*\/\s*\(loss\))? for the (period|year|quarter)\b/,
    category: "net_income",
    reason: "starting point of the EBITDA reconstruction",
  },
  {
    pattern: /^adjusted ebitda$|^ebitda$|\bpbitda\b/,
    category: "ebitda_direct",
    reason: "statement-provided EBITDA/PBITDA metric",
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
  // Balance-sheet rent items (deposits/receivables/prepaid) are not a
  // current-period expense; exclude them before the broad rent match
  // below catches them on the word "rent" alone.
  {
    pattern: /\brent (receivable|deposit)\b|\bprepaid rent\b/,
    category: "ignore",
    reason: "balance-sheet rent asset (receivable/deposit/prepaid), not a current-period expense",
  },
  {
    pattern: /\brent smoothing\b|\bstraight[- ]line rent\b|\bdeferred rent\b/,
    category: "ignore",
    reason: "non-cash rent accounting adjustment, not contractual rent expense",
  },
  // Rent expense same shape: feeds EBITDA-neutral (rent is operating, so
  // NOT added back for plain EBITDA), but populates the Rent tracker col.
  // Matches bare "Rent" too, not just "Rent Expense" — real statements
  // very commonly just label the line "Rent" or "Rent - <location>"
  // (verified against a real tenant PDF, 2026-07-14, where the old
  // "rent (expense|paid|cost)" pattern left the Rent column blank
  // despite a real dollar figure on the page). The "rent income"
  // exclusion earlier in this list already runs first, so landlord-side
  // rent income is still safe.
  {
    pattern: /\brent\b|\blease (expense|cost)\b/,
    category: "rent_expense",
    reason: "rent expense (written to Rent col; not an EBITDA addback)",
  },
  {
    pattern: /\bdepreciation\b/,
    category: "ebitda_addback",
    reason: "non-cash; added back for EBITDA",
  },
  {
    pattern: /\bamorti(?:[sz]|\s*)ation\b/,
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

  // Direct costs carry revenue words ("Cost of Sales") but are NOT
  // revenue. Expense magnitudes arrive positive, so letting the sales
  // catch-all match them ADDS cost on top of revenue instead of
  // netting it out — {Revenue 1.5M, Cost of Sales 0.9M} would report
  // Sales of 2.4M. Only statements without an authoritative "Total
  // ..." line are exposed (the subtotal dedup masks it otherwise),
  // which is exactly what makes the error hard to spot.
  {
    pattern: /\bcost of\b|\bcogs\b/,
    category: "ignore",
    reason: "direct cost (COGS-family), not revenue",
  },
  // Contra-revenue: discounts/returns/allowances reduce revenue but are
  // extracted as positive magnitudes; summing them into Sales inflates
  // it. The statement's own Net/Total line already reflects them.
  {
    pattern:
      /\b(sales|revenue) (discounts?|returns?|allowances?)\b|\b(discounts?|returns?) and allowances\b/,
    category: "ignore",
    reason: "contra-revenue line; the statement's net/total line already reflects it",
  },
  // Balance-sheet accrual labels that carry revenue words ("Sales Tax
  // Payable", "Deferred Revenue", "Unearned Revenue", "Accounts
  // Receivable - Trade Sales") are positions, not current-period
  // activity, and must not reach the sales catch-all.
  {
    pattern: /\b(payable|receivable|accrued|prepaid|deferred|unearned)\b/,
    category: "ignore",
    reason: "balance-sheet accrual/position line, not current-period activity",
  },

  // -- Sales (loose include; runs last so excludes get first crack).
  {
    pattern: /\bnet (sales|revenue)\b/,
    category: "sales",
    reason: "explicit net-of-returns top line",
  },
  {
    pattern: /\b(sales|revenue|income|turnover)\b/,
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
      return {
        category: rule.category,
        reason: rule.reason,
        subtotal: rule.subtotal ?? false,
        subtotalPriority: rule.subtotalPriority ?? 0,
      };
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
  const rounded =
    totalTracker < 0 ? -Math.round(-totalTracker) : Math.round(totalTracker);
  const result =
    contributions.length === 0 ? null : Object.is(rounded, -0) ? 0 : rounded;

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

  // Subtotal-vs-constituent dedup. A line matched by a `subtotal` rule
  // (QuickBooks "Total Income") is the statement's own sum of the other
  // lines in its bucket. On chart-of-accounts statements the
  // constituents all carry "Total <account>" labels and get ignored, so
  // the subtotal is the bucket's only line — but on standard expanded
  // statements the constituents survive classification too, and summing
  // both would exactly double the metric. Keep the subtotal (it also
  // survives an extractor that missed a constituent) and drop the rest,
  // logging them so the audit view shows why they didn't contribute.
  const droppedConstituents: string[] = [];
  for (const [category, bucket] of byCategory) {
    const subtotals = bucket.filter(
      (i) => classifications.get(i.label)?.subtotal,
    );
    if (subtotals.length === 0) continue;
    if (subtotals.length > 1) {
      const highestPriority = Math.max(
        ...subtotals.map(
          (item) => classifications.get(item.label)?.subtotalPriority ?? 0,
        ),
      );
      const preferred = subtotals.filter(
        (item) =>
          (classifications.get(item.label)?.subtotalPriority ?? 0) ===
          highestPriority,
      );
      const [first, ...samePriority] = preferred;
      const mismatched = samePriority.filter(
        (item) => Math.abs(item.amount - first.amount) >= 0.01,
      );
      if (mismatched.length > 0) {
        throw new Error(
          `Multiple conflicting subtotal lines classified as ${category}: ` +
            preferred.map((i) => `${i.label}=${i.amount}`).join(", "),
        );
      }
      for (const item of subtotals.filter((item) => item !== first)) {
        const reason = preferred.includes(item)
          ? `duplicate subtotal already represented by ${first.label}`
          : `nested subtotal superseded by ${first.label}`;
        droppedConstituents.push(
          `${item.label} (${reason}; dropped to avoid double-count)`,
        );
      }
      byCategory.set(category, [
        first,
        ...bucket.filter((item) => !classifications.get(item.label)?.subtotal),
      ]);
    }
    const currentBucket = byCategory.get(category) ?? bucket;
    const currentSubtotals = currentBucket.filter(
      (i) => classifications.get(i.label)?.subtotal,
    );
    if (
      currentSubtotals.length === 0 ||
      currentSubtotals.length === currentBucket.length
    ) {
      continue;
    }
    for (const item of currentBucket) {
      if (!classifications.get(item.label)?.subtotal) {
        droppedConstituents.push(
          `${item.label} (already summed into the statement's own subtotal; dropped to avoid double-count)`,
        );
      }
    }
    byCategory.set(category, currentSubtotals);
  }

  const grab = (c: LineCategory) => byCategory.get(c) ?? [];

  // Gross-vs-net: when a statement carries BOTH a gross revenue line
  // and its net counterpart (Gross Sales → discounts → Net Sales),
  // summing the two double-counts revenue. The net line is the
  // authoritative one; drop the gross line(s) and log them. When only
  // a gross line exists it stays — a slightly-gross Sales figure with
  // the discount logged in unused_labels beats an empty cell.
  {
    const salesBucket = grab("sales");
    const hasNetLine = salesBucket.some((i) =>
      /\bnet (sales|revenue)\b/.test(normalize(i.label)),
    );
    if (hasNetLine) {
      const grossLines = salesBucket.filter((i) =>
        /\bgross (sales|revenue|receipts)\b/.test(normalize(i.label)),
      );
      if (grossLines.length > 0) {
        for (const item of grossLines) {
          droppedConstituents.push(
            `${item.label} (gross revenue line; the statement's net line ` +
              "already reflects it — dropped to avoid double-count)",
          );
        }
        byCategory.set(
          "sales",
          salesBucket.filter((i) => !grossLines.includes(i)),
        );
      }
    }
  }

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
  const directEbitda = grab("ebitda_direct");
  if (directEbitda.length > 1) {
    const [first, ...rest] = directEbitda;
    if (rest.some((item) => Math.abs(item.amount - first.amount) >= 0.01)) {
      throw new Error(
        "Multiple direct EBITDA/PBITDA figures disagree: " +
          directEbitda.map((item) => `${item.label}=${item.amount}`).join(", "),
      );
    }
    for (const item of rest) {
      droppedConstituents.push(
        `${item.label} (duplicate direct EBITDA already represented by ${first.label})`,
      );
    }
  }
  const selectedDirectEbitda = directEbitda.slice(0, 1);
  // The reconstruction is only meaningful anchored on the statement's
  // bottom line. Addbacks/interest with NO Net Income/Net Profit line
  // (e.g. a bottom line phrased in a way no rule matched) would
  // otherwise produce a small, plausible-looking, badly wrong EBITDA —
  // leave the cell blank and say why instead.
  const bottomLineMissing =
    selectedDirectEbitda.length === 0 &&
    grab("net_income").length === 0 &&
    (grab("ebitda_addback").length > 0 || grab("interest_expense").length > 0);
  if (bottomLineMissing) {
    for (const item of [...grab("ebitda_addback"), ...grab("interest_expense")]) {
      droppedConstituents.push(
        `${item.label} (EBITDA addback found, but no bottom-line Net ` +
          "Income/Net Profit line was recognized — EBITDA left blank " +
          "rather than reconstructed from addbacks alone)",
      );
    }
  }
  const ebitdaContribs: { item: LineItem; sign: 1 | -1 }[] = bottomLineMissing
    ? []
    : selectedDirectEbitda.length > 0
      ? selectedDirectEbitda.map((item) => ({ item, sign: 1 as const }))
      : [
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
    grab("capex").map((item) => ({
      item: { ...item, amount: Math.abs(item.amount) },
      sign: 1,
    })),
  );

  const intercompany_observed = findIntercompanyPairs(items, classifications);

  // Every intercompany line that DIDN'T land in a pair above is excluded
  // from every metric (correctly — intercompany items never feed Sales/
  // EBITDA/etc) but was, until now, invisible: its category isn't
  // "ignore" so it never showed up below, and with no counterpart it
  // never showed up in intercompany_observed either. Surface it
  // explicitly so the analyst can see the line existed and was
  // deliberately excluded, rather than silently disappearing.
  const pairedLabels = new Set<string>();
  for (const obs of intercompany_observed) {
    pairedLabels.add(obs.income_label);
    pairedLabels.add(obs.expense_label);
  }
  const orphanedIntercompany = items
    .filter(
      (i) =>
        classifications.get(i.label)?.category === "intercompany" &&
        !pairedLabels.has(i.label),
    )
    .map(
      (i) =>
        `${i.label} (intercompany line; excluded from every metric — no matching counterpart found to log as a pair)`,
    );

  const unused_labels = [
    ...items
      .filter((i) => classifications.get(i.label)?.category === "ignore")
      .map((i) => `${i.label} (${classifications.get(i.label)?.reason})`),
    ...droppedConstituents,
    ...orphanedIntercompany,
  ];

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
