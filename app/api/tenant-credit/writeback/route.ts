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
//     source_units?: string,
//     source_units_evidence?: string,
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
import { cookies } from "next/headers";
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";

import { COOKIE_NAME, parseSessionCookie } from "@/lib/auth-session";
import {
  ALL_QUARTER_IDS,
  METRIC_LABELS,
  WRITABLE_METRICS,
  type MetricCell,
  type MetricKey,
  type QuarterId,
} from "@/lib/tenant-credit/tracker-layout";
import { computeGeneric, type ComputeResult } from "@/lib/tenant-credit/generic-methodology";
import {
  mergeLineItems,
  type MergeExtract,
} from "@/lib/tenant-credit/merge-line-items";
import type { LineItem } from "@/lib/tenant-credit/methodology";
import { patchWorkbookCells, type OoxmlCellPatch } from "@/lib/tenant-credit/ooxml-writeback";
import {
  parseSourcePeriod,
  periodInsideQuarter,
  type SourceDocumentType,
  type SourceScopeType,
} from "@/lib/tenant-credit/source-period";
import {
  cellExactText,
  resolveTrackerTarget,
  TARGET_SHEET_NAME,
} from "@/lib/tenant-credit/tracker-target";
import {
  entityLooksLikeTenant,
  tenantIdentity,
} from "@/lib/tenant-credit/tenant-identity";
import { amountMatchesSourceUnits } from "@/lib/tenant-credit/source-units";
import { stripExcelCommentsForExcelJs } from "@/lib/tenant-credit/xlsx-sanitize";
import {
  finalizeAuditRuns,
  writeAuditRun,
  type AuditCalculationTrace,
  type AuditExcludedSourceFile,
  type AuditNormalization,
  type AuditSourceFile,
  type AuditWrittenCell,
} from "@/lib/tenant-credit/audit";

// 8 MB cap on the tracker upload. The corporate-financials master is
// ~200 KB; anything larger is almost certainly the wrong file.
const MAX_TRACKER_BYTES = 8 * 1024 * 1024;

export const runtime = "nodejs";
export const maxDuration = 60;

async function currentAuditActor(analystName: string): Promise<string | null> {
  if (process.env.AUDIT_DEFAULT_WRITTEN_BY) {
    return process.env.AUDIT_DEFAULT_WRITTEN_BY;
  }
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    const cookieStore = await cookies();
    const parsed = await parseSessionCookie(
      cookieStore.get(COOKIE_NAME)?.value,
      secret,
    );
    if (parsed) return `session:${parsed.id}`;
  }
  const trimmed = analystName.trim().replace(/\s+/g, " ");
  if (trimmed.length >= 2 && trimmed.length <= 100) {
    return `analyst:${trimmed}`;
  }
  return null;
}

function isQuarterId(s: unknown): s is QuarterId {
  return typeof s === "string" && (ALL_QUARTER_IDS as string[]).includes(s);
}

// Server-side row identity check. The UI sends the row number, but the
// workbook is the source of truth: rederive the same slug from column A
// and require it to match the payload tenant_id. This catches substring
// collisions such as "Pinnacle ..." vs "Pinnacle Services ...".
// Does the entity name Claude read off the actual statement resemble the
// tenant we're about to write into? This is NOT the same check as
// tenantNameSubstring above — that one re-derives its expected value from
// the SAME tracker upload the picker came from, so it can only catch a
// stale/out-of-sync tracker, never the wrong PDF attached to the right
// tenant row. Most real tenant filenames don't contain the tenant's name
// at all, so that assignment is manual (Triage picker) and this is the
// one check that looks at what was actually extracted. Soft only —
// legal-entity names drift too much (subsidiaries, DBAs, recently
// acquired properties still showing the seller's name) to hard-refuse on.
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
function asObjectArray<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

function isSourceDocumentType(value: unknown): value is SourceDocumentType {
  return (
    value === "income_statement" ||
    value === "balance_sheet" ||
    value === "cash_flow_statement" ||
    value === "combined_financial_statements" ||
    value === "other"
  );
}

