// Server-only Firestore audit log for tracker write-back attempts.
//
// Layout (matches CLAUDE.md "Firestore data model"):
//   tenant_tracker_runs/{run_id}              - one doc per writeback attempt
//   tenant_tracker_runs/{run_id}/line_items/  - one doc per extracted line item
//   tenant_tracker_runs/{run_id}/calculations/- one doc per writable metric
//
// All field names are snake_case (Firestore convention from the Pontus
// tooling template); TypeScript field names are snake_case here too so
// the audit payloads serialize without an extra rename step.
//
// What this module does NOT do:
//   - Identity authentication itself. The caller supplies a verified session
//     ID when available, otherwise the analyst name entered during review.
//   - Duplicate history for network retries. Deterministic IDs make the same
//     input workbook/source packet idempotent.
//   - Production fallback without Firestore. Production fails closed; local
//     development may continue with an explicit warning.

import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase-admin";
import type {
  SourceDocumentType,
  SourceScopeType,
} from "@/lib/tenant-credit/source-period";
import type { MetricKey } from "@/lib/tenant-credit/tracker-layout";

const RUNS_COLLECTION = "tenant_tracker_runs";

// What a calculation trace looks like in the audit record. Mirrors the
// engine's CalculationTrace shape one-for-one.
export type AuditCalculationTrace = {
  formula: string;
  inputs: Array<{
    label: string;
    amount_source: number;
    amount_tracker: number;
    reason: string;
  }>;
  total_tracker_unrounded: number;
  result: number;
};

export type AuditIntercompany = {
  income_label: string;
  expense_label: string;
  income_amount_source: number;
  expense_amount_source: number;
  amounts_match: boolean;
  net_effect_on_ebitda_source: number;
};

export type AuditNormalization = {
  raw_label: string;
  canonical_label: string;
  match_type: "alias" | "case_or_whitespace";
};

export type AuditSourceFile = {
  filename: string;
  file_hash: string;
  source_entity: string;
  source_period: string;
  source_units: string;
  source_units_evidence: string;
  document_type: SourceDocumentType;
  source_scope: string;
  source_scope_type: SourceScopeType;
  source_scope_identifiers: string[];
  period_selection: string;
  level: "tenant" | "corporate";
  included_in_compute: boolean;
  exclusion_reason: string;
};

export type AuditExcludedSourceFile = {
  filename: string;
  file_hash: string;
  source_period: string;
  reason: string;
};

export type AuditWrittenCell = {
  metric: MetricKey;
  address: string;
  previous_value: unknown;
  new_value: number;
};

export type AuditRunInput = {
  idempotency_key: string;
  run_group_id: string;
  tenant_id: string;
  quarter: string;
  source_pdf_filename: string;
  source_pdf_hash: string;
  source_entity: string;
  source_period: string;
  source_units: string;
  source_units_evidence: string;
  computed_sales: number;
  computed_ebitda: number;
  computed_metrics: Record<MetricKey, number | null>;
  source_files: AuditSourceFile[];
  excluded_source_files: AuditExcludedSourceFile[];
  input_workbook_hash: string;
  output_workbook_hash: string;
  written_cells: AuditWrittenCell[];
  intercompany_observed: AuditIntercompany[];
  normalization_applied: AuditNormalization[];
  passed_through: string[];
  unused_labels: string[];
  status: "writeback_pending" | "writeback_success" | "writeback_failed";
  worker_warnings: string[];
  error: string | null;
  written_by: string;
  written_filename: string;
  // The normalized engine-ready line items (post-normalization).
  line_items: Array<{
    label: string;
    printed_amount: number;
    amount: number;
    source_reference?: string;
    source_filename: string;
    source_file_hash: string;
    included_in_compute: boolean;
  }>;
  calculations: Record<MetricKey, AuditCalculationTrace>;
};

