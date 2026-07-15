// The methodology engine. Pure functions, no I/O, no side effects.
//
// Background for the finance-curious: every tenant in the credit tracker has
// its own "recipe" for two numbers, Sales and EBITDA, that summarize a
// quarter of operating performance. The recipe is a TenantConfig (one file
// per tenant under lib/tenant-configs/). This module reads a config plus a
// list of line items extracted from the tenant's income statement and
// returns the two numbers, rounded into tracker units ($000s).
//
// What the engine deliberately does NOT do:
//   - Read PDFs. That's Phase 3 (app/api/extract).
//   - Touch the xlsx. That's Phase 5 (the Cloud Run worker).
//   - Persist to Firestore. That's the API route caller, not the engine.
//   - Invent line items. If a config requires "Net Income" and the input
//     doesn't have it, the engine throws a clear error rather than guessing.

// A raw line item extracted from an income statement. `label` is the
// label as it appears on the source statement (e.g. "Gasoline Sales");
// `amount` is the value in source units (typically dollars).
export type LineItem = {
  label: string;
  amount: number;
  source_reference?: string;
};

// What units a number is in. Pinnacle's source PDF is in dollars; the
// tracker stores everything in thousands of dollars. The engine does the
// conversion once at the end.
export type Units = "dollars" | "thousands";

// An intercompany pair is two line items that record opposite sides of the
// same dollar (e.g. "Management Income" earned by one entity and
// "Management Fee" paid by another, same number). They net to zero through
// Net Income and don't affect EBITDA, but they must be logged so the audit
// record shows the analyst we noticed them.
export type IntercompanyPair = [incomeLabel: string, expenseLabel: string];

// The per-tenant recipe. Field names use snake_case so the same object
// shape serializes cleanly to Firestore (where snake_case is the standard);
// see CLAUDE.md and the Pontus tooling template for the convention.
export type TenantConfig = {
  tenant_id: string;
  tenant_name: string;
  // Row in the Corp Financials sheet where this tenant's data lives.
  tracker_row: number;
  // Line item labels whose amounts sum to Sales.
  sales_lines: string[];
  // The starting point for the EBITDA reconstruction. Typically "Net Income".
  ebitda_base: string;
  // Line item labels whose amounts get added to ebitda_base to produce EBITDA.
  // The classic recipe is Net Income + Depreciation + Interest, where D&A
  // and Interest are added back because they obscure operating performance.
  ebitda_addbacks: string[];
  // Pairs to recognize and log. Empty array if none.
  intercompany_pairs: IntercompanyPair[];
  // What units the source PDF reports its line items in.
  source_units: Units;
  // What units the tracker expects values to be written in.
  tracker_units: Units;
};

// Observed result of looking for an intercompany pair in the input.
// `net_effect_on_ebitda` is always 0 in the current recipe (NI already
// nets them), but the field is there for audit completeness and to make
// the assumption explicit.
export type IntercompanyObservation = {
  income_label: string;
  expense_label: string;
  income_amount_source: number;
  expense_amount_source: number;
  amounts_match: boolean;
  net_effect_on_ebitda_source: number;
};

// One contributing line item in a calculation trace. Both raw (source
// units) and converted (tracker units) amounts are preserved so the audit
// record can show analysts both views without us re-doing the math.
export type CalculationInput = {
  label: string;
  amount_source: number;
  amount_tracker: number;
};

// The detailed trace of one of the two computations.
export type CalculationTrace = {
  formula: string;
  inputs: CalculationInput[];
  // Sum before rounding, in tracker units.
  total_tracker_unrounded: number;
  // The final number after Math.round, in tracker units.
  result_tracker: number;
};