function isSourceScopeType(value: unknown): value is SourceScopeType {
  return (
    value === "entity_wide" ||
    value === "component_subset" ||
    value === "single_component" ||
    value === "unknown"
  );
}

function asLineItems(value: unknown): MergeExtract["line_items"] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: MergeExtract["line_items"] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.label !== "string" ||
      record.label.trim() === "" ||
      typeof record.printed_amount !== "number" ||
      !Number.isFinite(record.printed_amount) ||
      typeof record.amount !== "number" ||
      !Number.isFinite(record.amount) ||
      typeof record.source_reference !== "string" ||
      record.source_reference.trim() === ""
    ) {
      return null;
    }
    items.push({
      label: record.label,
      printed_amount: record.printed_amount,
      amount: record.amount,
      source_reference: record.source_reference,
    });
  }
  return items;
}

type PacketExtract = MergeExtract & { level: "tenant" | "corporate" };

function asPacketExtracts(value: unknown): PacketExtract[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const extracts: PacketExtract[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const source = item as Record<string, unknown>;
    const level = source.level;
    const sourceUnits = source.source_units;
    if (level !== "tenant" && level !== "corporate") return null;
    if (!isSourceDocumentType(source.document_type)) return null;
    if (!isSourceScopeType(source.source_scope_type)) return null;
    if (
      sourceUnits !== "dollars" &&
      sourceUnits !== "thousands" &&
      sourceUnits !== "millions"
    ) {
      return null;
    }
    if (
      source.period_selection !== "printed_quarter_total" &&
      source.period_selection !== "summed_months" &&
      source.period_selection !== "single_period_column" &&
      source.period_selection !== "point_in_time"
    ) {
      return null;
    }
    if (
      !Array.isArray(source.source_scope_identifiers) ||
      source.source_scope_identifiers.some(
        (identifier) =>
          typeof identifier !== "string" || identifier.trim() === "",
      )
    ) {
      return null;
    }
    if (
      (source.source_scope_type === "component_subset" ||
        source.source_scope_type === "single_component") &&
      source.source_scope_identifiers.length === 0
    ) {
      return null;
    }
    const lineItems = asLineItems(source.line_items);
    if (!lineItems) return null;
    if (
      lineItems.some(
        (item) =>
          !amountMatchesSourceUnits(
            item.printed_amount,
            item.amount,
            sourceUnits,
          ),
      )
    ) {
      return null;
    }
    const parsed: PacketExtract = {
      source_filename: asString(source.source_filename),
      source_file_hash: asString(source.source_file_hash),
      source_entity: asString(source.source_entity),
      source_period: asString(source.source_period),
      source_units: sourceUnits,
      source_units_evidence: asString(source.source_units_evidence),
      document_type: source.document_type,
      source_scope: asString(source.source_scope),
      source_scope_type: source.source_scope_type,
      source_scope_identifiers: source.source_scope_identifiers as string[],
      period_selection: source.period_selection,
      line_items: lineItems,
      level,
      // Optional per-file analyst override (see extract route + merge
      // layer). Empty string means "no override" — mergeLineItems
      // treats a falsy value identically to the field being absent.
      period_override_reason: asString(source.period_override_reason),
    };
    if (
      !parsed.source_filename ||
      !/^[a-f0-9]{64}$/.test(parsed.source_file_hash) ||
      !parsed.source_entity ||
      !parsed.source_period ||
      !parsed.source_scope ||
      !parsed.source_units_evidence
    ) {
      return null;
    }
    extracts.push(parsed);
  }
  return extracts;
}

function asExcludedSourceFiles(value: unknown): AuditExcludedSourceFile[] {
  if (!Array.isArray(value)) return [];
  const result: AuditExcludedSourceFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const parsed = {
      filename: asString(source.filename),
      file_hash: asString(source.file_hash),
      source_period: asString(source.source_period),
      reason: asString(source.reason),
    };
    if (
      parsed.filename &&
      /^[a-f0-9]{64}$/.test(parsed.file_hash) &&
      parsed.source_period &&
      parsed.reason
    ) {
      result.push(parsed);
    }
  }
  return result;
}