export type RunSummary = {
  id: string;
  tenant_id: string;
  quarter: string;
  source_entity: string;
  source_period: string;
  source_units: string;
  source_units_evidence: string;
  source_pdf_filename: string;
  computed_sales: number;
  computed_ebitda: number;
  status: AuditRunInput["status"];
  worker_warnings: string[];
  // Already stored on the parent doc (see writeAuditRun below) but
  // wasn't selected into this summary type, so the History UI had no
  // way to show what the classifier dropped on a past run without
  // fetching the run's subcollections. Cheap to include here since it
  // lives on the same doc read.
  unused_labels: string[];
  error: string | null;
  written_by: string;
  written_filename: string;
  // Milliseconds since epoch. Null only when the server timestamp
  // hasn't materialized yet (rare; would mean we read the doc back in
  // the same request that wrote it).
  created_at: number | null;
};

// Write one pending run plus line_items and calculations in one atomic batch.
// Returns its deterministic document ID, or null only in local development
// when Firestore isn't configured.
//
// Throws if the admin SDK is configured but the write fails. The
// writeback route catches that and returns 500 to the analyst.
export async function writeAuditRun(
  record: AuditRunInput,
): Promise<string | null> {
  const db = getAdminDb();
  if (!db) {
    const auditRequired =
      process.env.AUDIT_REQUIRED === "true" ||
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production";
    if (auditRequired) {
      throw new Error(
        "Firestore audit log unavailable: FIREBASE_SERVICE_ACCOUNT_KEY " +
          "missing in production. Refusing to write tracker without an " +
          "audit trail.",
      );
    }
    console.warn(
      "[audit] Firestore not configured (no FIREBASE_SERVICE_ACCOUNT_KEY " +
        "and no FIRESTORE_EMULATOR_HOST). Skipping audit record for " +
        `tenant_id=${record.tenant_id} quarter=${record.quarter}.`,
    );
    return null;
  }

  if (record.line_items.length > 480) {
    throw new Error(
      `Audit has ${record.line_items.length} line items; maximum is 480 per tenant.`,
    );
  }

  const batch = db.batch();
  const runRef = db.collection(RUNS_COLLECTION).doc(record.idempotency_key);
  const existing = await runRef.get();
  if (
    existing.exists &&
    existing.data()?.status === "writeback_success" &&
    existing.data()?.input_workbook_hash === record.input_workbook_hash &&
    existing.data()?.output_workbook_hash === record.output_workbook_hash
  ) {
    await runRef.update({
      written_filename: record.written_filename,
      updated_at: FieldValue.serverTimestamp(),
    });
    return runRef.id;
  }
  const now = FieldValue.serverTimestamp();

  // The parent run document. Subcollection contents live in their own
  // docs (below) rather than embedded arrays so each line item has its
  // own audit identity (Phase 6+ may add per-item edit tracking).
  batch.set(runRef, {
    id: runRef.id,
    idempotency_key: record.idempotency_key,
    run_group_id: record.run_group_id,
    tenant_id: record.tenant_id,
    quarter: record.quarter,
    source_pdf_filename: record.source_pdf_filename,
    source_pdf_hash: record.source_pdf_hash,
    source_entity: record.source_entity,
    source_period: record.source_period,
    source_units: record.source_units,
    source_units_evidence: record.source_units_evidence,
    computed_sales: record.computed_sales,
    computed_ebitda: record.computed_ebitda,
    computed_metrics: record.computed_metrics,
    source_files: record.source_files,
    excluded_source_files: record.excluded_source_files,
    input_workbook_hash: record.input_workbook_hash,
    output_workbook_hash: record.output_workbook_hash,
    written_cells: record.written_cells,
    intercompany_observed: record.intercompany_observed,
    normalization_applied: record.normalization_applied,
    passed_through: record.passed_through,
    unused_labels: record.unused_labels,
    status: record.status,
    worker_warnings: record.worker_warnings,
    error: record.error,
    written_by: record.written_by,
    written_filename: record.written_filename,
    // Convenience counters so a future Past Runs view can render
    // quickly without reading the subcollections.
    line_items_count: record.line_items.length,
    created_at: now,
    updated_at: now,
  });

  for (const [index, item] of record.line_items.entries()) {
    const itemRef = runRef
      .collection("line_items")
      .doc(`item_${String(index).padStart(4, "0")}`);
    batch.set(itemRef, {
      id: itemRef.id,
      label: item.label,
      printed_amount: item.printed_amount,
      amount: item.amount,
      source_reference: item.source_reference ?? "",
      source_filename: item.source_filename,
      source_file_hash: item.source_file_hash,
      included_in_compute: item.included_in_compute,
      created_at: now,
      updated_at: now,
    });
  }

  for (const [name, calc] of Object.entries(record.calculations) as Array<
    [keyof AuditRunInput["calculations"], AuditCalculationTrace]
  >) {
    const calcRef = runRef.collection("calculations").doc(name);
    batch.set(calcRef, {
      id: calcRef.id,
      name,
      formula: calc.formula,
      inputs: calc.inputs,
      total_tracker_unrounded: calc.total_tracker_unrounded,
      result: calc.result,
      created_at: now,
      updated_at: now,
    });
  }

  await batch.commit();
  return runRef.id;
}