export type ComputeResult = {
  sales: number;
  ebitda: number;
  intercompany_observed: IntercompanyObservation[];
  // Labels present in the input but not consumed by the recipe (not in
  // sales_lines, ebitda_base, ebitda_addbacks, or any matched
  // intercompany pair). The Phase 4 preview UI should show these to the
  // analyst so a newly-appearing revenue line (e.g. "Diesel Sales" that
  // the Pinnacle recipe doesn't include) can't silently shrink Sales.
  unused_labels: string[];
  calculations: {
    sales: CalculationTrace;
    ebitda: CalculationTrace;
  };
};

// Convert a value from one unit to another. The only conversions the
// project needs today are identity and dollars <-> thousands; anything
// else is unsupported and throws so it can't silently produce wrong
// numbers.
export function convertUnits(
  amount: number,
  from: Units,
  to: Units,
): number {
  if (from === to) return amount;
  if (from === "dollars" && to === "thousands") return amount / 1000;
  if (from === "thousands" && to === "dollars") return amount * 1000;
  // Exhaustive guard. If we ever add new units, TS will flag this.
  throw new Error(
    `convertUnits: unsupported conversion from "${from}" to "${to}".`,
  );
}

// Build a label -> amount lookup, throwing on duplicates or non-finite
// amounts. Duplicates almost always indicate an extraction bug (the same
// line read twice); non-finite amounts (NaN, Infinity) almost always
// indicate the extractor dropped a field or hit a divide-by-zero. Either
// way the engine refuses rather than letting the bad value cascade into
// the tracker as a wrong number or "#NUM!" cell.
function buildLineItemLookup(items: LineItem[]): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const item of items) {
    if (lookup.has(item.label)) {
      throw new Error(
        `Duplicate line item: "${item.label}" appears more than once. ` +
          `This usually means the extractor read the same line twice; ` +
          `inspect the source statement and fix the extraction.`,
      );
    }
    // Use Number.isFinite (not the global isFinite) so a string like "123"
    // is NOT coerced to a number and accepted. The amount field is typed
    // `number` but at runtime JSON.parse, a buggy extractor, or an upstream
    // type-cast can put non-numbers through.
    if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) {
      throw new Error(
        `Line item "${item.label}" has a non-finite amount (${String(item.amount)}). ` +
          `The extractor must return a finite number; fix the extraction ` +
          `rather than letting NaN/Infinity reach the tracker.`,
      );
    }
    lookup.set(item.label, item.amount);
  }
  return lookup;
}

// Validate the config itself before applying it. The point of this helper
// is to catch typos and shape mistakes in hand-written configs (which is
// how new tenants will be onboarded in Phase 8) BEFORE they silently
// produce wrong numbers. Every guard here throws with a message that
// names the offending label so the recipe author can find the typo
// without grepping.
//
// What is NOT checked here: whether the line items the recipe references
// actually appear in any given input. That is the engine's job per-call,
// because the same config is applied to many quarters of input.
function validateConfig(config: TenantConfig): void {
  if (config.sales_lines.length === 0) {
    throw new Error(
      `Tenant "${config.tenant_id}" has an empty sales_lines list. ` +
        `Sales must sum at least one line item; an empty recipe would ` +
        `silently produce sales=0. Fix the config.`,
    );
  }
  // Empty ebitda_addbacks is legal: a tenant with EBITDA == Net Income
  // (no D&A, no Interest) is rare but real. Don't gate it.

  // Duplicate label inside sales_lines -> silent double-count of that
  // line in Sales.
  const salesDupe = firstDuplicate(config.sales_lines);
  if (salesDupe !== null) {
    throw new Error(
      `Tenant "${config.tenant_id}" has duplicate label "${salesDupe}" ` +
        `in sales_lines; it would be counted twice in Sales. Fix the config.`,
    );
  }

  // Duplicate label inside ebitda_addbacks -> silent double-count of
  // that addback in EBITDA.
  const addbackDupe = firstDuplicate(config.ebitda_addbacks);
  if (addbackDupe !== null) {
    throw new Error(
      `Tenant "${config.tenant_id}" has duplicate label "${addbackDupe}" ` +
        `in ebitda_addbacks; it would be counted twice in EBITDA. Fix the config.`,
    );
  }

  // ebitda_base appearing in ebitda_addbacks -> EBITDA double-counts the
  // base line (e.g. Net Income added on top of Net Income).
  if (config.ebitda_addbacks.includes(config.ebitda_base)) {
    throw new Error(
      `Tenant "${config.tenant_id}" lists ebitda_base "${config.ebitda_base}" ` +
        `inside ebitda_addbacks; it would be counted twice in EBITDA.`,
    );
  }

  // An intercompany pair label that also appears in ebitda_addbacks is
  // almost certainly a config bug. Net Income already nets the pair to
  // zero, so adding one leg back as an addback breaks the inert
  // assumption that net_effect_on_ebitda_source=0 documents. Catching
  // this here keeps the intercompany observation honest.
  for (const [incomeLabel, expenseLabel] of config.intercompany_pairs) {
    if (config.ebitda_addbacks.includes(incomeLabel)) {
      throw new Error(
        `Tenant "${config.tenant_id}" lists intercompany income label ` +
          `"${incomeLabel}" inside ebitda_addbacks; Net Income already ` +
          `nets the pair to zero so this would double-count. Fix the config.`,
      );
    }
    if (config.ebitda_addbacks.includes(expenseLabel)) {
      throw new Error(
        `Tenant "${config.tenant_id}" lists intercompany expense label ` +
          `"${expenseLabel}" inside ebitda_addbacks; Net Income already ` +
          `nets the pair to zero so this would double-count. Fix the config.`,
      );
    }
  }
}