function traceToAudit(trace: ComputeResult["metrics"][MetricKey]): AuditCalculationTrace {
  return {
    formula: trace.formula,
    inputs: trace.contributions.map((item) => ({
      label: item.label,
      amount_source: item.amount_source,
      amount_tracker: item.amount_tracker,
      reason: item.reason,
    })),
    total_tracker_unrounded: trace.total_tracker_unrounded,
    result: trace.result_tracker ?? 0,
  };
}

// Mirrors the entity-mismatch override warning below: when an extract
// carries a period_override_reason AND its own period genuinely doesn't
// match the selected quarter (or can't be parsed at all), record an
// explicit "Period mismatch approved" note so a later reviewer of the
// audit trail sees the override rather than nothing. An override
// reason on an extract whose period DOES match the quarter (a no-op
// override) produces no warning — there was nothing to approve.
function periodOverrideWarning(
  extract: PacketExtract,
  quarterId: QuarterId,
): string | null {
  if (!extract.period_override_reason) return null;
  const parsed = parseSourcePeriod(extract.source_period);
  const matches = parsed !== null && periodInsideQuarter(parsed, quarterId);
  if (matches) return null;
  const quarterLabel = quarterId.replace("_", " ");
  return (
    `Period mismatch approved: ${extract.period_override_reason}. ` +
    `Extracted period: ${extract.source_period}, selected quarter: ${quarterLabel}.`
  );
}

function sha256(value: ArrayBuffer | Uint8Array | string): string {
  const hash = createHash("sha256");
  if (typeof value === "string") hash.update(value);
  else if (value instanceof Uint8Array) hash.update(value);
  else hash.update(Buffer.from(value));
  return hash.digest("hex");
}

function exactArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