export async function finalizeAuditRuns(
  ids: string[],
  status: "writeback_success" | "writeback_failed",
  error: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  const db = getAdminDb();
  if (!db) return;
  await db.runTransaction(async (transaction) => {
    const refs = ids.map((id) => db.collection(RUNS_COLLECTION).doc(id));
    const snapshots = await Promise.all(
      refs.map((reference) => transaction.get(reference)),
    );
    const now = FieldValue.serverTimestamp();
    for (const [index, snapshot] of snapshots.entries()) {
      // A failed retry must never downgrade an already-successful
      // idempotent run from an earlier response.
      if (
        status === "writeback_failed" &&
        snapshot.data()?.status === "writeback_success"
      ) {
        continue;
      }
      transaction.update(refs[index], { status, error, updated_at: now });
    }
  });
}

// Read the most recent N run summaries, newest first. Returns [] when
// Firestore isn't configured.
//
// Returns summaries (the parent doc only) rather than the full
// subcollections; a Phase 6+ drill-down view would fetch a single
// run's subcollections on demand.
export async function listRecentRuns(limit: number = 20): Promise<RunSummary[]> {
  const db: Firestore | null = getAdminDb();
  if (!db) return [];
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

  const snap = await db
    .collection(RUNS_COLLECTION)
    .orderBy("created_at", "desc")
    .limit(safeLimit)
    .get();

  return snap.docs.map((doc) => {
    const d = doc.data();
    // The server timestamp resolves to a Firestore Timestamp object;
    // surface millis for JSON serialization simplicity.
    const ts = d.created_at;
    const createdAt =
      ts && typeof ts.toMillis === "function" ? ts.toMillis() : null;
    return {
      id: doc.id,
      tenant_id: String(d.tenant_id ?? ""),
      quarter: String(d.quarter ?? ""),
      source_entity: String(d.source_entity ?? ""),
      source_period: String(d.source_period ?? ""),
      source_units: String(d.source_units ?? ""),
      source_units_evidence: String(d.source_units_evidence ?? ""),
      source_pdf_filename: String(d.source_pdf_filename ?? ""),
      computed_sales: Number(d.computed_sales ?? 0),
      computed_ebitda: Number(d.computed_ebitda ?? 0),
      status: (d.status ?? "writeback_failed") as RunSummary["status"],
      worker_warnings: Array.isArray(d.worker_warnings)
        ? (d.worker_warnings as string[])
        : [],
      unused_labels: Array.isArray(d.unused_labels)
        ? (d.unused_labels as string[])
        : [],
      error: d.error == null ? null : String(d.error),
      written_by: String(d.written_by ?? ""),
      written_filename: String(d.written_filename ?? ""),
      created_at: createdAt,
    };
  });
}
