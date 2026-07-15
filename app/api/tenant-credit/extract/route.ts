// POST /api/extract
// Phase 3. Accepts a multipart upload (the tenant's quarterly income
// statement PDF plus a tenant_id), calls Claude to extract structured
// line items, normalizes labels per the tenant's alias map, and returns
// the engine-ready shape.
//
// Request:
//   multipart/form-data
//     file:      the PDF (required, application/pdf, <= 32 MB)
//     tenant_id: the tenant key (required, e.g. "pinnacle")
//
// Response 200:
//   {
//     tenant_id: string,
//     source_entity: string,
//     source_period: string,
//     line_items: { label: string, amount: number }[],
//     normalization_applied: { raw_label, canonical_label, match_type }[],
//     passed_through: string[],
//   }
//
// Errors are intentionally loud and specific so the Phase 4 UI can
// surface useful messages to the analyst rather than a generic "500".

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";

import {
  extractFromPdf,
  extractFromXlsxText,
  type SourceUnitsOverride,
} from "@/lib/tenant-credit/extraction";
import { parseSourcePeriod, periodInsideQuarter } from "@/lib/tenant-credit/source-period";
import {
  ALL_QUARTER_IDS,
  type QuarterId,
} from "@/lib/tenant-credit/tracker-layout";
import { stripExcelCommentsForExcelJs } from "@/lib/tenant-credit/xlsx-sanitize";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Flatten a workbook to a tab-separated text dump grouped by sheet.
// Anthropic's document content block accepts PDFs only; xlsx files go
// through this path and reach Claude as plain text. ExcelJS is already
// in the bundle (used by the writeback route) so no extra cost.
async function xlsxToText(input: ArrayBuffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const bytes = stripExcelCommentsForExcelJs(input);
  await wb.xlsx.load(bytes);
  const out: string[] = [];
  for (const sheet of wb.worksheets) {
    out.push(`=== Sheet: ${sheet.name} ===`);
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cellAsText(cell.value, `${sheet.name}!${cell.address}`);
        if (value !== "") cells.push(`${cell.address}=${value}`);
      });
      if (cells.length > 0) out.push(cells.join("\t"));
    });
    out.push("");
  }
  return out.join("\n");
}

function cellAsText(v: unknown, location: string): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as { text?: string }[])
        .map((r) => r.text ?? "")
        .join("")
        .trim();
    }
    if ("formula" in o || "sharedFormula" in o) {
      const formula = String(o.formula ?? o.sharedFormula ?? "");
      if (!("result" in o) || o.result == null) {
        throw new Error(
          `${location} contains formula "${formula}" with no cached result. ` +
            "Open the workbook in Excel, recalculate, save, and upload again.",
        );
      }
      const cached = cellAsText(o.result, location);
      return `[formula=${formula}; cached=${cached}]`;
    }
    if ("text" in o && typeof o.text === "string") return o.text.trim();
    if ("error" in o) {
      throw new Error(`${location} contains Excel error ${String(o.error)}.`);
    }
  }
  return "";
}

// Anthropic's inline document content block accepts PDFs up to ~32 MB
// before requiring the Files API. Reject larger uploads at the door
// rather than trying and failing deep in the SDK call.
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_TEXT_CHARS = 8_000_000;

function isQuarterId(value: unknown): value is QuarterId {
  return typeof value === "string" && (ALL_QUARTER_IDS as string[]).includes(value);
}

function isUnitsOverride(value: unknown): value is SourceUnitsOverride {
  return (
    value === "auto" ||
    value === "dollars" ||
    value === "thousands" ||
    value === "millions"
  );
}

// Force Node.js runtime (Anthropic SDK needs Node APIs). maxDuration
// raises the Vercel function timeout so a slow Claude response doesn't
// get killed early. PDF income-statement extraction with high-effort
// thinking typically takes 15-30s, but dense xlsx-sourced statements
// (balance sheets, granular multi-account P&Ls) showed real call-to-
// call variance up to ~53s+ in testing (2026-07-01) — the extraction
// client now budgets 100s per attempt with 1 retry (~200s worst
// case), so this must stay comfortably above that.
export const runtime = "nodejs";
export const maxDuration = 240;

