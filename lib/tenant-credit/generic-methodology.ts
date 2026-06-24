// Generic methodology engine. Pure functions, no I/O.
//
// The per-tenant "recipe" model (lib/tenant-credit/methodology.ts) is
// accurate but bottlenecked on having to hand-write a config per tenant.
// This module gives up that accuracy in exchange for working out of the
// box for every tenant: it classifies each line item from the PDF via
// keyword rules and computes Sales + EBITDA from whatever it found.
//
// What this engine deliberately does NOT do:
//   - Read PDFs. The extract route still does that via Claude.
//   - Touch the xlsx. The writeback route still does that.
//   - Pretend to be authoritative. The patterns below cover the common
//     case; the analyst has to audit every run and tell us when a line
//     was miscategorized so we can refine the rules.
//
// The output shape mirrors lib/tenant-credit/methodology.ts ComputeResult
// one-for-one so callers (audit log, dashboard cards, writeback) don't
// have to branch on which engine produced the result.

import type {
  CalculationInput,
  CalculationTrace,
  ComputeResult,
  IntercompanyObservation,
  LineItem,
} from "@/lib/tenant-credit/methodology";

// The four buckets a line can fall into. "ignore" is intentionally
// explicit so the audit trace shows the analyst we saw the line and
// chose not to use it (rather than silently dropping it).
export type LineCategory =
  | "sales"
  | "net_income"
  | "ebitda_addback"
  | "intercompany"
  | "ignore";

// What was matched, and why. Surfaced in the calculation trace so the
// analyst can audit a single line: "this came in as a Sale because its
// label contains 'sales'".
export type CategoryDecision = {
  category: LineCategory;
  reason: string;
};

// Pattern → category, evaluated in order. Earlier rules win, which
// matters because "rent income" must match the EXCLUDE rule for Sales
// before the generic INCLUDE rule for "income". Each pattern matches
// the lowercased, whitespace-normalized label.
//
// Adjusting these rules is the main maintenance lever. When the analyst
// finds a mis-categorized line, add a rule above the looser ones.
type Rule = {
  // Word-boundary regex matched against the normalized label.
  pattern: RegExp;
  category: LineCategory;
  reason: string;
};

