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
import { normalizeLineItems } from "@/lib/tenant-credit/normalization";
import {
  getTenantConfig,
  getTenantLabelAliases,
} from "@/lib/tenant-credit/tenant-configs";

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

  // Resolve config + aliases before touching the upload. If the tenant
  // doesn't exist, fail fast and cheap.
  try {
    getTenantConfig(tenantId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown tenant_id." },
      { status: 400 },
    );
  }
  let aliases;
  try {
    aliases = getTenantLabelAliases(tenantId);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Tenant has no label aliases configured.",
      },
      { status: 400 },
    );
  }

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

  // Normalize labels. Throws on collision (two raw labels mapping to
  // the same canonical), which is a "needs analyst review" case, not
  // something the route should hide.
  let normResult;
  try {
    normResult = normalizeLineItems(raw.line_items, aliases);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Normalization failed.",
        raw_extraction: raw,
      },
      { status: 422 },
    );
  }

  return NextResponse.json({
    tenant_id: tenantId,
    source_entity: raw.source_entity,
    source_period: raw.source_period,
    line_items: normResult.normalized,
    normalization_applied: normResult.applied,
    passed_through: normResult.passed_through,
  });
}
