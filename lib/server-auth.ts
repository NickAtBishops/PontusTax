import { NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";

export interface AuthedUser {
  uid: string;
  email: string | null;
}

/**
 * Verify the Firebase ID token on an API request (Authorization: Bearer …).
 * Optionally restrict to ALLOWED_EMAIL_DOMAINS / ALLOWED_EMAILS (comma lists).
 * Returns the user, or a NextResponse error to return as-is.
 */
export async function requireUser(
  req: Request,
): Promise<AuthedUser | NextResponse> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(token);
  } catch {
    return NextResponse.json({ error: "Invalid or expired session" }, {
      status: 401,
    });
  }

  const email = decoded.email ?? null;
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const emails = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (domains.length > 0 || emails.length > 0) {
    const lower = (email ?? "").toLowerCase();
    const domainOk = domains.some((d) => lower.endsWith(`@${d}`));
    const emailOk = emails.includes(lower);
    if (!domainOk && !emailOk) {
      return NextResponse.json(
        { error: `Account ${email ?? "(no email)"} is not allowed` },
        { status: 403 },
      );
    }
  }

  return { uid: decoded.uid, email };
}

export function isErrorResponse(
  u: AuthedUser | NextResponse,
): u is NextResponse {
  return u instanceof NextResponse;
}
