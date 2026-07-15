// Phase 3 extraction. Pure function: bytes of a tenant's quarterly income
// statement PDF in, structured line items out.
//
// The engine in lib/methodology.ts wants `{label, amount}` records with
// labels matching its per-tenant config. This module does not normalize
// to canonical labels itself; that's lib/normalization.ts' job. The
// extractor's contract here is "report what the PDF says, verbatim,
// with sign conventions normalized so the engine doesn't have to guess."
//
// Implementation notes:
//   - Claude 4.x reads PDFs natively (document content block). No
//     pdfplumber, no client-side OCR.
//   - Structured outputs (output_config.format) guarantees the response
//     conforms to a JSON schema, so the route doesn't have to retry on
//     a malformed response.
//   - Adaptive thinking is on with high effort. Income-statement
//     extraction is detail-heavy (column alignment, subtotal vs line)
//     and benefits from the extra reasoning per the API guidance.

import Anthropic from "@anthropic-ai/sdk";

import type { SourceDocumentType, SourceScopeType } from "./source-period";
import {
  amountMatchesSourceUnits,
  type KnownSourceUnits,
} from "./source-units";
import { quarterLabel, type QuarterId } from "./tracker-layout";

export type SourceUnits = KnownSourceUnits | "unknown";
export type SourceUnitsOverride = Exclude<SourceUnits, "unknown"> | "auto";

export type ExtractionContext = {
  quarterId: QuarterId;
  unitsOverride: SourceUnitsOverride;
  sourceFilename: string;
};

// The minimal shape the extractor returns. The route layer normalizes
// labels before handing this to the engine.
export type RawLineItem = {
  // The label exactly as it appears on the source statement. Casing,
  // punctuation, and word order preserved.
  label: string;
  // Numeric value exactly as printed, before a thousands/millions scale.
  printed_amount: number;
  // Raw dollars with the economic sign preserved for profit/subtotal and
  // contra lines. Ordinary expense lines remain positive magnitudes.
  amount: number;
  source_reference: string;
};

export type RawExtractionResult = {
  // The entity (company) name as it appears on the statement header.
  source_entity: string;
  // The period covered, e.g. "Jan 2026 - Mar 2026" or "Q1 2026".
  source_period: string;
  source_units: SourceUnits;
  source_units_evidence: string;
  document_type: SourceDocumentType;
  source_scope: string;
  source_scope_type: SourceScopeType;
  source_scope_identifiers: string[];
  period_selection:
    | "printed_quarter_total"
    | "summed_months"
    | "single_period_column"
    | "point_in_time"
    | "unresolved";
  line_items: RawLineItem[];
};

