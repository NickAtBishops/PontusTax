import { NextResponse } from "next/server";
import { adminDb, adminBucket } from "@/lib/firebase-admin";
import { requireUser, isErrorResponse } from "@/lib/server-auth";
import { COLLECTIONS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/:id/download — short-lived signed URL for the checked workbook
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser(req);
  if (isErrorResponse(user)) return user;

  const { id } = await params;
  const doc = await adminDb().collection(COLLECTIONS.runs).doc(id).get();
  if (!doc.exists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const outputPath = doc.get("output_path") as string | null;
  if (!outputPath) {
    return NextResponse.json(
      { error: "No checked workbook yet — the run has not finished" },
      { status: 409 },
    );
  }

  const [url] = await adminBucket()
    .file(outputPath)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 60 * 60 * 1000,
    });
  return NextResponse.json({ url });
}