export async function POST(req: Request) {
  // Parse the multipart upload. If the Content-Type isn't multipart,
  // formData() throws; wrap so we return a clean 400 rather than 500.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      {
        error:
          "Request body must be multipart/form-data with `file` and `tenant_id` fields.",
      },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const tenantIdRaw = form.get("tenant_id");
  const quarterIdRaw = form.get("quarter_id");
  const unitsOverrideRaw = form.get("source_units_override") ?? "auto";

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Missing or invalid `file` field. Must be a PDF upload." },
      { status: 400 },
    );
  }
  if (typeof tenantIdRaw !== "string" || tenantIdRaw.length === 0) {
    return NextResponse.json(
      { error: "Missing `tenant_id` field." },
      { status: 400 },
    );
  }
  const tenantId = tenantIdRaw;
  if (!isQuarterId(quarterIdRaw)) {
    return NextResponse.json(
      { error: "Missing or invalid `quarter_id`." },
      { status: 400 },
    );
  }
  if (!isUnitsOverride(unitsOverrideRaw)) {
    return NextResponse.json(
      { error: "Invalid `source_units_override`." },
      { status: 400 },
    );
  }
  const context = {
    quarterId: quarterIdRaw,
    unitsOverride: unitsOverrideRaw,
    sourceFilename: file.name,
  };

  // The route no longer looks up a per-tenant config. The generic
  // engine classifies each line item via keyword rules, so we can
  // process any tenant in the corp financials tracker without first
  // writing a recipe for them. Accuracy goes down for tenants whose
  // line-item naming drifts from the common patterns; the analyst is
  // expected to audit every run for now.

  // Size + content-type checks. We accept any PDF MIME the browser
  // might tag, but require the file actually claim to be one.
  if (file.size === 0) {
    return NextResponse.json(
      { error: "Uploaded `file` is empty." },
      { status: 400 },
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        error:
          `File is ${file.size} bytes; max accepted is ${MAX_FILE_BYTES}.`,
      },
      { status: 413 },
    );
  }

  // Decide the extraction path. PDFs go to Claude as a document block;
  // xlsx files get flattened to text first because Anthropic's document
  // block doesn't accept spreadsheets. Anything else is rejected here.
  const lowerName = file.name.toLowerCase();
  const isPdf =
    file.type === "application/pdf" || lowerName.endsWith(".pdf");
  const isXlsx =
    file.type === XLSX_MIME || lowerName.endsWith(".xlsx");
  if (!isPdf && !isXlsx) {
    return NextResponse.json(
      {
        error:
          `Unsupported file type for ${file.name}. Upload .pdf or .xlsx; ` +
          `got mime "${file.type || "(none)"}".`,
      },
      { status: 400 },
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const sourceFileHash = createHash("sha256")
    .update(Buffer.from(arrayBuffer))
    .digest("hex");
  let raw;
  try {
    if (isPdf) {
      // Magic-byte check: a real PDF starts with "%PDF". Without this,
      // encrypted PDFs, scanned-image-only PDFs, macOS resource forks,
      // and plain non-PDFs with a .pdf extension all get forwarded to
      // Anthropic, which 400s with a cryptic "PDF specified was not
      // valid." Fail fast here with the actual reason.
      const head = new Uint8Array(arrayBuffer.slice(0, 4));
      if (
        head[0] !== 0x25 ||
        head[1] !== 0x50 ||
        head[2] !== 0x44 ||
        head[3] !== 0x46
      ) {
        return NextResponse.json(
          {
            error:
              `${file.name} does not start with the "%PDF" header. The ` +
              "file may be renamed from another format or damaged.",
          },
          { status: 400 },
        );
      }
      const pdfText = Buffer.from(arrayBuffer).toString("latin1");
      if (/\/Encrypt\b/.test(pdfText)) {
        return NextResponse.json(
          {
            error:
              `${file.name} is encrypted or password-protected. Export an ` +
              "unencrypted PDF and upload that copy.",
          },
          { status: 422 },
        );
      }
      const pageCount = (pdfText.match(/\/Type\s*\/Page\b/g) ?? []).length;
      if (pageCount > 600) {
        return NextResponse.json(
          { error: `${file.name} has ${pageCount} pages; maximum is 600.` },
          { status: 413 },
        );
      }
      raw = await extractFromPdf(
        Buffer.from(arrayBuffer).toString("base64"),
        context,
      );
    } else {
      // xlsx path: ExcelJS reads cell values, we hand the flattened
      // text to Claude with the same schema and system prompt.
      let xlsxText: string;
      try {
        xlsxText = await xlsxToText(arrayBuffer);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
          { error: `Could not parse ${file.name} as .xlsx: ${detail}` },
          { status: 400 },
        );
      }
      if (xlsxText.trim() === "") {
        return NextResponse.json(
          { error: `${file.name} has no readable cells.` },
          { status: 400 },
        );
      }
      if (xlsxText.length > MAX_XLSX_TEXT_CHARS) {
        return NextResponse.json(
          {
            error:
              `${file.name} expands to ${xlsxText.length.toLocaleString()} text ` +
              "characters. Split it into smaller quarter-specific workbooks.",
          },
          { status: 413 },
        );
      }
      raw = await extractFromXlsxText(xlsxText, context);
    }
  } catch (err) {
    // Map Anthropic errors to specific status codes so the analyst sees
    // a useful message instead of a generic 500. Use typed exceptions
    // per the SDK conventions, not message string-matching.
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json(
        {
          error:
            "Anthropic authentication failed. Check ANTHROPIC_API_KEY in .env.local.",
        },
        { status: 502 },
      );
    }
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Anthropic rate limit hit. Retry shortly." },
        { status: 429 },
      );
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: `Anthropic API error (${err.status}): ${err.message}` },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Extraction failed.",
      },
      { status: 500 },
    );
  }

  const parsedPeriod = parseSourcePeriod(raw.source_period);
  if (parsedPeriod && !periodInsideQuarter(parsedPeriod, quarterIdRaw)) {
    return NextResponse.json(
      {
        code: "SOURCE_PERIOD_OUTSIDE_QUARTER",
        error:
          `${file.name}: extracted period "${raw.source_period}" does not fall ` +
          `inside ${quarterIdRaw.replace("_", " ")}. The file was not used.`,
        source_period: raw.source_period,
        source_file_hash: sourceFileHash,
      },
      { status: 422 },
    );
  }

  // No label normalization in the generic flow. The classifier in
  // lib/tenant-credit/generic-methodology matches on keyword patterns
  // directly, so we don't need to rewrite "D&A" to "Depreciation
  // Expense" etc. Surface every label as "passed_through" so the audit
  // record still shows what the extractor saw.
  if (raw.source_units === "unknown") {
    return NextResponse.json(
      {
        error:
          "Extraction could not determine source units. Refusing to compute " +
          "because the tracker stores values in $000s and unit scale affects " +
          "every written amount.",
      },
      { status: 422 },
    );
  }
  if (unitsOverrideRaw !== "auto" && raw.source_units !== unitsOverrideRaw) {
    return NextResponse.json(
      {
        error:
          `Unit override was ${unitsOverrideRaw}, but extraction returned ` +
          `${raw.source_units}. Refusing inconsistent scaling.`,
      },
      { status: 422 },
    );
  }
  if (raw.period_selection === "unresolved") {
    return NextResponse.json(
      {
        error:
          `${file.name}: extraction could not isolate ${quarterIdRaw.replace("_", " ")}. ` +
          "Upload a quarter-specific statement or select the correct quarter.",
      },
      { status: 422 },
    );
  }
  if (!parsedPeriod || !periodInsideQuarter(parsedPeriod, quarterIdRaw)) {
    return NextResponse.json(
      {
        error:
          `${file.name}: extracted period "${raw.source_period}" does not fall ` +
          `inside ${quarterIdRaw.replace("_", " ")}.`,
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    tenant_id: tenantId,
    source_entity: raw.source_entity,
    source_period: raw.source_period,
    source_filename: file.name,
    source_file_hash: sourceFileHash,
    source_units: raw.source_units,
    source_units_evidence: raw.source_units_evidence,
    document_type: raw.document_type,
    source_scope: raw.source_scope,
    source_scope_type: raw.source_scope_type,
    source_scope_identifiers: raw.source_scope_identifiers,
    period_selection: raw.period_selection,
    line_items: raw.line_items,
    normalization_applied: [],
    passed_through: raw.line_items.map((i) => i.label),
  });
}
