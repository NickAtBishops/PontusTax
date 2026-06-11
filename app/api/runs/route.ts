import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb, adminBucket } from "@/lib/firebase-admin";
import { triggerWorker } from "@/lib/cloud-run";
import { COLLECTIONS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vercel serverless functions accept request bodies up to ~4.5 MB; tax
// trackers are far smaller. Anything bigger is almost certainly not a tracker.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// GET /api/runs — list runs (newest first)
export async function GET() {
  try {
    const snapshot = await adminDb()
      .collection(COLLECTIONS.runs)
      .orderBy("created_at", "desc")
      .limit(100)
      .get();
    const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/runs — upload a workbook and queue a check run
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Attach the Excel tracker as form field `file`" },
        { status: 400 },
      );
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return NextResponse.json(
        { error: "Only .xlsx workbooks are supported" },
        { status: 400 },
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "Workbook exceeds the 4 MB upload limit" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const runRef = adminDb().collection(COLLECTIONS.runs).doc();
    const safeName = file.name.replace(/[^\w.\- ()]/g, "_");
    const inputPath = `tax_checker/uploads/${runRef.id}/${safeName}`;

    await adminBucket().file(inputPath).save(buffer, {
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      resumable: false,
    });

    await runRef.set({
      id: runRef.id,
      file_name: file.name,
      input_path: inputPath,
      output_path: null,
      output_file_name: null,
      status: "queued",
      error: null,
      trigger_error: null,
      cancel_requested: false,
      requested_by: null,
      totals: {
        rows: 0,
        processed: 0,
        paid: 0,
        partial: 0,
        unpaid: 0,
        delinquent: 0,
        needs_review: 0,
        unreachable: 0,
        amount_due: 0,
      },
      sheets: null,
      summary: null,
      created_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
      started_at: null,
      finished_at: null,
    });

    let trigger;
    try {
      trigger = await triggerWorker(runRef.id);
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

    const created = await runRef.get();
    return NextResponse.json(
      { id: created.id, ...created.data(), trigger },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
