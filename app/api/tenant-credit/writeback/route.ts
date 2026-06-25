// POST /api/tenant-credit/writeback
//
// Batch write-back. The analyst uploads the master tracker plus a list
// of per-tenant entries (one per tenant whose PDF was successfully
// extracted + computed) and we write every cell we can — Sales,
// EBITDA, Interest, Rent, Cash, CFO, Capex per tenant per quarter —
// into a single workbook in one round-trip. Tenants whose entries
// don't carry a value for a given metric (the PDF was income-statement
// only, so Cash/CFO/Capex came back null) get that cell skipped.
//
// Request:
//   multipart/form-data
//     tracker_xlsx:  the master tracker .xlsx the analyst uploaded
//                    earlier (required). The bundled samples/ copy is
//                    no longer used at runtime; the analyst owns the
//                    source of truth.
//     payload:       JSON-encoded request body (string). Schema below.
//
// Payload:
//   {
//     quarter_id: QuarterId,
//     entries: BatchEntry[],
//   }
// where BatchEntry is:
//   {
//     tenant_id: string,            // slug, used as audit key
//     tenant_display_name: string,  // column-A text from the picker
//     tracker_row: number,          // 1-indexed row in Corp Financials
//     // The seven metrics. Each is a finite number to write, or null
//     // to skip that cell. computed by the generic engine.
//     sales:    number | null,
//     ebitda:   number | null,
//     interest: number | null,
//     rent:     number | null,
//     cash:     number | null,
//     cfo:      number | null,
//     capex:    number | null,
//     // Optional audit fields (the dashboard fills these in).
//     source_pdf_filename?: string,
//     source_pdf_hash?: string,
//     source_entity?: string,
//     source_period?: string,
//     line_items?: { label: string; amount: number }[],
//     calculations?: { sales?: AuditCalculationTrace,
//                      ebitda?: AuditCalculationTrace },
//     intercompany_observed?: AuditIntercompany[],
//     unused_labels?: string[],
//     written_by?: string,
//   }
//
// Response 200: xlsx octet-stream. If any tenant fails its
// preconditions (wrong header, formula in target cell, populated
// cell), the whole batch refuses with a 422 listing the failures.
// Either every tenant in the batch writes or none do — the analyst
// gets a clean retry path either way.

import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import {
  ALL_QUARTER_IDS,
  METRIC_LABELS,
  WRITABLE_METRICS,
  trackerColumnsForQuarter,
  type MetricCell,
  type MetricKey,
  type QuarterId,
} from "@/lib/tenant-credit/tracker-layout";
import {
  writeAuditRun,
  type AuditCalculationTrace,
  type AuditIntercompany,
  type AuditNormalization,
} from "@/lib/tenant-credit/audit";

// 8 MB cap on the tracker upload. The corporate-financials master is
// ~200 KB; anything larger is almost certainly the wrong file.
const MAX_TRACKER_BYTES = 8 * 1024 * 1024;

// Number-format strings applied when writing each metric. Matches the
// formats Excel renders on the per-tenant Q1 26 sample cells in the
// bundled tracker, so the written values look identical to data the
// analyst typed in by hand.
const METRIC_NUMBER_FORMATS: Record<MetricKey, string> = {
  sales:    "#,##0",
  ebitda:   "#,##0",
  interest: "#,##0",
  rent:     "#,##0",
  cash:     "#,##0",
  cfo:      "#,##0",
  capex:    "#,##0",
};

export const runtime = "nodejs";
export const maxDuration = 60;

// Default actor recorded in tenant_tracker_runs.written_by until
// Firebase Auth lands; same default as the previous single-tenant
// route used.
const DEFAULT_WRITTEN_BY =
  process.env.AUDIT_DEFAULT_WRITTEN_BY ?? "pending-auth";

function isQuarterId(s: unknown): s is QuarterId {
  return typeof s === "string" && (ALL_QUARTER_IDS as string[]).includes(s);
}