// Return the first label that appears more than once, or null if none do.
// Plain linear scan; the lists are tiny (a handful of labels per recipe).
function firstDuplicate(labels: string[]): string | null {
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) return label;
    seen.add(label);
  }
  return null;
}

// Read a required line item from the lookup. Throw a clear error if missing.
function getRequiredAmount(
  lookup: Map<string, number>,
  label: string,
  context: string,
): number {
  if (!lookup.has(label)) {
    const present = Array.from(lookup.keys()).map((k) => `"${k}"`).join(", ");
    throw new Error(
      `Missing required line item "${label}" for ${context}. ` +
        `Present labels: [${present}].`,
    );
  }
  return lookup.get(label)!;
}

// The main entry point. Takes a config plus the extracted line items and
// returns Sales, EBITDA, and an audit trace. Pure: no I/O, no globals.
export function computeFromLineItems(
  config: TenantConfig,
  lineItems: LineItem[],
): ComputeResult {
  validateConfig(config);
  const lookup = buildLineItemLookup(lineItems);
  // Track which labels the recipe actually consumes so we can surface
  // unused inputs to the analyst.
  const consumed = new Set<string>();

  // Sales: sum every line listed in config.sales_lines.
  const salesInputs: CalculationInput[] = config.sales_lines.map((label) => {
    const amountSource = getRequiredAmount(
      lookup,
      label,
      `Sales (tenant ${config.tenant_id})`,
    );
    consumed.add(label);
    return {
      label,
      amount_source: amountSource,
      amount_tracker: convertUnits(
        amountSource,
        config.source_units,
        config.tracker_units,
      ),
    };
  });
  const salesUnrounded = salesInputs.reduce(
    (sum, inp) => sum + inp.amount_tracker,
    0,
  );
  const sales = Math.round(salesUnrounded);

  // EBITDA: start with the base line (typically Net Income), then add the
  // addback lines. The base label is included in the inputs trace too so
  // the audit log shows exactly what fed the computation.
  const ebitdaBaseAmount = getRequiredAmount(
    lookup,
    config.ebitda_base,
    `EBITDA base (tenant ${config.tenant_id})`,
  );
  consumed.add(config.ebitda_base);
  const ebitdaInputs: CalculationInput[] = [
    {
      label: config.ebitda_base,
      amount_source: ebitdaBaseAmount,
      amount_tracker: convertUnits(
        ebitdaBaseAmount,
        config.source_units,
        config.tracker_units,
      ),
    },
    ...config.ebitda_addbacks.map((label) => {
      const amountSource = getRequiredAmount(
        lookup,
        label,
        `EBITDA addback (tenant ${config.tenant_id})`,
      );
      // Addback amounts must be supplied as positive numbers in the
      // engine's input. "Add back" is an accounting concept that means
      // "undo this deduction"; the magnitude is what gets added. If a
      // source PDF reports an expense in parentheses and the extractor
      // preserves it as a negative, we'd silently SUBTRACT the addback
      // and understate EBITDA. Throw loudly instead.
      if (amountSource < 0) {
        throw new Error(
          `EBITDA addback "${label}" for tenant ${config.tenant_id} is negative ` +
            `(${amountSource}). Addbacks must be positive expense magnitudes; ` +
            `a negative value almost always means the extractor preserved a ` +
            `parenthesized figure with the wrong sign. Fix the extraction.`,
        );
      }
      consumed.add(label);
      return {
        label,
        amount_source: amountSource,
        amount_tracker: convertUnits(
          amountSource,
          config.source_units,
          config.tracker_units,
        ),
      };
    }),
  ];
  const ebitdaUnrounded = ebitdaInputs.reduce(
    (sum, inp) => sum + inp.amount_tracker,
    0,
  );
  const ebitda = Math.round(ebitdaUnrounded);

  // Intercompany pairs: we don't change EBITDA, just record what we saw.
  // A pair is "observed" only if BOTH sides are present in the input; a
  // one-sided appearance isn't an intercompany item per the convention.
  const intercompanyObserved: IntercompanyObservation[] = [];
  for (const [incomeLabel, expenseLabel] of config.intercompany_pairs) {
    const hasIncome = lookup.has(incomeLabel);
    const hasExpense = lookup.has(expenseLabel);
    if (!hasIncome || !hasExpense) continue;
    const incomeAmount = lookup.get(incomeLabel)!;
    const expenseAmount = lookup.get(expenseLabel)!;
    consumed.add(incomeLabel);
    consumed.add(expenseLabel);
    intercompanyObserved.push({
      income_label: incomeLabel,
      expense_label: expenseLabel,
      income_amount_source: incomeAmount,
      expense_amount_source: expenseAmount,
      // Half-cent tolerance. The amounts come from a PDF extractor whose
      // output may have sub-cent float artifacts (rounding, summed-vs-
      // stated lines). Strict === would flip a genuine intercompany
      // pair to amounts_match=false on a 0.001 delta and mislead the
      // analyst into thinking it isn't really paired.
      amounts_match: Math.abs(incomeAmount - expenseAmount) < 0.005,
      // Net Income already includes both sides, so the pair's effect on
      // EBITDA is zero. validateConfig guarantees neither leg appears in
      // ebitda_addbacks, so we can assert 0 here without recomputing.
      net_effect_on_ebitda_source: 0,
    });
  }

  // Surface every label that the input carries but the recipe didn't
  // touch. Phase 4 will show this list to the analyst so a new revenue
  // category (e.g. "Diesel Sales" on a future Pinnacle statement) can't
  // silently shrink Sales just because the config didn't list it.
  const unusedLabels = Array.from(lookup.keys()).filter(
    (label) => !consumed.has(label),
  );

  return {
    sales,
    ebitda,
    intercompany_observed: intercompanyObserved,
    unused_labels: unusedLabels,
    calculations: {
      sales: {
        formula: config.sales_lines.join(" + "),
        inputs: salesInputs,
        total_tracker_unrounded: salesUnrounded,
        result_tracker: sales,
      },
      ebitda: {
        formula: [config.ebitda_base, ...config.ebitda_addbacks].join(" + "),
        inputs: ebitdaInputs,
        total_tracker_unrounded: ebitdaUnrounded,
        result_tracker: ebitda,
      },
    },
  };
}
