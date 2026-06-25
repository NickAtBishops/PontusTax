// POST /api/login
//
// Validates the submitted password against SITE_PASSWORD. On match,
// issues a signed httpOnly cookie that the middleware checks on every
// subsequent request. The cookie expires after SESSION_DURATION_SECONDS
// (7 days today). The actual password never gets stored anywhere on
// the server side — we only compare it to the env var.

import { NextResponse } from "next/server";

import {
  COOKIE_NAME,
  buildSessionCookie,
  safeEqual,
} from "@/lib/auth-session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const sitePassword = process.env.SITE_PASSWORD;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sitePassword || !sessionSecret) {
    // The middleware fails open when the secret is missing, so this
    // route is the place the operator sees the problem first. Surface
    // it loudly rather than 401-ing every login attempt.
    return NextResponse.json(
      {
        error:
          "Authentication is not configured on the server. " +
          "Set SITE_PASSWORD and SESSION_SECRET in the deployment env.",
      },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON." },
      { status: 400 },
    );
  }
  const provided =
    body && typeof body === "object" && "password" in body &&
    typeof (body as { password: unknown }).password === "string"
      ? (body as { password: string }).password
      : "";
  // safeEqual is constant-time to avoid leaking the password length
  // (or its prefix) via response-time measurements.
  if (!safeEqual(provided, sitePassword)) {
    return NextResponse.json(
      { error: "Wrong password." },
      { status: 401 },
    );
  }

  const { value, expirySeconds } = await buildSessionCookie(sessionSecret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, value, {
    httpOnly: true,
    // Secure (HTTPS-only) in production; off locally so localhost works.
    secure: process.env.NODE_ENV === "production",
    // Lax lets the cookie ride GETs from external sites (so a bookmark
    // works), but blocks third-party POSTs (CSRF protection).
    sameSite: "lax",
    path: "/",
    maxAge: expirySeconds,
  });
  return res;
}
