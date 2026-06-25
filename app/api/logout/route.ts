// POST /api/logout
//
// Clears the pontus-session cookie. The middleware exempts this route
// so an expired session can still reach it; calling it without a
// cookie is a clean no-op.

import { NextResponse } from "next/server";

import { COOKIE_NAME } from "@/lib/auth-session";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE_NAME);
  return res;
}
