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

import { extractFromPdf } from "@/lib/tenant-credit/extraction";

// Anthropic's inline document content block accepts PDFs up to ~32 MB
// before requiring the Files API. Reject larger uploads at the door
// rather than trying and failing deep in the SDK call.
const MAX_PDF_BYTES = 32 * 1024 * 1024;

// Force Node.js runtime (Anthropic SDK needs Node APIs). maxDuration
// raises the Vercel function timeout so a slow Claude response doesn't
// get killed at the default 10s on Hobby plan. Income-statement
// extraction with high-effort thinking typically takes 15-30s.
export const runtime = "nodejs";
export const maxDuration = 60;

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
          `PDF is ${file.size} bytes; max accepted is ${MAX_PDF_BYTES}. ` +
          "For larger files, switch to the Files API in Phase 5.",
      },
      { status: 413 },
    );
  }
  // file.type is best-effort (the browser sets it). Allow both the
  // standard MIME and the empty string (some clients omit it), reject
  // anything that clearly isn't a PDF.
  if (file.type && file.type !== "application/pdf") {
    return NextResponse.json(
      {
        error: `Expected application/pdf upload; got ${file.type}.`,
      },
      { status: 400 },
    );
  }

  // Read the bytes and base64-encode for the Anthropic document block.
  const arrayBuffer = await file.arrayBuffer();
  // Magic-byte check: a real PDF starts with "%PDF" (0x25 0x50 0x44 0x46).
  // Without this, encrypted PDFs, scanned-image-only PDFs, macOS resource
  // forks, and plain non-PDFs with a .pdf extension all get forwarded to
  // Anthropic, which 400s with "The PDF specified was not valid." The
  // analyst then sees a cryptic 502 from our route. Fail fast here
  // instead with the actual reason.
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
          `${file.name} does not start with the "%PDF" header, so it isn't ` +
          "a PDF Anthropic can read. Common causes: the file was renamed to " +
          ".pdf from another format; the PDF is password-protected; the zip " +
          "you uploaded contained macOS resource-fork files (the hidden " +
          "._filename.pdf or __MACOSX/* entries). Try re-exporting the PDF " +
          "from the source application, or upload one PDF at a time.",
      },
      { status: 400 },
    );
  }
  const pdfBase64 = Buffer.from(arrayBuffer).toString("base64");

  let raw;
  try {
    raw = await extractFromPdf(pdfBase64);
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