// The tenant-substring check guards against silently writing into the
// wrong row. We use the first whitespace/comma-separated token of the
// display name; that's the most stable piece across column-A spelling
// drift ("Pinnacle Oil & Gas Holdings, Inc" vs "Pinnacle Oil & Gas
// Holdings, Inc." both pass when the substring is "Pinnacle").
function tenantNameSubstring(tenantName: string): string {
  return tenantName.split(/[\s,]+/, 1)[0] ?? tenantName;
}

function timestamp(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

// Cast helpers preserve the audit defaults the previous route used.
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

// Per-tenant cell write summary fed to both the audit log and the
// response envelope so the analyst can see which cells actually moved.
type WrittenCells = Partial<Record<MetricKey, number>>;

type BatchEntry = {
  tenant_id: string;
  tenant_display_name: string;
  tracker_row: number;
  values: Partial<Record<MetricKey, number>>;
  audit: Parameters<typeof writeAuditRun>[0];
};

export async function POST(req: Request) {
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
      {
        error: "Missing or invalid `tracker_xlsx` field. Must be an .xlsx upload.",
      },
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
  const p = body as Record<string, unknown>;
  if (!isQuarterId(p.quarter_id)) {
    return NextResponse.json(
      {
        error:
          `Missing or invalid \`quarter_id\`. Known: [${ALL_QUARTER_IDS.join(", ")}].`,
      },
      { status: 400 },
    );
  }
  if (!Array.isArray(p.entries) || p.entries.length === 0) {
    return NextResponse.json(
      {
        error: "`entries` must be a non-empty array of tenant write entries.",
      },
      { status: 400 },
    );
  }
  const quarterId = p.quarter_id;

  // Parse and validate every entry up front. A single bad entry kills
  // the batch — the analyst should fix it and retry; partial writes
  // would leave the tracker in an ambiguous state.
  const entries: BatchEntry[] = [];
  for (const [i, raw] of p.entries.entries()) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json(
        { error: `entries[${i}] must be an object.` },
        { status: 400 },
      );
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.tenant_id !== "string" || !o.tenant_id) {
      return NextResponse.json(
        { error: `entries[${i}] is missing tenant_id.` },
        { status: 400 },
      );
    }
    if (typeof o.tenant_display_name !== "string" || !o.tenant_display_name) {
      return NextResponse.json(
        { error: `entries[${i}] is missing tenant_display_name.` },
        { status: 400 },
      );
    }
    if (
      typeof o.tracker_row !== "number" ||
      !Number.isInteger(o.tracker_row) ||
      o.tracker_row < 1
    ) {
      return NextResponse.json(
        { error: `entries[${i}].tracker_row must be a positive integer.` },
        { status: 400 },
      );
    }
    const values: Partial<Record<MetricKey, number>> = {};
    for (const metric of WRITABLE_METRICS) {
      const v = o[metric];
      if (v == null) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return NextResponse.json(
          { error: `entries[${i}].${metric} must be a finite number or null.` },
          { status: 400 },
        );
      }
      values[metric] = v;
    }
    if (Object.keys(values).length === 0) {
      return NextResponse.json(
        {
          error:
            `entries[${i}] has no metric values to write; ` +
            "every metric was null. Drop the entry instead.",
        },
        { status: 400 },
      );
    }

    const calculations = (o.calculations ?? {}) as Record<string, unknown>;
    const audit: Parameters<typeof writeAuditRun>[0] = {
      tenant_id: o.tenant_id,
      quarter: quarterId,
      source_pdf_filename: asString(o.source_pdf_filename),
      source_pdf_hash: asString(o.source_pdf_hash),
      source_entity: asString(o.source_entity),
      source_period: asString(o.source_period),
      computed_sales: values.sales ?? 0,
      computed_ebitda: values.ebitda ?? 0,
      intercompany_observed: asObjectArray<AuditIntercompany>(
        o.intercompany_observed,
      ),
      normalization_applied: asObjectArray<AuditNormalization>(
        o.normalization_applied,
      ),
      passed_through: asStringArray(o.passed_through),
      unused_labels: asStringArray(o.unused_labels),
      line_items: asObjectArray<{ label: string; amount: number }>(
        o.line_items,
      ),
      calculations: {
        sales: asCalculationTrace(calculations.sales),
        ebitda: asCalculationTrace(calculations.ebitda),
      },
      status: "writeback_success",  // patched below per-tenant
      worker_warnings: [],          // ditto
      error: null,
      written_by: asString(o.written_by, DEFAULT_WRITTEN_BY),
      written_filename: "",         // patched once we know the filename
    };
    entries.push({
      tenant_id: o.tenant_id,
      tenant_display_name: o.tenant_display_name,
      tracker_row: o.tracker_row,
      values,
      audit,
    });
  }

  const target = trackerColumnsForQuarter(quarterId);

  // Parse the workbook once, apply every tenant's writes to it, then
  // serialize once. ExcelJS's typings want a plain ArrayBuffer on
  // load(), not the Node Buffer alias.
  const xlsxBuffer = await trackerFile.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(xlsxBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not parse the uploaded tracker: ${msg}` },
      { status: 400 },
    );
  }
  const sheet = wb.getWorksheet(target.sheet_name);
  if (!sheet) {
    const seen = wb.worksheets.map((w) => `"${w.name}"`).join(", ");
    return NextResponse.json(
      {
        error:
          `Tracker is missing the "${target.sheet_name}" sheet ` +
          `(trailing space matters). Sheets seen: [${seen}].`,
      },
      { status: 422 },
    );
  }

  // First pass: verify every cell every entry wants to touch is safe
  // to write (right header, empty, not a formula). If anything fails,
  // we refuse the whole batch. Collect failures so the analyst sees
  // them all in one response.
  const failures: { entry: BatchEntry; reasons: string[] }[] = [];
  const warnings: { entry: BatchEntry; messages: string[] }[] = [];
  for (const entry of entries) {
    const reasons: string[] = [];
    const entryWarnings: string[] = [];

    // Tenant identity check on column A.
    const nameText = cellPlainText(sheet.getCell(entry.tracker_row, 1).value);
    const needle = tenantNameSubstring(entry.tenant_display_name);
    if (!nameText.toLowerCase().includes(needle.toLowerCase())) {
      reasons.push(
        `row ${entry.tracker_row} column A is "${nameText}", which does not ` +
          `contain expected tenant substring "${needle}". The picker may be ` +
          "out of sync with the uploaded tracker.",
      );
    }
    // Header + cell checks per metric we intend to write.
    for (const metric of WRITABLE_METRICS) {
      if (entry.values[metric] == null) continue;
      const cell = target.cells.find((c) => c.metric === metric);
      if (!cell) continue;
      const headerCheck = verifyHeader(sheet, target.header_row, cell);
      if (headerCheck.kind === "fail") {
        reasons.push(headerCheck.message);
        continue;
      }
      if (headerCheck.kind === "warn") {
        entryWarnings.push(headerCheck.message);
      }
      const targetCell = sheet.getCell(entry.tracker_row, cell.col);
      if (isFormulaCell(targetCell)) {
        reasons.push(
          `${METRIC_LABELS[metric]} target cell ` +
            `(row ${entry.tracker_row}, col ${cell.col}) holds a formula. ` +
            "Refusing to overwrite.",
        );
        continue;
      }
      if (!isCellEmpty(targetCell)) {
        reasons.push(
          `${METRIC_LABELS[metric]} target cell ` +
            `(row ${entry.tracker_row}, col ${cell.col}) already holds ` +
            `${JSON.stringify(targetCell.value)}. Clear it first if you really ` +
            "intend to overwrite.",
        );
      }
    }

    if (reasons.length > 0) failures.push({ entry, reasons });
    if (entryWarnings.length > 0) warnings.push({ entry, messages: entryWarnings });
  }

  if (failures.length > 0) {
    return NextResponse.json(
      {
        error:
          "Batch refused: one or more tenants failed precondition checks. " +
          "Fix and retry; no cells were written.",
        failures: failures.map((f) => ({
          tenant_display_name: f.entry.tenant_display_name,
          tracker_row: f.entry.tracker_row,
          reasons: f.reasons,
        })),
      },
      { status: 422 },
    );
  }

  // Second pass: write. Every entry passed; this is the commit phase.
  const writtenSummary: { tenant_id: string; cells: WrittenCells }[] = [];
  for (const entry of entries) {
    const cells: WrittenCells = {};
    for (const metric of WRITABLE_METRICS) {
      const value = entry.values[metric];
      if (value == null) continue;
      const target_cell = target.cells.find((c) => c.metric === metric);
      if (!target_cell) continue;
      const xlsxCell = sheet.getCell(entry.tracker_row, target_cell.col);
      xlsxCell.value = value;
      xlsxCell.numFmt = METRIC_NUMBER_FORMATS[metric];
      cells[metric] = value;
    }
    writtenSummary.push({ tenant_id: entry.tenant_id, cells });
  }

  const out = await wb.xlsx.writeBuffer();
  const newXlsx = new Uint8Array(out);
  const filename = `Corporate_Financials_and_P_Ls_${quarterId}_${timestamp()}.xlsx`;

  // Audit each tenant's run BEFORE returning. Each entry gets its own
  // tenant_tracker_runs document; warnings collected for the entry
  // ride along on worker_warnings. The whole batch refuses if Firestore
  // is configured AND any audit write fails — same correctness rule as
  // the per-tenant route used.
  for (const entry of entries) {
    const entryWarnings =
      warnings
        .find((w) => w.entry.tenant_id === entry.tenant_id)
        ?.messages ?? [];
    try {
      await writeAuditRun({
        ...entry.audit,
        worker_warnings: entryWarnings,
        written_filename: filename,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          error:
            `Wrote ${filename} but the audit-log write to Firestore failed ` +
            `for "${entry.tenant_display_name}": ${msg}. Re-run after ` +
            "fixing Firestore; the master tracker was not modified.",
        },
        { status: 500 },
      );
    }
  }

  // Aggregate warnings into the X-Worker-Warnings header so the
  // existing client-side toast logic still surfaces them.
  const headerWarnings = warnings.flatMap((w) =>
    w.messages.map((m) => `[${w.entry.tenant_display_name}] ${m}`),
  );
  const headers = new Headers({
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Tenant-Credit-Write-Summary": JSON.stringify(writtenSummary),
  });
  if (headerWarnings.length > 0) {
    headers.set("X-Worker-Warnings", JSON.stringify(headerWarnings));
  }

  return new Response(newXlsx, { status: 200, headers });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

type HeaderCheck =
  | { kind: "ok" }
  | { kind: "warn"; message: string }
  | { kind: "fail"; message: string };

function verifyHeader(
  sheet: ExcelJS.Worksheet,
  headerRow: number,
  cell: MetricCell,
): HeaderCheck {
  const actual = cellPlainText(sheet.getCell(headerRow, cell.col).value);
  if (actual === cell.header_expected) return { kind: "ok" };
  if (cell.header_alternate !== null && actual === cell.header_alternate) {
    return {
      kind: "warn",
      message:
        `${METRIC_LABELS[cell.metric]} column header at row ${headerRow} ` +
        `col ${cell.col} is "${actual}", the known typo for ` +
        `"${cell.header_expected}". Writing anyway.`,
    };
  }
  const altSuffix =
    cell.header_alternate !== null
      ? ` (or alternate "${cell.header_alternate}")`
      : "";
  return {
    kind: "fail",
    message:
      `${METRIC_LABELS[cell.metric]} column header at row ${headerRow} ` +
      `col ${cell.col} is "${actual}", expected "${cell.header_expected}"` +
      `${altSuffix}. Refusing to write to a column that doesn't match.`,
  };
}

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
