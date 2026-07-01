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

import {
  extractFromPdf,
  extractFromXlsxText,
} from "@/lib/tenant-credit/extraction";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Flatten a workbook to a tab-separated text dump grouped by sheet.
// Anthropic's document content block accepts PDFs only; xlsx files go
// through this path and reach Claude as plain text. ExcelJS is already
// in the bundle (used by the writeback route) so no extra cost.
async function xlsxToText(file: File): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const out: string[] = [];
  for (const sheet of wb.worksheets) {
    out.push(`=== Sheet: ${sheet.name} ===`);
    sheet.eachRow((row) => {
      const values = row.values as unknown[];
      // ExcelJS prepends a null at index 0 so column 1 is at index 1.
      const cells = values.slice(1).map(cellAsText).filter((s) => s !== "");
      if (cells.length > 0) out.push(cells.join("\t"));
    });
    out.push("");
  }
  return out.join("\n");
}

function cellAsText(v: unknown): string {
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
    if ("result" in o) return cellAsText(o.result);
    if ("text" in o && typeof o.text === "string") return o.text.trim();
  }
  return "";
}

// Anthropic's inline document content block accepts PDFs up to ~32 MB
// before requiring the Files API. Reject larger uploads at the door
// rather than trying and failing deep in the SDK call.
const MAX_PDF_BYTES = 32 * 1024 * 1024;

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
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json(
      {
        error:
          `File is ${file.size} bytes; max accepted is ${MAX_PDF_BYTES}.`,
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

  let raw;
  try {
    if (isPdf) {
      const arrayBuffer = await file.arrayBuffer();
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
              "file may be password-protected, scanned-image-only, or " +
              "renamed from another format.",
          },
          { status: 400 },
        );
      }
      raw = await extractFromPdf(Buffer.from(arrayBuffer).toString("base64"));
    } else {
      // xlsx path: ExcelJS reads cell values, we hand the flattened
      // text to Claude with the same schema and system prompt.
      let xlsxText: string;
      try {
        xlsxText = await xlsxToText(file);
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
      raw = await extractFromXlsxText(xlsxText);
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

  // No label normalization in the generic flow. The classifier in
  // lib/tenant-credit/generic-methodology matches on keyword patterns
  // directly, so we don't need to rewrite "D&A" to "Depreciation
  // Expense" etc. Surface every label as "passed_through" so the audit
  // record still shows what the extractor saw.
  return NextResponse.json({
    tenant_id: tenantId,
    source_entity: raw.source_entity,
    source_period: raw.source_period,
    line_items: raw.line_items,
    normalization_applied: [],
    passed_through: raw.line_items.map((i) => i.label),
  });
}
