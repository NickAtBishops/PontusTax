// POST /api/writeback
// Phase 5/6. Takes a tenant + quarter + the two computed values, reads
// the master tracker from samples/, posts to the Cloud Run worker (or
// localhost in dev), streams the modified xlsx back to the browser for
// download, AND writes a Firestore audit record (Phase 6) capturing the
// full extract+compute trace so we can answer "what did we write last
// Tuesday?" later.
//
// Request body (JSON). Required fields:
//   {
//     tenant_id:  string,
//     quarter_id: QuarterId,
//     sales:      number,
//     ebitda:     number,
//   }
//
// Optional audit fields (the dashboard always sends them; legacy clients
// or test scripts can omit them and get a partial audit record):
//   {
//     source_pdf_filename?:    string,
//     source_pdf_hash?:        string,   // sha-256 hex from the browser
//     source_entity?:          string,
//     source_period?:          string,
//     line_items?:             LineItem[],
//     normalization_applied?:  AuditNormalization[],
//     passed_through?:         string[],
//     unused_labels?:          string[],
//     intercompany_observed?:  AuditIntercompany[],
//     calculations?:           { sales: AuditCalculationTrace, ebitda: ... },
//     written_by?:             string,   // overrides the default
//   }
//
// Response 200: xlsx octet-stream as before. If the audit write fails
// when Firestore IS configured, the route returns 500 with a clear
// error; the file isn't returned. The user can retry.

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

import { getTenantConfig } from "@/lib/tenant-credit/tenant-configs";
import {
  ALL_QUARTER_IDS,
  trackerColumnsForQuarter,
  type QuarterId,
} from "@/lib/tenant-credit/tracker-layout";
import {
  writeAuditRun,
  type AuditCalculationTrace,
  type AuditIntercompany,
  type AuditNormalization,
} from "@/lib/tenant-credit/audit";

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8080";

// Shared bearer token used to authenticate Vercel -> Cloud Run calls.
// Optional in local dev so you can boot the worker without setting it,
// but required in production: the worker rejects unauthenticated
// requests if it has a secret configured and Vercel doesn't send one.
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET ?? "";

// 50s ceiling for the worker call. Leaves ~10s headroom under our
// 60s maxDuration so the response can still be streamed back even if
// the worker takes the full window. Cold-start + a 200kb xlsx round-
// trip should comfortably fit.
const WORKER_TIMEOUT_MS = 50_000;

const MASTER_XLSX_PATH = path.join(
  process.cwd(),
  "samples",
  "Corporate_Financials_and_P_Ls.xlsx",
);

// Same justification as /api/extract: force Node.js runtime and give
// the route enough budget for the Cloud Run round-trip + audit write.
export const runtime = "nodejs";
export const maxDuration = 60;

// Default actor for audit when the client doesn't send one. Phase 7+
// will replace this with the email from Firebase Auth. We use the
// literal string "pending-auth" rather than a fake email so audit
// rows reviewed before Firebase Auth lands aren't mistaken for real
// attributions. Override via AUDIT_DEFAULT_WRITTEN_BY env var (e.g.
// in .env.local set it to the demo presenter's email).
const DEFAULT_WRITTEN_BY =
  process.env.AUDIT_DEFAULT_WRITTEN_BY ?? "pending-auth";

function tenantNameSubstring(tenantName: string): string {
  return tenantName.split(/[\s,]+/, 1)[0] ?? tenantName;
}

function isQuarterId(s: unknown): s is QuarterId {
  return typeof s === "string" && (ALL_QUARTER_IDS as string[]).includes(s);
}

