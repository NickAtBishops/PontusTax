// Server-only Firestore audit log for tracker write-back attempts.
//
// Layout (matches CLAUDE.md "Firestore data model"):
//   tenant_tracker_runs/{run_id}              - one doc per writeback attempt
//   tenant_tracker_runs/{run_id}/line_items/  - one doc per extracted line item
//   tenant_tracker_runs/{run_id}/calculations/- one doc each for sales + ebitda
//
// All field names are snake_case (Firestore convention from the Pontus
// tooling template); TypeScript field names are snake_case here too so
// the audit payloads serialize without an extra rename step.
//
// What this module does NOT do:
//   - Authentication. The "written_by" string is supplied by the
//     caller; Phase 6 doesn't wire Firebase Auth yet.
//   - Soft updates of existing run docs. Each writeback attempt is a
//     new document - we never overwrite history.
//   - Anything when Firestore is unavailable. If the admin SDK isn't
//     configured (no FIREBASE_SERVICE_ACCOUNT_KEY and no emulator),
//     writeAuditRun silently returns null and listRecentRuns returns
//     [] so local dev doesn't require Firebase.

import { FieldValue, type Firestore } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase-admin";

const RUNS_COLLECTION = "tenant_tracker_runs";

// What a calculation trace looks like in the audit record. Mirrors the
// engine's CalculationTrace shape one-for-one.
export type AuditCalculationTrace = {
  formula: string;
  inputs: Array<{
    label: string;
    amount_source: number;
    amount_tracker: number;
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

export type AuditRunInput = {
  tenant_id: string;
  quarter: string;
  source_pdf_filename: string;
  source_pdf_hash: string;
  source_entity: string;
  source_period: string;
  computed_sales: number;
  computed_ebitda: number;
  intercompany_observed: AuditIntercompany[];
  normalization_applied: AuditNormalization[];
  passed_through: string[];
  unused_labels: string[];
  status: "writeback_success" | "writeback_failed";
  worker_warnings: string[];
  error: string | null;
  written_by: string;
  written_filename: string;
  // The normalized engine-ready line items (post-normalization).
  line_items: Array<{ label: string; amount: number }>;
  calculations: {
    sales: AuditCalculationTrace;
    ebitda: AuditCalculationTrace;
  };
};

export type RunSummary = {
  id: string;
  tenant_id: string;
  quarter: string;
  source_entity: string;
  source_period: string;
  source_pdf_filename: string;
  computed_sales: number;
  computed_ebitda: number;
  status: AuditRunInput["status"];
  worker_warnings: string[];
  error: string | null;
  written_by: string;
  written_filename: string;
  // Milliseconds since epoch. Null only when the server timestamp
  // hasn't materialized yet (rare; would mean we read the doc back in
  // the same request that wrote it).
  created_at: number | null;
};

// Write one run document plus the line_items and calculations
// subcollections in a single atomic batch. Returns the generated
// document ID, or null when Firestore isn't configured (local dev).
//
// Throws if the admin SDK is configured but the write fails. The
// writeback route catches that and returns 500 to the analyst.
export async function writeAuditRun(
  record: AuditRunInput,
): Promise<string | null> {
  const db = getAdminDb();
  if (!db) {
    // In production we treat a missing Firestore config as a hard
    // failure. CLAUDE.md says "audit BEFORE returning success" is
    // non-negotiable, so a silent skip in prod would be a regulatory
    // problem (write happens, no trail). Gated on VERCEL_ENV (not
    // NODE_ENV) so `next build` and preview deploys still work
    // without creds.
    if (process.env.VERCEL_ENV === "production") {
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

  const batch = db.batch();
  const runRef = db.collection(RUNS_COLLECTION).doc();
  const now = FieldValue.serverTimestamp();

  // The parent run document. Subcollection contents live in their own
  // docs (below) rather than embedded arrays so each line item has its
  // own audit identity (Phase 6+ may add per-item edit tracking).
  batch.set(runRef, {
    id: runRef.id,
    tenant_id: record.tenant_id,
    quarter: record.quarter,
    source_pdf_filename: record.source_pdf_filename,
    source_pdf_hash: record.source_pdf_hash,
    source_entity: record.source_entity,
    source_period: record.source_period,
    computed_sales: record.computed_sales,
    computed_ebitda: record.computed_ebitda,
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

  for (const item of record.line_items) {
    const itemRef = runRef.collection("line_items").doc();
    batch.set(itemRef, {
      id: itemRef.id,
      label: item.label,
      amount: item.amount,
      created_at: now,
      updated_at: now,
    });
  }

  for (const [name, calc] of Object.entries(record.calculations) as Array<
    [keyof AuditRunInput["calculations"], AuditCalculationTrace]
  >) {
    const calcRef = runRef.collection("calculations").doc();
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
      source_pdf_filename: String(d.source_pdf_filename ?? ""),
      computed_sales: Number(d.computed_sales ?? 0),
      computed_ebitda: Number(d.computed_ebitda ?? 0),
      status: (d.status ?? "writeback_failed") as RunSummary["status"],
      worker_warnings: Array.isArray(d.worker_warnings)
        ? (d.worker_warnings as string[])
        : [],
      error: d.error == null ? null : String(d.error),
      written_by: String(d.written_by ?? ""),
      written_filename: String(d.written_filename ?? ""),
      created_at: createdAt,
    };
  });
}
