import { NextResponse } from "next/server";
import { adminDb, adminBucket } from "@/lib/firebase-admin";
import { COLLECTIONS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/:id
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const doc = await adminDb().collection(COLLECTIONS.runs).doc(id).get();
  if (!doc.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ id: doc.id, ...doc.data() });
}

// DELETE /api/runs/:id — permanently remove a run and everything attached to
// it: the run doc + its rows/events subcollections, its scrape_state entries,
// and the uploaded + output files in Storage. Active runs can't be deleted —
// cancel first (deleting a live run mid-flight would break the worker).
export async function DELETE(
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
      { error: `Run is ${status} — cancel it before deleting` },
      { status: 409 },
    );
  }

  // Storage: delete the whole upload + output folders by prefix, so any file
  // name is covered. Missing prefixes are a no-op (failed runs have none).
  try {
    const bucket = adminBucket();
    await Promise.all([
      bucket.deleteFiles({ prefix: `tax_checker/uploads/${id}/`, force: true }),
      bucket.deleteFiles({ prefix: `tax_checker/outputs/${id}/`, force: true }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Storage cleanup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // scrape_state: single-field query by run_id (no composite index — §12).
  const states = await db
    .collection(COLLECTIONS.scrapeState)
    .where("run_id", "==", id)
    .get();
  let batch = db.batch();
  let n = 0;
  for (const doc of states.docs) {
    batch.delete(doc.ref);
    // Firestore batches cap at 500 writes — flush before the limit.
    if (++n % 450 === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % 450 !== 0) await batch.commit();

  // Run doc + rows/events subcollections, in one recursive sweep, last — so a
  // failure above leaves the run visible and retryable rather than orphaned.
  await db.recursiveDelete(runRef);

  return NextResponse.json({ ok: true, scrape_state_deleted: n });
}
