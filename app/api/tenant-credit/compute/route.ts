// POST /api/compute
// Phase 4. Takes a tenant_id and a list of normalized line items, runs
// the methodology engine, and returns the structured ComputeResult
// (sales, ebitda, calculations trace, intercompany observations,
// unused labels).
//
// This route does not call Claude. It is a pure wrapper around the
// engine so the client UI can compute after the analyst edits an
// extracted line item (Phase 4+) without a second round-trip to
// Anthropic, and so the Phase 6 audit log can persist exactly what the
// engine produced.
//
// Request body (JSON):
//   {
//     tenant_id: string,                       // e.g. "pinnacle"
//     line_items: { label: string, amount: number }[],
//   }
//
// Response 200: the engine's ComputeResult, verbatim.

import { NextResponse } from "next/server";

import type { LineItem } from "@/lib/tenant-credit/methodology";
import { computeGeneric } from "@/lib/tenant-credit/generic-methodology";

// Defense-in-depth shape check. The route is server-only but the body
// crosses an HTTP boundary, so we don't trust the client.
function isLineItem(x: unknown): x is LineItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.label === "string" &&
    typeof o.amount === "number" &&
    Number.isFinite(o.amount)
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Request body must be a JSON object." },
      { status: 400 },
    );
  }
  const o = body as Record<string, unknown>;

  if (typeof o.tenant_id !== "string" || o.tenant_id.length === 0) {
    return NextResponse.json(
      { error: "Missing `tenant_id` (string)." },
      { status: 400 },
    );
  }
  if (!Array.isArray(o.line_items)) {
    return NextResponse.json(
      { error: "Missing `line_items` (array of {label, amount})." },
      { status: 400 },
    );
  }
  for (const [i, item] of o.line_items.entries()) {
    if (!isLineItem(item)) {
      return NextResponse.json(
        {
          error:
            `line_items[${i}] is invalid; each entry must be ` +
            `{ label: string, amount: finite number }.`,
        },
        { status: 400 },
      );
    }
  }
  // tenant_id is accepted in the request body so the audit log can
  // attribute the run, but the generic engine doesn't need it: it
  // categorizes lines via keyword rules that don't depend on which
  // tenant produced them. If a per-tenant override ever matters we'd
  // look it up here.
  const lineItems = o.line_items as LineItem[];

  // The generic engine can't fail on "missing required line" the way
  // the strict per-tenant engine could — it produces a best-effort
  // result from whatever it found. The only error path is a thrown
  // exception from the heuristic itself (e.g. strictSigns: true with a
  // negative Sales total). 500 is correct for that; 4xx would imply
  // client error, which this isn't.
  try {
    const result = computeGeneric(lineItems);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Computation failed.",
      },
      { status: 500 },
    );
  }
}
