import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireUser, isErrorResponse } from "@/lib/server-auth";
import { COLLECTIONS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/:id
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
  return NextResponse.json({ id: doc.id, ...doc.data() });
}
