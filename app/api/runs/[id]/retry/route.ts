import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { triggerWorker } from "@/lib/cloud-run";
import { COLLECTIONS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/runs/:id/retry — re-queue technically failed rows (worker crash,
// portal unreachable) and start a new worker execution. Business outcomes
// like NEEDS_REVIEW are deliberate results and are NOT retried automatically.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = adminDb();
  const runRef = db.collection(COLLECTIONS.runs).doc(id);
  const run = await runRef.get();
  if (!run.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const status = run.get("status") as string;
  if (["queued", "running", "writing_back"].includes(status)) {
    return NextResponse.json(
      { error: "Run is still in progress" },
      { status: 409 },
    );
  }

  // scrape_state docs use deterministic IDs `tax_check__<runId>__<rowKey>`.
  const states = await db
    .collection(COLLECTIONS.scrapeState)
    .where("run_id", "==", id)
    .get();

  let reset = 0;
  const batch = db.batch();
  for (const doc of states.docs) {
    const s = doc.get("status") as string;
    const rowStatus = doc.get("row_status") as string | null;
    const stuck = s === "failed" || s === "in_progress" || s === "pending";
    const unreachable = s === "done" && rowStatus === "UNREACHABLE";
    if (stuck || unreachable) {
      reset += 1;
      batch.update(doc.ref, {
        status: "pending",
        error: null,
        updated_at: FieldValue.serverTimestamp(),
      });
      const rowKey = doc.get("target_id") as string;
      batch.update(runRef.collection("rows").doc(rowKey), {
        state: "pending",
        updated_at: FieldValue.serverTimestamp(),
      });
    }
  }

  if (reset === 0 && status !== "failed") {
    return NextResponse.json(
      { error: "Nothing to retry — no failed or unreachable rows" },
      { status: 409 },
    );
  }

  batch.update(runRef, {
    status: "queued",
    cancel_requested: false,
    error: null,
    trigger_error: null,
    finished_at: null,
    updated_at: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  let trigger;
  try {
    trigger = await triggerWorker(id);
  } catch (e) {
    trigger = {
      triggered: false,
      detail: e instanceof Error ? e.message : "Worker trigger failed",
    };
  }
  if (!trigger.triggered) {
    await runRef.update({
      trigger_error: trigger.detail,
      updated_at: FieldValue.serverTimestamp(),
    });
  }

  return NextResponse.json({ ok: true, rows_requeued: reset, trigger });
}
