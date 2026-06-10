import { NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { adminProjectId } from "@/lib/firebase-admin";

export interface AuthedUser {
  uid: string;
  email: string | null;
}

// Firebase ID tokens are standard RS256 JWTs signed by Google's
// securetoken service — verified here with jose per the documented
// third-party-JWT method (firebase-admin/auth's dependency chain breaks
// on Vercel). The JWKS is cached per server instance.
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    "https://www.googleapis.com/service_accounts/v1/jwk/" +
      "securetoken@system.gserviceaccount.com",
  ),
);

async function verifyIdToken(
  token: string,
): Promise<{ uid: string; email: string | null }> {
  const projectId = adminProjectId();
  const { payload } = await jwtVerify(token, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ["RS256"],
  });
  if (!payload.sub) throw new Error("token has no subject");
  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
  };
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

  let decoded: { uid: string; email: string | null };
  try {
    decoded = await verifyIdToken(token);
  } catch {
    return NextResponse.json({ error: "Invalid or expired session" }, {
      status: 401,
    });
  }

  const email = decoded.email;
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