function timestamp(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

// Cast helpers with sensible defaults. The dashboard always sends
// well-typed data; the defaults exist so a curl test that omits the
// audit payload still produces a coherent audit record.
function asString(x: unknown, dflt = ""): string {
  return typeof x === "string" ? x : dflt;
}
function asStringArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s) => typeof s === "string") : [];
}
function asObjectArray<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}
function asCalculationTrace(x: unknown): AuditCalculationTrace {
  const empty: AuditCalculationTrace = {
    formula: "",
    inputs: [],
    total_tracker_unrounded: 0,
    result: 0,
  };
  if (!x || typeof x !== "object") return empty;
  const o = x as Record<string, unknown>;
  return {
    formula: asString(o.formula),
    inputs: Array.isArray(o.inputs)
      ? (o.inputs as AuditCalculationTrace["inputs"])
      : [],
    total_tracker_unrounded:
      typeof o.total_tracker_unrounded === "number"
        ? o.total_tracker_unrounded
        : 0,
    result:
      typeof o.result === "number"
        ? o.result
        : typeof o.result_tracker === "number"
          ? (o.result_tracker as number)
          : 0,
  };
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

  if (typeof o.tenant_id !== "string") {
    return NextResponse.json(
      { error: "Missing `tenant_id`." },
      { status: 400 },
    );
  }
  if (!isQuarterId(o.quarter_id)) {
    return NextResponse.json(
      {
        error:
          `Missing or invalid \`quarter_id\`. Known: ` +
          `[${ALL_QUARTER_IDS.join(", ")}].`,
      },
      { status: 400 },
    );
  }
  if (
    typeof o.sales !== "number" ||
    !Number.isFinite(o.sales) ||
    typeof o.ebitda !== "number" ||
    !Number.isFinite(o.ebitda)
  ) {
    return NextResponse.json(
      { error: "`sales` and `ebitda` must be finite numbers." },
      { status: 400 },
    );
  }
  const tenantId = o.tenant_id;
  const quarterId = o.quarter_id;
  const sales = o.sales;
  const ebitda = o.ebitda;

  let tenant;
  try {
    tenant = getTenantConfig(tenantId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown tenant_id." },
      { status: 400 },
    );
  }

  const target = trackerColumnsForQuarter(quarterId);

  let xlsxBuffer: Buffer;
  try {
    xlsxBuffer = await fs.readFile(MASTER_XLSX_PATH);
  } catch (err) {
    return NextResponse.json(
      {
        error:
          `Could not read master tracker at ${MASTER_XLSX_PATH}: ` +
          (err instanceof Error ? err.message : String(err)),
      },
      { status: 500 },
    );
  }

  // Build the multipart payload for the worker. Note that the worker's
  // form fields are exactly the WriteRequest fields.
  const form = new FormData();
  form.append(
    "xlsx_file",
    new Blob([new Uint8Array(xlsxBuffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "tracker.xlsx",
  );
  form.append("sheet_name", target.sheet_name);
  form.append("row", String(tenant.tracker_row));
  form.append(
    "expected_tenant_substring",
    tenantNameSubstring(tenant.tenant_name),
  );
  form.append("sales_col", String(target.sales_col));
  form.append("ebitda_col", String(target.ebitda_col));
  form.append("sales_value", String(sales));
  form.append("ebitda_value", String(ebitda));
  form.append("sales_header_expected", target.sales_header_expected);
  form.append("ebitda_header_expected", target.ebitda_header_expected);
  if (target.ebitda_header_alternate) {
    form.append("ebitda_header_alternate", target.ebitda_header_alternate);
  }
  form.append("header_row", String(target.header_row));

  // Pull the audit payload from the body before contacting the worker
  // so we can log either outcome.
  const calculations = (o.calculations ?? {}) as Record<string, unknown>;
  const auditBase = {
    tenant_id: tenantId,
    quarter: quarterId,
    source_pdf_filename: asString(o.source_pdf_filename),
    source_pdf_hash: asString(o.source_pdf_hash),
    source_entity: asString(o.source_entity),
    source_period: asString(o.source_period),
    computed_sales: sales,
    computed_ebitda: ebitda,
    intercompany_observed: asObjectArray<AuditIntercompany>(
      o.intercompany_observed,
    ),
    normalization_applied: asObjectArray<AuditNormalization>(
      o.normalization_applied,
    ),
    passed_through: asStringArray(o.passed_through),
    unused_labels: asStringArray(o.unused_labels),
    line_items: asObjectArray<{ label: string; amount: number }>(o.line_items),
    calculations: {
      sales: asCalculationTrace(calculations.sales),
      ebitda: asCalculationTrace(calculations.ebitda),
    },
    written_by: asString(o.written_by, DEFAULT_WRITTEN_BY),
  };

  // Contact the worker. The Authorization header is only set when the
  // shared secret is configured; the worker enforces the policy on its
  // side based on whether IT has a secret set.
  const workerHeaders: Record<string, string> = {};
  if (WORKER_SHARED_SECRET) {
    workerHeaders.Authorization = `Bearer ${WORKER_SHARED_SECRET}`;
  }
  let workerRes: Response;
  try {
    workerRes = await fetch(`${WORKER_URL}/writeback`, {
      method: "POST",
      body: form,
      headers: workerHeaders,
      // AbortSignal.timeout aborts the underlying socket if the worker
      // doesn't respond inside the window. Without it a hung worker
      // would silently consume the entire 60s maxDuration.
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    // Only surface the local-dev hint outside production so the demo
    // never shows it. In a deployed Vercel + Cloud Run setup the
    // boss should see a neutral worker-unreachable message.
    const devHint =
      process.env.NODE_ENV !== "production"
        ? " Boot it with `uvicorn main:app --port 8080` from worker/."
        : "";
    const errorMsg = isTimeout
      ? `Writeback worker at ${WORKER_URL} did not respond within ` +
        `${WORKER_TIMEOUT_MS / 1000}s.${devHint}`
      : `Could not reach the writeback worker at ${WORKER_URL}: ${reason}.` +
        devHint;
    // The worker is unreachable; we don't have a written_filename
    // because no file was produced. Still write a failure audit so the
    // run shows up in Past Runs.
    await tryWriteAudit({
      ...auditBase,
      status: "writeback_failed",
      worker_warnings: [],
      error: errorMsg,
      written_filename: "",
    });
    return NextResponse.json({ error: errorMsg }, { status: 502 });
  }

  if (!workerRes.ok) {
    const detail = await workerRes.json().catch(() => ({}));
    const errorMsg =
      detail.error ?? `Worker returned ${workerRes.status}.`;
    await tryWriteAudit({
      ...auditBase,
      status: "writeback_failed",
      worker_warnings: [],
      error: errorMsg,
      written_filename: "",
    });
    return NextResponse.json(
      { error: errorMsg },
      { status: workerRes.status },
    );
  }

  // Success path. Read the xlsx + headers BEFORE writing audit because
  // the audit write needs the filename.
  const newXlsx = await workerRes.arrayBuffer();
  const warningsHeader = workerRes.headers.get("X-Worker-Warnings");
  let workerWarnings: string[] = [];
  if (warningsHeader) {
    try {
      const parsed = JSON.parse(warningsHeader);
      if (Array.isArray(parsed)) {
        workerWarnings = parsed.filter((s) => typeof s === "string");
      }
    } catch {
      workerWarnings = [warningsHeader];
    }
  }
  const filename =
    `Corporate_Financials_and_P_Ls_${quarterId}_${timestamp()}.xlsx`;

  // Per CLAUDE.md: audit BEFORE returning success. If the write fails
  // when Firestore IS configured, we return 500 so the operator knows
  // to retry. No audit configured -> silent skip + still return file.
  try {
    await writeAuditRun({
      ...auditBase,
      status: "writeback_success",
      worker_warnings: workerWarnings,
      error: null,
      written_filename: filename,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        error:
          `Worker wrote ${filename} but the audit-log write to Firestore ` +
          `failed: ${msg}. Re-run after fixing Firestore; the master ` +
          "tracker was not modified.",
      },
      { status: 500 },
    );
  }

  const headers = new Headers({
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  if (warningsHeader) headers.set("X-Worker-Warnings", warningsHeader);

  return new Response(newXlsx, { status: 200, headers });
}

// Audit on failure paths is best-effort. We never want a 502 from the
// worker to be masked by a Firestore outage, and we already returned
// useful information to the caller before reaching this point.
async function tryWriteAudit(
  payload: Parameters<typeof writeAuditRun>[0],
): Promise<void> {
  try {
    await writeAuditRun(payload);
  } catch (err) {
    console.error("[audit] failed to write failure record:", err);
  }
}
