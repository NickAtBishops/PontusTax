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

// The minimal shape the extractor returns. The route layer normalizes
// labels before handing this to the engine.
export type RawLineItem = {
  // The label exactly as it appears on the source statement. Casing,
  // punctuation, and word order preserved.
  label: string;
  // The dollar amount as a positive number for revenues and expense
  // magnitudes. Net Income is the one exception: it carries its actual
  // sign so the engine can compute negative-EBITDA quarters correctly.
  amount: number;
};

export type RawExtractionResult = {
  // The entity (company) name as it appears on the statement header.
  source_entity: string;
  // The period covered, e.g. "Jan 2026 - Mar 2026" or "Q1 2026".
  source_period: string;
  line_items: RawLineItem[];
};

// JSON schema given to Claude. The shape mirrors RawExtractionResult.
// `additionalProperties: false` is required by the structured-outputs
// implementation for every object node.
const EXTRACTION_SCHEMA = {
  type: "object",
  required: ["source_entity", "source_period", "line_items"],
  additionalProperties: false,
  properties: {
    source_entity: {
      type: "string",
      description:
        "The entity (company) name as it appears in the statement header, " +
        "verbatim. Example: 'Pinnacle Oil & Gas Holding INC'.",
    },
    source_period: {
      type: "string",
      description:
        "The period the statement covers, in a human-readable form. " +
        "Example: 'Jan 2026 - Mar 2026' or 'Q1 2026'.",
    },
    line_items: {
      type: "array",
      description:
        "Every individual revenue, expense, and bottom-line item " +
        "(Net Income, Operating Income) on the statement. Subtotals " +
        "are optional. Exclude header/section rows that have no amount.",
      items: {
        type: "object",
        required: ["label", "amount"],
        additionalProperties: false,
        properties: {
          label: {
            type: "string",
            description:
              "The line label exactly as it appears in the source. " +
              "Preserve capitalization, punctuation, and word order. " +
              "Do not paraphrase.",
          },
          amount: {
            type: "number",
            description:
              "The dollar amount. Report revenues as positive. Report " +
              "EXPENSE magnitudes as positive (so an expense shown as " +
              "$(821,457.93) becomes 821457.93). The only line whose " +
              "sign is preserved as written is Net Income (negative " +
              "for a loss). Do not report amounts in thousands; report " +
              "raw dollars.",
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a careful financial-document parser for an internal credit-tracking tool at a real-estate investment firm. Your job is to read a tenant's quarterly income statement PDF and extract every individual line with its dollar amount.

Rules you follow without exception:

1. Preserve labels verbatim. Do not paraphrase, abbreviate, or expand acronyms. If the statement says "Gasoline Sales", return "Gasoline Sales", not "Gas Sales" or "Fuel Sales".

2. Normalize signs so the consumer can sum without sign juggling. Revenues are positive. Expense magnitudes are positive (a depreciation expense of $821,457.93 is returned as 821457.93, even if the PDF shows it parenthesized as $(821,457.93)). The single exception is Net Income, which keeps its actual sign — negative when the period was a loss.

3. Report raw dollars. Do not divide by 1000. Cents are preserved.

4. Extract every individual line. Subtotals (Total Revenue, Total Expenses, Gross Profit) are optional but allowed. Header-only rows with no number are excluded. Intercompany items (Management Income, Management Fee) are included as ordinary line items, not summarized or netted.

5. Do not invent. If a label is unreadable or a number is missing, omit that row rather than guess.`;

const USER_INSTRUCTION = `Extract every line item from this quarterly income statement. Also identify the entity name and the period covered. Follow the rules in the system prompt strictly — especially the sign convention (expense magnitudes positive, Net Income signed).`;

// Defense-in-depth shape check. Structured outputs guarantees the JSON
// matches the schema; this validator catches the rare case where the SDK
// returns a malformed response or the parse step trips on something
// unexpected. Fail loudly so the route can return a clear 502 rather
// than passing junk into the normalizer.
function isRawExtractionResult(x: unknown): x is RawExtractionResult {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.source_entity !== "string") return false;
  if (typeof o.source_period !== "string") return false;
  if (!Array.isArray(o.line_items)) return false;
  for (const item of o.line_items) {
    if (!item || typeof item !== "object") return false;
    const i = item as Record<string, unknown>;
    if (typeof i.label !== "string") return false;
    if (typeof i.amount !== "number" || !Number.isFinite(i.amount)) {
      return false;
    }
  }
  return true;
}

// The main entry point. `pdfBase64` is the raw PDF bytes encoded as
// base64 (no data URL prefix). The route layer is responsible for
// reading the upload and converting to base64.
//
// Throws on:
//   - Missing ANTHROPIC_API_KEY (caught at SDK init time)
//   - Anthropic API errors (auth, rate limit, server). These bubble up
//     as the SDK's typed exceptions; the route maps them to 5xx.
//   - Malformed Anthropic response (validator failure). Should never
//     happen with structured outputs, but we don't trust silently.
export async function extractFromPdf(
  pdfBase64: string,
): Promise<RawExtractionResult> {
  // 25s timeout per call, no internal retries. The route layer sets
  // maxDuration=60 so we leave ~30s headroom for network + JSON parse.
  // The SDK's default retry would burn that budget on a hung request.
  const client = new Anthropic({ timeout: 25_000, maxRetries: 1 });

  const response = await client.messages.create({
    model: "claude-opus-4-8",
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
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64,
            },
          },
          { type: "text", text: USER_INSTRUCTION },
        ],
      },
    ],
  });

  // The structured-outputs response is a single text block whose body
  // is the JSON-encoded result. Find it explicitly because the API
  // may also return thinking blocks (which we don't surface here).
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
