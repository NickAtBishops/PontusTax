import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { COLLECTIONS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/runs/:id/cancel — ask the worker to stop after the current row.
// Already-checked rows are still written back to the output workbook.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ref = adminDb().collection(COLLECTIONS.runs).doc(id);
  const doc = await ref.get();
  if (!doc.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const status = doc.get("status") as string;
  if (!["queued", "running", "writing_back"].includes(status)) {
    return NextResponse.json(
      { error: `Run is already ${status}` },
      { status: 409 },
    );
  }

  await ref.update({
    cancel_requested: true,
    // A queued run with no worker attached can be finalized immediately.
    ...(status === "queued" ? { status: "canceled" } : {}),
    updated_at: FieldValue.serverTimestamp(),
  });
  return NextResponse.json({ ok: true });
}
