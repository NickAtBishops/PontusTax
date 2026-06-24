// POST /api/tenant-credit/writeback
// Phase 5/6. Takes a tenant + quarter + the two computed values + the
// analyst's uploaded master tracker, posts to the Cloud Run worker (or
// localhost in dev), streams the modified xlsx back to the browser for
// download, AND writes a Firestore audit record (Phase 6) capturing the
// full extract+compute trace so we can answer "what did we write last
// Tuesday?" later.
//
// Request:
//   multipart/form-data
//     tracker_xlsx:  the master tracker .xlsx the analyst uploaded
//                    earlier (required). The bundled samples/ copy is
//                    no longer used at runtime; the analyst owns the
//                    source of truth, which sidesteps the "the
//                    repo-bundled tracker is six months stale" trap.
//     payload:       JSON-encoded request body (string). Schema below.
//
// Payload (JSON, required fields):
//   {
//     tenant_id:    string,
//     quarter_id:   QuarterId,
//     tracker_row:  number,   // 1-indexed row, resolved by /tenants
//     sales:        number,
//     ebitda:       number,
//   }
//
// Payload (optional audit fields; the dashboard always sends them):
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
import ExcelJS from "exceljs";

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

// The corporate-financials tracker is ~200 KB. Cap at 8 MB so a
// fat-finger upload of the wrong workbook (or a rich-media variant)
// doesn't tie up the function.
const MAX_TRACKER_BYTES = 8 * 1024 * 1024;

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
  // The route is multipart now: tracker_xlsx as a file + payload as a
  // single JSON-encoded string field. Using a JSON sub-field keeps the
  // schema parity with the legacy route (callers stringify the same
  // object they used before) without inventing a new field per scalar.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      {
        error:
          "Request body must be multipart/form-data with `tracker_xlsx` and `payload`.",
      },
      { status: 400 },
    );
  }

  const trackerFile = form.get("tracker_xlsx");
  if (!(trackerFile instanceof File)) {
    return NextResponse.json(
      { error: "Missing or invalid `tracker_xlsx` field. Must be an .xlsx upload." },
      { status: 400 },
    );
  }
  if (trackerFile.size === 0) {
    return NextResponse.json(
      { error: "Uploaded tracker is empty." },
      { status: 400 },
    );
  }
  if (trackerFile.size > MAX_TRACKER_BYTES) {
    return NextResponse.json(
      {
        error:
          `Tracker is ${trackerFile.size} bytes; max accepted is ${MAX_TRACKER_BYTES}.`,
      },
      { status: 413 },
    );
  }

  const payloadRaw = form.get("payload");
  if (typeof payloadRaw !== "string") {
    return NextResponse.json(
      { error: "Missing `payload` field (JSON string)." },
      { status: 400 },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(payloadRaw);
  } catch {
    return NextResponse.json(
      { error: "`payload` must be valid JSON." },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "`payload` must be a JSON object." },
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
  // tracker_row comes from /tenants and is authoritative; the per-tenant
  // recipe's hardcoded tracker_row is a default for unit tests only and
  // would silently mis-write the wrong row if the spreadsheet drifted.
  if (
    typeof o.tracker_row !== "number" ||
    !Number.isInteger(o.tracker_row) ||
    o.tracker_row < 1
  ) {
    return NextResponse.json(
      { error: "Missing or invalid `tracker_row` (must be a positive integer)." },
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
  const trackerRow = o.tracker_row;
  const sales = o.sales;
  const ebitda = o.ebitda;

  // The expected tenant name comes directly from the picker, which got
  // it from column A of the uploaded tracker. We don't need a per-tenant
  // config in the generic-engine world; we just need the display name
  // so the writer can verify it's about to touch the right row.
  if (typeof o.tenant_display_name !== "string" || !o.tenant_display_name) {
    return NextResponse.json(
      { error: "Missing `tenant_display_name`." },
      { status: 400 },
    );
  }
  const tenantDisplayName = o.tenant_display_name;

  const target = trackerColumnsForQuarter(quarterId);

  // Read the analyst-uploaded tracker once. The original upload is
  // never modified server-side; we build a brand-new buffer in memory
  // and return it to the browser, so the user's original file on disk
  // is untouched. ExcelJS's typings want a plain ArrayBuffer (not the
  // Node Buffer alias) on the load() entry point.
  const xlsxBuffer = await trackerFile.arrayBuffer();

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

  // Run the write in-process using exceljs. We used to round-trip to a
  // Python (openpyxl) service on Cloud Run, which had two ongoing costs
  // (a second deploy target + a localhost worker every dev session) for
  // a payoff that only mattered for complex multi-cell writes. This
  // route writes exactly two cells, so the JS library handles it.
  let newXlsx: ArrayBuffer;
  let workerWarnings: string[] = [];
  try {
    const result = await writeQuarterlyValues({
      xlsxBuffer,
      sheetName: target.sheet_name,
      row: trackerRow,
      expectedTenantSubstring: tenantNameSubstring(tenantDisplayName),
      salesCol: target.sales_col,
      ebitdaCol: target.ebitda_col,
      salesValue: sales,
      ebitdaValue: ebitda,
      salesHeaderExpected: target.sales_header_expected,
      ebitdaHeaderExpected: target.ebitda_header_expected,
      ebitdaHeaderAlternate: target.ebitda_header_alternate ?? null,
      headerRow: target.header_row,
    });
    newXlsx = result.xlsx.buffer.slice(
      result.xlsx.byteOffset,
      result.xlsx.byteOffset + result.xlsx.byteLength,
    ) as ArrayBuffer;
    workerWarnings = result.warnings;
  } catch (err) {
    const refused = err instanceof WritebackRefusedError;
    const status = refused ? 422 : 500;
    const errorMsg = err instanceof Error ? err.message : String(err);
    await tryWriteAudit({
      ...auditBase,
      status: "writeback_failed",
      worker_warnings: [],
      error: errorMsg,
      written_filename: "",
    });
    return NextResponse.json({ error: errorMsg }, { status });
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
          `The xlsx was written but the audit-log write to Firestore ` +
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
  // Keep the X-Worker-Warnings header name so the existing client-side
  // toast logic still works; the warnings now come from the in-process
  // writer instead of the Python worker.
  if (workerWarnings.length > 0) {
    headers.set("X-Worker-Warnings", JSON.stringify(workerWarnings));
  }

  return new Response(newXlsx, { status: 200, headers });
}

// Audit on failure paths is best-effort. We never want a 422/500 to be
// masked by a Firestore outage; we already returned useful information
// to the caller before reaching this point.
async function tryWriteAudit(
  payload: Parameters<typeof writeAuditRun>[0],
): Promise<void> {
  try {
    await writeAuditRun(payload);
  } catch (err) {
    console.error("[audit] failed to write failure record:", err);
  }
}

// ----------------------------------------------------------------------------
// In-process xlsx writer (replaces the openpyxl Cloud Run service)
// ----------------------------------------------------------------------------

// Raised when a precondition fails (wrong sheet, wrong tenant, target
// cell already populated, etc.). Mapped to HTTP 422 by the caller. The
// distinction from a plain Error keeps the response code informative.
class WritebackRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WritebackRefusedError";
  }
}

type WriteQuarterlyValuesInput = {
  xlsxBuffer: ArrayBuffer;
  sheetName: string;
  row: number;
  expectedTenantSubstring: string;
  salesCol: number;
  ebitdaCol: number;
  salesValue: number;
  ebitdaValue: number;
  salesHeaderExpected: string;
  ebitdaHeaderExpected: string;
  // The AI3 column on the actual tracker reads "Q4 26" instead of
  // "Q1 26" because of a typo in the source. When set, the writer
  // accepts that string in place of the expected one and emits a
  // soft warning rather than refusing.
  ebitdaHeaderAlternate: string | null;
  headerRow: number;
};

type WriteQuarterlyValuesResult = {
  xlsx: Uint8Array;
  warnings: string[];
};

// Validate the workbook and write the two cells. Mirrors the Python
// openpyxl service one-for-one so the safety guarantees are unchanged:
// refuse to overwrite a formula, refuse to overwrite a non-empty cell,
// refuse to write if the row's tenant or the column's header doesn't
// match what was requested. Returns the new bytes and any soft warnings.
async function writeQuarterlyValues(
  input: WriteQuarterlyValuesInput,
): Promise<WriteQuarterlyValuesResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(input.xlsxBuffer);
  } catch (err) {
    throw new WritebackRefusedError(
      `Could not parse the uploaded tracker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const sheet = wb.getWorksheet(input.sheetName);
  if (!sheet) {
    const seen = wb.worksheets.map((w) => `"${w.name}"`).join(", ");
    throw new WritebackRefusedError(
      `Sheet "${input.sheetName}" not in workbook. Sheets seen: [${seen}].`,
    );
  }

  const warnings: string[] = [];

  // --- 1. Tenant identity check on column A of the target row. -------------
  const nameText = cellPlainText(sheet.getCell(input.row, 1).value);
  if (
    !nameText.toLowerCase().includes(input.expectedTenantSubstring.toLowerCase())
  ) {
    throw new WritebackRefusedError(
      `Row ${input.row} column A is ${JSON.stringify(nameText)}, which does ` +
        `not contain expected tenant substring ` +
        `${JSON.stringify(input.expectedTenantSubstring)}. Refusing to write ` +
        "to a row that may belong to a different tenant.",
    );
  }

  // --- 2. Sales column header check. --------------------------------------
  const salesHeader = cellPlainText(
    sheet.getCell(input.headerRow, input.salesCol).value,
  );
  if (salesHeader !== input.salesHeaderExpected) {
    throw new WritebackRefusedError(
      `Sales column header at row ${input.headerRow} col ${input.salesCol} ` +
        `is ${JSON.stringify(salesHeader)}, expected ` +
        `${JSON.stringify(input.salesHeaderExpected)}. Refusing to write to ` +
        "a column that doesn't match the requested quarter.",
    );
  }

  // --- 3. EBITDA column header check (with allowlisted typo). -------------
  const ebitdaHeader = cellPlainText(
    sheet.getCell(input.headerRow, input.ebitdaCol).value,
  );
  if (ebitdaHeader === input.ebitdaHeaderExpected) {
    // good
  } else if (
    input.ebitdaHeaderAlternate !== null &&
    ebitdaHeader === input.ebitdaHeaderAlternate
  ) {
    warnings.push(
      `EBITDA column header at row ${input.headerRow} col ${input.ebitdaCol} ` +
        `is ${JSON.stringify(ebitdaHeader)}, the known typo for ` +
        `${JSON.stringify(input.ebitdaHeaderExpected)}. Writing anyway; ` +
        "consider fixing the header in the spreadsheet.",
    );
  } else {
    const altSuffix =
      input.ebitdaHeaderAlternate !== null
        ? ` (or alternate ${JSON.stringify(input.ebitdaHeaderAlternate)})`
        : "";
    throw new WritebackRefusedError(
      `EBITDA column header at row ${input.headerRow} col ${input.ebitdaCol} ` +
        `is ${JSON.stringify(ebitdaHeader)}, expected ` +
        `${JSON.stringify(input.ebitdaHeaderExpected)}${altSuffix}. ` +
        "Refusing to write.",
    );
  }

  // --- 4. Target cells must be empty and must not be formulas. -------------
  const salesCell = sheet.getCell(input.row, input.salesCol);
  const ebitdaCell = sheet.getCell(input.row, input.ebitdaCol);
  for (const [label, cell, col] of [
    ["Sales", salesCell, input.salesCol] as const,
    ["EBITDA", ebitdaCell, input.ebitdaCol] as const,
  ]) {
    if (isFormulaCell(cell)) {
      throw new WritebackRefusedError(
        `${label} target cell (row ${input.row}, col ${col}) contains a ` +
          `formula: ${JSON.stringify(cell.formula ?? cell.value)}. ` +
          "Refusing to overwrite a formula.",
      );
    }
    if (!isCellEmpty(cell)) {
      throw new WritebackRefusedError(
        `${label} target cell (row ${input.row}, col ${col}) already holds ` +
          `the value ${JSON.stringify(cell.value)}. Refusing to overwrite a ` +
          "non-empty cell; clear it first if you really intend to overwrite.",
      );
    }
  }

  // --- 5. Write the values. ----------------------------------------------
  salesCell.value = input.salesValue;
  ebitdaCell.value = input.ebitdaValue;

  // --- 6. Serialize back to bytes. ---------------------------------------
  const out = await wb.xlsx.writeBuffer();
  return { xlsx: new Uint8Array(out), warnings };
}

// Coerce ExcelJS cell values to plain text for header/identity checks.
// Tracker cells may be plain strings, dates, numbers, rich-text arrays,
// formula objects, or hyperlinks; we want the displayed text in all of
// those cases.
function cellPlainText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text ?? "").join("").trim();
    }
    if ("text" in value && typeof value.text === "string") {
      return value.text.trim();
    }
    if ("result" in value && (value as { result?: unknown }).result != null) {
      return cellPlainText((value as { result: ExcelJS.CellValue }).result);
    }
  }
  return "";
}

function isFormulaCell(cell: ExcelJS.Cell): boolean {
  if (cell.formula) return true;
  const v = cell.value;
  if (v && typeof v === "object" && "formula" in v) return true;
  return false;
}

function isCellEmpty(cell: ExcelJS.Cell): boolean {
  const v = cell.value;
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}
