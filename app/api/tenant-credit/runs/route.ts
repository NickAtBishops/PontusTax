// GET /api/runs
// Phase 6. Returns the most recent run summaries from Firestore so the
// dashboard's Past Runs card can render. When Firestore isn't
// configured (no FIREBASE_SERVICE_ACCOUNT_KEY locally), this returns
// an empty list rather than 500 - the rest of the app keeps working
// while the analyst is still setting up Firebase.

import { NextResponse } from "next/server";
import { listRecentRuns } from "@/lib/tenant-credit/audit";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    return NextResponse.json(
      { error: "`limit` must be a positive number." },
      { status: 400 },
    );
  }
  try {
    const runs = await listRecentRuns(limit);
    return NextResponse.json({ runs });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to list runs.",
      },
      { status: 500 },
    );
  }
}