const RULES: Rule[] = [
  // -- HARD EXCLUDES (must come before any include rule that would catch them)
  // Intercompany pairs net to zero; we log them but neither side
  // contributes to Sales or EBITDA.
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

  // Rent is non-operating for tenants (they pay it, the landlord
  // collects it). The credit tracker is tenant-side, so rent income
  // doesn't belong in Sales.
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

  // Subtotal lines we never want to double-count.
  {
    pattern: /\btotal\b/,
    category: "ignore",
    reason: "subtotal line; would double-count operating revenue",
  },
  {
    pattern: /\b(gross|operating) (profit|margin)\b/,
    category: "ignore",
    reason: "computed metric, not a raw line item",
  },
  {
    pattern: /\bnet (sales|revenue)\b/,
    category: "sales",
    reason: "explicit net-of-returns top line",
  },

  // -- EBITDA components (must come before the loose Sales include
  // because "depreciation" could otherwise look like nothing useful and
  // the catch-all wouldn't grab it).
  {
    pattern: /\bnet (income|earnings|loss)\b/,
    category: "net_income",
    reason: "the EBITDA reconstruction starts here",
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
    pattern: /\bd\s*&\s*a\b/,  // "D&A" or "D & A"
    category: "ebitda_addback",
    reason: "combined depreciation & amortization; added back for EBITDA",
  },
  {
    pattern: /\binterest (expense|paid|cost)\b|\binterest$/,
    category: "ebitda_addback",
    reason: "financing cost; added back for EBITDA",
  },
  {
    pattern: /\b(income tax|tax expense|provision for tax)/,
    category: "ebitda_addback",
    reason: "income taxes; added back for EBITDA",
  },

  // -- SALES (operating revenue). Loose include comes last so the
  // excludes above get first crack.
  {
    pattern: /\b(sales|revenue|income)\b/,
    category: "sales",
    reason: "label looks like operating revenue",
  },

  // Anything else (expenses, fees, COGS, etc.) is intentionally
  // unmatched; falls through to the default "ignore".
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

// Pair intercompany lines (income leg + expense leg) when both sides
// appear in the input and have matching magnitudes. We don't insist on
// the labels being a known pair; the rule "two intercompany lines with
// the same absolute amount" matches the common Management Income /
// Management Fee shape and most lookalikes.
function findIntercompanyPairs(
  items: LineItem[],
  classifications: Map<string, CategoryDecision>,
): IntercompanyObservation[] {
  const intercompany = items.filter(
    (i) => classifications.get(i.label)?.category === "intercompany",
  );
  if (intercompany.length === 0) return [];

  // Heuristic split: lines whose labels contain "income" are the income
  // leg, the rest are expense legs. Some files reverse this convention
  // but the pairing logic below tolerates either order.
  const incomeLegs = intercompany.filter((i) =>
    /\bincome\b/.test(normalize(i.label)),
  );
  const expenseLegs = intercompany.filter(
    (i) => !/\bincome\b/.test(normalize(i.label)),
  );

  const observations: IntercompanyObservation[] = [];
  const matched = new Set<string>();
  for (const income of incomeLegs) {
    // Pair with the unmatched expense leg whose absolute amount is
    // closest to the income leg's. Cent-level tolerance.
    let best: { expense: LineItem; diff: number } | null = null;
    for (const expense of expenseLegs) {
      if (matched.has(expense.label)) continue;
      const diff = Math.abs(
        Math.abs(income.amount) - Math.abs(expense.amount),
      );
      if (best === null || diff < best.diff) {
        best = { expense, diff };
      }
    }
    if (best === null) continue;
    matched.add(best.expense.label);
    observations.push({
      income_label: income.label,
      expense_label: best.expense.label,
      income_amount_source: income.amount,
      expense_amount_source: best.expense.amount,
      amounts_match: best.diff < 0.01,
      net_effect_on_ebitda_source: 0,
    });
  }
  return observations;
}

function toCalcInput(item: LineItem): CalculationInput {
  return {
    label: item.label,
    amount_source: item.amount,
    // Tracker is in $000s. Round-to-tracker happens once, at the end;
    // here we just record the raw value in tracker units for the trace.
    amount_tracker: item.amount / 1000,
  };
}

export type GenericComputeOptions = {
  // When true, throw on any sign weirdness (e.g. negative Sales) instead
  // of returning a result the analyst might miss. Defaults to false so
  // loss-making tenants still get a result.
  strictSigns?: boolean;
};

export function computeGeneric(
  items: LineItem[],
  options: GenericComputeOptions = {},
): ComputeResult {
  // Bucket every line item once so the trace is consistent.
  const classifications = new Map<string, CategoryDecision>();
  for (const item of items) {
    classifications.set(item.label, classifyLineItem(item.label));
  }

  const salesItems = items.filter(
    (i) => classifications.get(i.label)?.category === "sales",
  );
  const netIncomeItems = items.filter(
    (i) => classifications.get(i.label)?.category === "net_income",
  );
  const addbackItems = items.filter(
    (i) => classifications.get(i.label)?.category === "ebitda_addback",
  );

  // SALES = sum of every line bucketed as "sales".
  const salesInputs = salesItems.map(toCalcInput);
  const salesSourceTotal = salesInputs.reduce(
    (acc, i) => acc + i.amount_source,
    0,
  );
  const salesTrackerUnrounded = salesSourceTotal / 1000;
  const salesResult = Math.round(salesTrackerUnrounded);

  if (options.strictSigns && salesResult < 0) {
    throw new Error(
      `Computed Sales (${salesResult}) is negative; check the source ` +
        "PDF — Sales should be positive on a healthy operating quarter.",
    );
  }

  // EBITDA = Net Income + sum of addback lines. Net Income carries its
  // own sign (negative for a loss); addbacks (Interest, D&A, Tax) are
  // reported as positive magnitudes by the extractor.
  const ebitdaInputs = [...netIncomeItems, ...addbackItems].map(toCalcInput);
  const ebitdaSourceTotal = ebitdaInputs.reduce(
    (acc, i) => acc + i.amount_source,
    0,
  );
  const ebitdaTrackerUnrounded = ebitdaSourceTotal / 1000;
  const ebitdaResult = Math.round(ebitdaTrackerUnrounded);

  // Intercompany pairs are logged but never affect the math; Net Income
  // already nets them (they go through both sides of the income
  // statement). Surfacing them in the audit lets the analyst sanity-check
  // that we noticed the common shape.
  const intercompany_observed = findIntercompanyPairs(items, classifications);

  // Anything classified as "ignore" lands in unused_labels so the
  // analyst can audit lines we chose to drop. The classifier's reason
  // is included so the analyst can see WHY each was ignored.
  const unused_labels = items
    .filter((i) => classifications.get(i.label)?.category === "ignore")
    .map((i) => `${i.label} (${classifications.get(i.label)?.reason})`);

  const salesFormula =
    salesInputs.length === 0
      ? "no Sales lines matched the generic rule"
      : salesInputs.map((i) => i.label).join(" + ");

  const ebitdaFormulaParts: string[] = [];
  for (const ni of netIncomeItems) ebitdaFormulaParts.push(ni.label);
  for (const ab of addbackItems) ebitdaFormulaParts.push(`+ ${ab.label}`);
  const ebitdaFormula =
    ebitdaFormulaParts.length === 0
      ? "no Net Income or addbacks matched the generic rule"
      : ebitdaFormulaParts.join(" ");

  const salesTrace: CalculationTrace = {
    formula: salesFormula,
    inputs: salesInputs,
    total_tracker_unrounded: salesTrackerUnrounded,
    result_tracker: salesResult,
  };
  const ebitdaTrace: CalculationTrace = {
    formula: ebitdaFormula,
    inputs: ebitdaInputs,
    total_tracker_unrounded: ebitdaTrackerUnrounded,
    result_tracker: ebitdaResult,
  };

  return {
    sales: salesResult,
    ebitda: ebitdaResult,
    intercompany_observed,
    unused_labels,
    calculations: {
      sales: salesTrace,
      ebitda: ebitdaTrace,
    },
  };
}