// JSON schema given to Claude. The shape mirrors RawExtractionResult.
// `additionalProperties: false` is required by the structured-outputs
// implementation for every object node.
const EXTRACTION_SCHEMA = {
  type: "object",
  required: [
    "source_entity",
    "source_period",
    "source_units",
    "source_units_evidence",
    "document_type",
    "source_scope",
    "source_scope_type",
    "source_scope_identifiers",
    "period_selection",
    "line_items",
  ],
  additionalProperties: false,
  properties: {
    source_entity: {
      type: "string",
      minLength: 1,
      description:
        "The entity (company) name as it appears in the statement header, " +
        "verbatim. Example: 'Pinnacle Oil & Gas Holding INC'.",
    },
    source_period: {
      type: "string",
      minLength: 1,
      description:
        "The period the statement covers, in a human-readable form. " +
        "Example: 'Jan 2026 - Mar 2026' or 'Q1 2026'.",
    },
    source_units: {
      type: "string",
      enum: ["dollars", "thousands", "millions", "unknown"],
      description:
        "The units printed by the source statement before normalization.",
    },
    source_units_evidence: {
      type: "string",
      minLength: 1,
      description:
        "Short evidence for the unit choice, such as '$ in 000s', " +
        "'Dollars', or 'no units note found'.",
    },
    document_type: {
      type: "string",
      enum: [
        "income_statement",
        "balance_sheet",
        "cash_flow_statement",
        "combined_financial_statements",
        "other",
      ],
      description: "The financial statement class represented by this file.",
    },
    source_scope: {
      type: "string",
      minLength: 1,
      description:
        "The entity/location/cost-unit scope represented by the selected values, " +
        "for example 'entire consolidated entity', 'Boca location', or 'CU 40-45'.",
    },
    source_scope_type: {
      type: "string",
      enum: [
        "entity_wide",
        "component_subset",
        "single_component",
        "unknown",
      ],
      description:
        "entity_wide only when the values cover the entire named tenant/entity. " +
        "Use component_subset for several locations/cost units, single_component " +
        "for one, and unknown when the scope cannot be proved.",
    },
    source_scope_identifiers: {
      type: "array",
      description:
        "Every printed location/cost-unit/entity identifier represented by the " +
        "selected total. List each actual column identifier; do not abbreviate a " +
        "range. Empty only for entity_wide or unknown scope.",
      items: { type: "string", minLength: 1 },
    },
    period_selection: {
      type: "string",
      enum: [
        "printed_quarter_total",
        "summed_months",
        "single_period_column",
        "point_in_time",
        "unresolved",
      ],
      description:
        "How the one selected-period value for each line was obtained. " +
        "Use unresolved rather than guessing.",
    },
    line_items: {
      type: "array",
      minItems: 1,
      description:
        "Every relevant line for the selected period from the income statement, " +
        "balance sheet, and cash-flow statement. Emit one value per source row; " +
        "never emit monthly columns and their quarter total as separate items.",
      items: {
        type: "object",
        required: ["label", "printed_amount", "amount", "source_reference"],
        additionalProperties: false,
        properties: {
          label: {
            type: "string",
            minLength: 1,
            description:
              "The line label exactly as it appears in the source. " +
              "Preserve capitalization, punctuation, and word order. " +
              "Do not paraphrase.",
          },
          amount: {
            type: "number",
            description:
              "Raw dollars. Ordinary revenue and expense magnitudes are positive. " +
              "Net loss, negative EBITDA/PBITDA, contra-revenue, expense credits, " +
              "and negative cash-flow lines are negative. Scale thousands or " +
              "millions to raw dollars.",
          },
          printed_amount: {
            type: "number",
            description:
              "The signed numeric value exactly as printed, before applying a " +
              "thousands or millions scale.",
          },
          source_reference: {
            type: "string",
            minLength: 1,
            description:
              "Page/table/column for PDFs or sheet/cell for spreadsheets. Include " +
              "the selected period/column label.",
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a careful financial-document parser for an internal credit-tracking tool at a real-estate investment firm. Read income statements, balance sheets, and cash-flow statements and extract only the requested reporting period.

Rules you follow without exception:

1. Preserve labels verbatim. Do not paraphrase, abbreviate, or expand acronyms. If the statement says "Gasoline Sales", return "Gasoline Sales", not "Gas Sales" or "Fuel Sales".

2. Preserve economic signs. Ordinary revenues are positive and ordinary expenses are positive magnitudes. Net Loss, negative Net Income, negative EBITDA/PBITDA, contra-revenue (returns/allowances), expense credits, and negative cash-flow lines are negative. A label saying "Net Loss" must return a negative amount even if the report prints the magnitude without parentheses.

3. Detect source units before extracting. Return printed_amount exactly as shown. If the statement says thousands ($000s), set amount=printed_amount*1,000; if millions, set amount=printed_amount*1,000,000; for dollars the two values are equal. Currency symbols with cents and no scaling note are evidence of dollars. Plain unitless spreadsheet numbers with no scaling evidence are unknown, never automatically dollars. Always return line_items.amount in raw dollars.

4. Select exactly one value per source row for the requested period. If a printed quarter TOTAL column exists, use it and ignore its monthly columns. If only monthly columns exist, add the requested quarter's months once and return one aggregate. Never return monthly values plus the quarter total. For a balance sheet, use the requested quarter-end column.

5. Include statement subtotals, all revenue/profit/addback/rent/interest lines, cash and cash equivalents, cash from operations, and capital expenditures. Include intercompany lines verbatim. Exclude header-only rows.

6. Report document_type, source_scope, source_scope_type, source_scope_identifiers, source_period, period_selection, and a source_reference for every item. entity_wide means the entire named tenant, not merely a report titled "Consolidated" for a subset of cost units. The source filename is scope evidence: a filename suffix that names a location, facility, branch, store, or cost unit means that scope is single_component or component_subset even when the PDF header still shows the parent legal entity. For example, a file ending in "Boca" is a Boca component statement, not entity-wide. For a component report, list every actual location/cost-unit identifier, including an identifier supplied by the filename. Use period_selection=unresolved if the requested period cannot be isolated.

7. Do not invent. If a label or amount is unreadable, omit it rather than guess.`;

function userInstruction(context: ExtractionContext): string {
  const units =
    context.unitsOverride === "auto"
      ? "Detect units from explicit source evidence. Return unknown when evidence is absent."
      : `The analyst explicitly declares source units=${context.unitsOverride}; use that scale and cite the override as evidence.`;
  return `Source filename: ${JSON.stringify(context.sourceFilename)}. Target period: ${quarterLabel(context.quarterId)} (${context.quarterId}). ${units} Use both the filename and document contents to classify scope. A location or cost-unit qualifier in the filename is component scope even if the document header names the parent entity. Extract only this target period, classify the document and scope, and return one selected-period amount per source row. Do not combine a rollup with component columns.`;
}

// Defense-in-depth shape check. Structured outputs guarantees the JSON
// matches the schema; this validator catches the rare case where the SDK
// returns a malformed response or the parse step trips on something
// unexpected. Fail loudly so the route can return a clear 502 rather
// than passing junk into the normalizer.
function isRawExtractionResult(x: unknown): x is RawExtractionResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.source_entity !== "string" || o.source_entity.trim() === "") return false;
  if (typeof o.source_period !== "string" || o.source_period.trim() === "") return false;
  if (
    o.source_units !== "dollars" &&
    o.source_units !== "thousands" &&
    o.source_units !== "millions" &&
    o.source_units !== "unknown"
  ) {
    return false;
  }
  if (
    typeof o.source_units_evidence !== "string" ||
    o.source_units_evidence.trim() === ""
  ) return false;
  if (
    o.document_type !== "income_statement" &&
    o.document_type !== "balance_sheet" &&
    o.document_type !== "cash_flow_statement" &&
    o.document_type !== "combined_financial_statements" &&
    o.document_type !== "other"
  ) return false;
  if (typeof o.source_scope !== "string" || o.source_scope.trim() === "") return false;
  if (
    o.source_scope_type !== "entity_wide" &&
    o.source_scope_type !== "component_subset" &&
    o.source_scope_type !== "single_component" &&
    o.source_scope_type !== "unknown"
  ) return false;
  if (
    !Array.isArray(o.source_scope_identifiers) ||
    o.source_scope_identifiers.some(
      (identifier) =>
        typeof identifier !== "string" || identifier.trim() === "",
    )
  ) return false;
  if (
    (o.source_scope_type === "component_subset" ||
      o.source_scope_type === "single_component") &&
    o.source_scope_identifiers.length === 0
  ) return false;
  if (
    o.period_selection !== "printed_quarter_total" &&
    o.period_selection !== "summed_months" &&
    o.period_selection !== "single_period_column" &&
    o.period_selection !== "point_in_time" &&
    o.period_selection !== "unresolved"
  ) return false;
  if (
    !Array.isArray(o.line_items) ||
    o.line_items.length === 0 ||
    o.line_items.length > 400
  ) return false;
  for (const item of o.line_items) {
    if (!item || typeof item !== "object") return false;
    const i = item as Record<string, unknown>;
    if (typeof i.label !== "string" || i.label.trim() === "") return false;
    if (
      typeof i.printed_amount !== "number" ||
      !Number.isFinite(i.printed_amount)
    ) return false;
    if (typeof i.amount !== "number" || !Number.isFinite(i.amount)) {
      return false;
    }
    if (typeof i.source_reference !== "string" || i.source_reference.trim() === "") {
      return false;
    }
  }
  if (o.source_units !== "unknown") {
    for (const item of o.line_items as Array<Record<string, unknown>>) {
      if (
        !amountMatchesSourceUnits(
          item.printed_amount as number,
          item.amount as number,
          o.source_units,
        )
      ) return false;
    }
  }
  return true;
}

// Shared Claude call. Takes the user-content blocks (either a PDF
// document block or a plain-text block built from an xlsx) and returns
// the structured extraction result.
//
// Throws on:
//   - Missing ANTHROPIC_API_KEY (caught at SDK init time)
//   - Anthropic API errors (auth, rate limit, server). These bubble up
//     as the SDK's typed exceptions; the route maps them to 5xx.
//   - Malformed Anthropic response (validator failure). Should never
//     happen with structured outputs, but we don't trust silently.
async function runExtraction(
  userContent: Anthropic.Messages.ContentBlockParam[],
): Promise<RawExtractionResult> {
  // 100s timeout per call, 1 retry. Measured directly against real
  // tenant xlsx uploads (2026-07-01): dense, non-standard-shaped
  // statements (balance sheets, granular multi-account P&Ls flattened
  // from .xlsx, which lack a PDF's native layout structure) completed
  // in anywhere from 27s to 53s across repeated runs of the SAME
  // file — adaptive high-effort thinking duration is genuinely
  // variable call-to-call, not a fixed cost. A flat 80s budget still
  // timed out 3 of 5 files on a second run of the identical content
  // that had finished in under 53s moments earlier. Rather than chase
  // a single "safe" number, this gives a generous 100s window AND one
  // retry (a fresh attempt has independent variance, so it's a real
  // second chance, not a repeat of the same slow path) — worst case
  // ~200s. The route layer maxDuration is raised to 240s to match.
  const client = new Anthropic({ timeout: 100_000, maxRetries: 1 });

  const response = await client.messages.create({
    model:
      process.env.ANTHROPIC_TENANT_CREDIT_MODEL?.trim() ||
      "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        schema: EXTRACTION_SCHEMA,
      },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason !== "end_turn") {
    throw new Error(
      `Anthropic extraction stopped before completion: ${response.stop_reason ?? "unknown"}.`,
    );
  }

  const textBlock = response.content.find(
    (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
  );
  if (!textBlock) {
    throw new Error(
      "Anthropic extraction response had no text block. " +
        `stop_reason=${response.stop_reason}.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Anthropic extraction response was not valid JSON: ${detail}. ` +
        `First 200 chars: ${textBlock.text.slice(0, 200)}`,
    );
  }
  if (!isRawExtractionResult(parsed)) {
    throw new Error(
      `Anthropic extraction response did not match expected schema. ` +
        `Got: ${textBlock.text.slice(0, 200)}`,
    );
  }
  return parsed;
}

export async function extractFromPdf(
  pdfBase64: string,
  context: ExtractionContext,
): Promise<RawExtractionResult> {
  return runExtraction(
    [
      {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: pdfBase64,
        },
      },
      { type: "text", text: userInstruction(context) },
    ],
  );
}

// Excel entry point. The route layer reads the xlsx with exceljs,
// flattens every sheet into a tab-separated text dump, and hands it
// here. Anthropic's document content block doesn't accept xlsx
// directly (PDF + images only), so we feed it as plain text. Claude
// reads spreadsheet dumps reliably for the line-item extraction task;
// the SYSTEM_PROMPT and schema are identical to the PDF path.
export async function extractFromXlsxText(
  xlsxText: string,
  context: ExtractionContext,
): Promise<RawExtractionResult> {
  return runExtraction(
    [
      {
        type: "text",
        text:
          "The following is a flattened text dump of the analyst's " +
          "uploaded .xlsx workbook. Each sheet is delimited by a " +
          "'=== Sheet: <name> ===' header. Rows within a sheet are " +
          "reported as CELL=value pairs. Formula cells include their formula " +
          "and cached value. Apply the same selected-period rules as for PDFs.\n\n" +
          xlsxText,
      },
      { type: "text", text: userInstruction(context) },
    ],
  );
}