function auditCellValue(value: ExcelJS.CellValue): string | number | boolean | null {
  if (value == null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return cellPlainText(value);
}

// Per-tenant cell write summary fed to both the audit log and the
// response envelope so the analyst can see which cells actually moved.
type WrittenCells = Partial<Record<MetricKey, number>>;

type BatchEntry = {
  tenant_id: string;
  tenant_display_name: string;
  tracker_row: number;
  values: Partial<Record<MetricKey, number>>;
  source_files: AuditSourceFile[];
  source_warnings: string[];
  entity_override_reason: string;
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
  const writtenBy = await currentAuditActor(asString(p.analyst_name));
  if (!writtenBy) {
    return NextResponse.json(
      {
        error:
          "Analyst name is required because this deployment has no authenticated session.",
      },
      { status: 400 },
    );
  }

  // Parse and validate every entry up front. A single bad entry kills
  // the batch — the analyst should fix it and retry; partial writes
  // would leave the tracker in an ambiguous state.
  const entries: BatchEntry[] = [];
  const seenRows = new Set<number>();
  const seenTenantIds = new Set<string>();
  const sourceHashOwners = new Map<string, string>();
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
    if (seenRows.has(o.tracker_row) || seenTenantIds.has(o.tenant_id)) {
      return NextResponse.json(
        {
          error:
            `entries[${i}] duplicates tracker row ${o.tracker_row} or tenant ` +
            `id "${o.tenant_id}". Each target may appear once.`,
        },
        { status: 400 },
      );
    }
    seenRows.add(o.tracker_row);
    seenTenantIds.add(o.tenant_id);

    const packetExtracts = asPacketExtracts(o.extracts);
    if (!packetExtracts) {
      return NextResponse.json(
        {
          error:
            `entries[${i}].extracts must contain the complete validated ` +
            "per-file extraction packet.",
        },
        { status: 400 },
      );
    }
    for (const extract of packetExtracts) {
      const owner = sourceHashOwners.get(extract.source_file_hash);
      if (owner) {
        return NextResponse.json(
          {
            error:
              `${extract.source_filename} is attached to both ${owner} and ` +
              `${o.tenant_display_name}. The same source file cannot feed two tenants.`,
          },
          { status: 422 },
        );
      }
      sourceHashOwners.set(extract.source_file_hash, o.tenant_display_name);
    }
    let merged: ReturnType<typeof mergeLineItems>;
    try {
      merged = mergeLineItems(packetExtracts, quarterId);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            `entries[${i}] source packet is ambiguous: ` +
            (error instanceof Error ? error.message : String(error)),
        },
        { status: 422 },
      );
    }
    const lineItems: LineItem[] = merged.merged;
    let computed: ComputeResult;
    try {
      computed = computeGeneric(lineItems);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            `entries[${i}] failed server-side computation: ` +
            (error instanceof Error ? error.message : String(error)),
        },
        { status: 422 },
      );
    }
    if (computed.sales == null || computed.ebitda == null) {
      return NextResponse.json(
        {
          error:
            `entries[${i}] is incomplete: Sales and EBITDA are required ` +
            "before writeback.",
        },
        { status: 422 },
      );
    }

    const values: Partial<Record<MetricKey, number>> = {};
    for (const metric of WRITABLE_METRICS) {
      const supplied = o[metric];
      const serverValue = computed[metric];
      if (
        supplied != null &&
        (typeof supplied !== "number" || !Number.isFinite(supplied))
      ) {
        return NextResponse.json(
          { error: `entries[${i}].${metric} must be a finite number or null.` },
          { status: 400 },
        );
      }
      if (supplied !== undefined && supplied !== serverValue) {
        return NextResponse.json(
          {
            error:
              `entries[${i}].${metric}=${String(supplied)} does not match ` +
              `server recomputation ${String(serverValue)}.`,
          },
          { status: 422 },
        );
      }
      if (serverValue != null) values[metric] = serverValue;
    }
    const includedHashes = new Set(
      merged.includedExtracts.map((extract) => extract.source_file_hash),
    );
    const exclusionReasons = new Map(
      merged.excludedExtracts.map(({ extract, reason }) => [
        extract.source_file_hash,
        reason,
      ]),
    );
    const sourceFiles: AuditSourceFile[] = packetExtracts.map((extract) => ({
      filename: extract.source_filename,
      file_hash: extract.source_file_hash,
      source_entity: extract.source_entity,
      source_period: extract.source_period,
      source_units: extract.source_units,
      source_units_evidence: extract.source_units_evidence,
      document_type: extract.document_type,
      source_scope: extract.source_scope,
      source_scope_type: extract.source_scope_type,
      source_scope_identifiers: extract.source_scope_identifiers,
      period_selection: extract.period_selection,
      level: extract.level,
      included_in_compute: includedHashes.has(extract.source_file_hash),
      exclusion_reason: exclusionReasons.get(extract.source_file_hash) ?? "",
    }));
    const excludedSourceFiles = asExcludedSourceFiles(o.excluded_files);

    const calculations = Object.fromEntries(
      WRITABLE_METRICS.map((metric) => [
        metric,
        traceToAudit(computed.metrics[metric]),
      ]),
    ) as Record<MetricKey, AuditCalculationTrace>;
    const computedMetrics = Object.fromEntries(
      WRITABLE_METRICS.map((metric) => [metric, computed[metric]]),
    ) as Record<MetricKey, number | null>;
    const audit: Parameters<typeof writeAuditRun>[0] = {
      idempotency_key: "",
      run_group_id: "",
      tenant_id: o.tenant_id,
      quarter: quarterId,
      source_pdf_filename: sourceFiles.map((source) => source.filename).join(", "),
      source_pdf_hash: sourceFiles.map((source) => source.file_hash).join(","),
      source_entity: sourceFiles.map((source) => source.source_entity).join("; "),
      source_period: sourceFiles.map((source) => source.source_period).join("; "),
      source_units: [...new Set(sourceFiles.map((source) => source.source_units))].join(","),
      source_units_evidence: sourceFiles
        .map((source) => source.source_units_evidence)
        .join("; "),
      computed_sales: computed.sales,
      computed_ebitda: computed.ebitda,
      computed_metrics: computedMetrics,
      source_files: sourceFiles,
      excluded_source_files: excludedSourceFiles,
      input_workbook_hash: "",
      output_workbook_hash: "",
      written_cells: [],
      intercompany_observed: computed.intercompany_observed.map((observation) => ({
        ...observation,
        net_effect_on_ebitda_source: 0,
      })),
      normalization_applied: asObjectArray<AuditNormalization>(
        o.normalization_applied,
      ),
      passed_through: packetExtracts.flatMap((extract) =>
        extract.line_items.map((item) => item.label),
      ),
      unused_labels: computed.unused_labels,
      line_items: packetExtracts.flatMap((extract) =>
        extract.line_items.map((item) => ({
          ...item,
          source_reference: `${extract.source_filename}: ${item.source_reference}`,
          source_filename: extract.source_filename,
          source_file_hash: extract.source_file_hash,
          included_in_compute: includedHashes.has(extract.source_file_hash),
        })),
      ),
      calculations,
      status: "writeback_pending",
      worker_warnings: [],
      error: null,
      written_by: writtenBy,
      written_filename: "",
    };
    entries.push({
      tenant_id: o.tenant_id,
      tenant_display_name: o.tenant_display_name,
      tracker_row: o.tracker_row,
      values,
      source_files: sourceFiles,
      source_warnings: [
        ...merged.excludedExtracts.map(({ extract, reason }) =>
          `${extract.source_filename}: ${reason}`,
        ),
        ...merged.conflicts,
        ...excludedSourceFiles.map(
          (source) => `${source.filename}: excluded (${source.reason})`,
        ),
        ...packetExtracts
          .map((extract) => periodOverrideWarning(extract, quarterId))
          .filter((warning): warning is string => warning !== null),
      ],
      entity_override_reason: asString(o.entity_override_reason),
      audit,
    });
  }

  // ExcelJS validates the workbook and target cells. The output writer
  // patches the original OOXML package so unsupported workbook parts are
  // preserved rather than reserialized by ExcelJS.
  const xlsxBuffer = await trackerFile.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  try {
    const sanitized = stripExcelCommentsForExcelJs(xlsxBuffer);
    await wb.xlsx.load(sanitized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not parse the uploaded tracker: ${msg}` },
      { status: 400 },
    );
  }
  const sheet = wb.getWorksheet(TARGET_SHEET_NAME);
  if (!sheet) {
    const seen = wb.worksheets.map((w) => `"${w.name}"`).join(", ");
    return NextResponse.json(
      {
        error:
          `Tracker is missing the "${TARGET_SHEET_NAME}" sheet ` +
          `(trailing space matters). Sheets seen: [${seen}].`,
      },
      { status: 422 },
    );
  }
  let target: ReturnType<typeof resolveTrackerTarget>;
  try {
    target = resolveTrackerTarget(sheet, quarterId);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not resolve tracker columns.",
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

    // Tenant identity check on column A. This proves the picker and the
    // CURRENT tracker upload still agree on the exact row target. It
    // cannot catch the wrong PDF attached to the right tenant row (see
    // entityLooksLikeTenant below for that).
    const nameText = cellPlainText(sheet.getCell(entry.tracker_row, 1).value);
    const actualSlug = tenantIdentity(nameText);
    const expectedSlug = tenantIdentity(entry.tenant_display_name);
    const payloadSlug = tenantIdentity(entry.tenant_id);
    if (
      actualSlug !== expectedSlug ||
      (payloadSlug !== "" && payloadSlug !== expectedSlug)
    ) {
      reasons.push(
        `row ${entry.tracker_row} column A is "${nameText}", which normalizes ` +
          `to "${actualSlug}", but the payload targets ` +
          `"${entry.tenant_display_name}" (${expectedSlug}) with tenant_id ` +
          `"${entry.tenant_id}" (${payloadSlug}). The picker may be out of ` +
          "sync with the uploaded tracker.",
      );
    }

    // Source-entity check: the one defense against a mis-assigned file
    // in Triage. Soft (warning, not refusal) — see entityLooksLikeTenant.
    const mismatchedSources = entry.source_files.filter(
      (source) =>
        source.included_in_compute &&
        !entityLooksLikeTenant(source.source_entity, entry.tenant_display_name),
    );
    if (mismatchedSources.length > 0 && !entry.entity_override_reason) {
      reasons.push(
        `Source entities ${mismatchedSources
          .map((source) => `"${source.source_entity}" (${source.filename})`)
          .join(", ")} do not match tenant "${entry.tenant_display_name}". ` +
          "Review the assignment and explicitly approve the mismatch.",
      );
    } else if (mismatchedSources.length > 0) {
      entryWarnings.push(
        `Entity mismatch approved: ${entry.entity_override_reason}. Sources: ` +
          mismatchedSources.map((source) => source.source_entity).join(", "),
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
      if (targetCell.isMerged) {
        reasons.push(
          `${METRIC_LABELS[metric]} target cell ${targetCell.address} is merged. ` +
            "Refusing ambiguous write.",
        );
        continue;
      }
      if (isFormulaCell(targetCell)) {
        reasons.push(
          `${METRIC_LABELS[metric]} target cell ` +
            `(row ${entry.tracker_row}, col ${cell.col}) holds a formula. ` +
            "Refusing to overwrite.",
        );
        continue;
      }
      if (!isCellEmpty(targetCell)) {
        // Non-empty target is no longer a hard refusal. The analyst
        // usually wants to overwrite (re-running with corrected data),
        // and forcing them to clear cells by hand each time made the
        // tool unusable for normal iteration. The audit log captures
        // every write, so a wrong overwrite is recoverable. Formulas
        // are still refused unconditionally above; THIS branch is for
        // analyst-entered or prior-run literal values.
        entryWarnings.push(
          `${METRIC_LABELS[metric]} cell at row ${entry.tracker_row} col ` +
            `${cell.col} replaced ${JSON.stringify(targetCell.value)} with ` +
            `${entry.values[metric]}.`,
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

  // Build a patch list from the validated target addresses. The patcher edits
  // only worksheet values plus workbook recalculation flags; comments,
  // external links, styles, drawings, and every other OOXML part stay intact.
  const patches: OoxmlCellPatch[] = [];
  const writtenSummary: { tenant_id: string; cells: WrittenCells }[] = [];
  const writtenAudit = new Map<string, AuditWrittenCell[]>();
  for (const entry of entries) {
    const cells: WrittenCells = {};
    const auditCells: AuditWrittenCell[] = [];
    for (const metric of WRITABLE_METRICS) {
      const value = entry.values[metric];
      if (value == null) continue;
      const targetCell = target.cells.find((cell) => cell.metric === metric);
      if (!targetCell) continue;
      const workbookCell = sheet.getCell(entry.tracker_row, targetCell.col);
      patches.push({ address: workbookCell.address, value });
      cells[metric] = value;
      auditCells.push({
        metric,
        address: workbookCell.address,
        previous_value: auditCellValue(workbookCell.value),
        new_value: value,
      });
    }
    writtenSummary.push({ tenant_id: entry.tenant_id, cells });
    writtenAudit.set(entry.tenant_id, auditCells);
  }

  let newXlsx: Uint8Array;
  try {
    newXlsx = patchWorkbookCells(xlsxBuffer, TARGET_SHEET_NAME, patches);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          "Workbook patch failed before any file was returned: " +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 422 },
    );
  }

  // Re-open the generated package and prove every requested address contains
  // exactly the server-computed number before recording a successful audit.
  try {
    const verifyWorkbook = new ExcelJS.Workbook();
    const verifyBytes = stripExcelCommentsForExcelJs(exactArrayBuffer(newXlsx));
    await verifyWorkbook.xlsx.load(verifyBytes);
    const verifySheet = verifyWorkbook.getWorksheet(TARGET_SHEET_NAME);
    if (!verifySheet) throw new Error(`Output lost sheet "${TARGET_SHEET_NAME}".`);
    for (const patch of patches) {
      const cell = verifySheet.getCell(patch.address);
      if (isFormulaCell(cell) || cell.value !== patch.value) {
        throw new Error(
          `${patch.address} verified as ${JSON.stringify(cell.value)}, ` +
            `expected ${patch.value}.`,
        );
      }
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          "Generated workbook failed post-write verification and was not returned: " +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 500 },
    );
  }

  const inputWorkbookHash = sha256(xlsxBuffer);
  const outputWorkbookHash = sha256(newXlsx);
  const runGroupId = sha256(
    JSON.stringify({
      version: 1,
      quarter_id: quarterId,
      input_workbook_hash: inputWorkbookHash,
      entries: entries.map((entry) => ({
        tenant_id: entry.tenant_id,
        tracker_row: entry.tracker_row,
        values: entry.values,
        source_hashes: entry.source_files.map((source) => source.file_hash),
      })),
    }),
  );
  const filename = `Corporate_Financials_and_P_Ls_${quarterId}_${timestamp()}.xlsx`;

  // Persist every tenant as pending before the response is allowed to carry
  // workbook bytes. Production treats missing Firestore configuration as a
  // hard failure. A deterministic ID makes a client/network retry overwrite
  // the same run rather than inventing duplicate audit history.
  const pendingSettled = await Promise.allSettled(
    entries.map(async (entry) => {
      const entryWarnings =
        warnings.find((warning) => warning.entry.tenant_id === entry.tenant_id)
          ?.messages ?? [];
      const idempotencyKey = sha256(`${runGroupId}:${entry.tenant_id}`);
      entry.audit = {
        ...entry.audit,
        idempotency_key: idempotencyKey,
        run_group_id: runGroupId,
        input_workbook_hash: inputWorkbookHash,
        output_workbook_hash: outputWorkbookHash,
        written_cells: writtenAudit.get(entry.tenant_id) ?? [],
        worker_warnings: [...entry.source_warnings, ...entryWarnings],
        written_filename: filename,
        status: "writeback_pending",
      };
      return { id: await writeAuditRun(entry.audit) };
    }),
  );
  const auditedEntries = entries.map((entry, index) => ({
    entry,
    result: pendingSettled[index],
  }));
  const auditFailures = auditedEntries.filter(
    ({ result }) => result.status === "rejected",
  );

  if (auditFailures.length > 0) {
    const pendingIds = auditedEntries.flatMap(({ result }) =>
      result.status === "fulfilled" && result.value.id ? [result.value.id] : [],
    );
    const reasons = auditFailures.map(({ entry, result }) => {
      const cause = (result as PromiseRejectedResult).reason;
      const detail = cause instanceof Error ? cause.message : String(cause);
      return `${entry.tenant_display_name}: ${detail}`;
    });
    try {
      await finalizeAuditRuns(pendingIds, "writeback_failed", reasons.join("; "));
    } catch {
      // The parent documents remain visibly pending, never falsely successful.
    }
    return NextResponse.json(
      {
        error:
          "Audit logging failed; the generated workbook was not returned and " +
          `the uploaded tracker is unchanged. ${reasons.join("; ")}`,
      },
      { status: 500 },
    );
  }

  const auditIds = auditedEntries.flatMap(({ result }) =>
    result.status === "fulfilled" && result.value.id ? [result.value.id] : [],
  );
  const noAuditTrail = auditIds.length !== entries.length;
  try {
    await finalizeAuditRuns(auditIds, "writeback_success", null);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          "The audit records could not be finalized, so the workbook was not " +
          "returned. Firestore records remain pending. " +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 500 },
    );
  }

  // Aggregate warnings into the X-Worker-Warnings header so the
  // existing client-side toast logic still surfaces them.
  const headerWarnings = warnings.flatMap((w) =>
    w.messages.map((m) => `[${w.entry.tenant_display_name}] ${m}`),
  );
  headerWarnings.push(
    ...entries.flatMap((entry) =>
      entry.source_warnings.map(
        (warning) => `[${entry.tenant_display_name}] ${warning}`,
      ),
    ),
  );
  if (noAuditTrail) {
    headerWarnings.push(
      "This write has NO Firestore audit trail (Firestore isn't configured " +
        "in this environment). If this is a production run, check " +
        "FIREBASE_SERVICE_ACCOUNT_KEY.",
    );
  }
  const headers = new Headers({
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Tenant-Credit-Write-Summary": JSON.stringify(writtenSummary),
  });
  if (headerWarnings.length > 0) {
    headers.set("X-Worker-Warnings", JSON.stringify(headerWarnings));
  }

  return new Response(exactArrayBuffer(newXlsx), { status: 200, headers });
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
  const actual = cellExactText(sheet.getCell(headerRow, cell.col).value);
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
