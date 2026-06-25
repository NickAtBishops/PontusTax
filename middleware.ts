// Site-wide password gate. Every request that isn't part of the login
// flow goes through this middleware; if the request doesn't carry a
// valid pontus-session cookie, the browser is redirected to /login
// with the original path tucked into ?next= so the user lands back
// where they were after entering the password.
//
// Runs on Vercel's Edge runtime by default. crypto.subtle is available
// there, so the cookie verification uses the same Web Crypto helpers
// as the API route that signs the cookie.

import { NextRequest, NextResponse } from "next/server";

import { COOKIE_NAME, isValidSessionCookie } from "@/lib/auth-session";

export async function middleware(req: NextRequest) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    // Misconfigured deploy: fail open rather than bricking the site.
    // The login API route prints a clear error if SITE_PASSWORD or
    // SESSION_SECRET are missing, so the operator will see the problem
    // the moment anyone tries to sign in.
    return NextResponse.next();
  }

  const cookie = req.cookies.get(COOKIE_NAME)?.value;
  if (await isValidSessionCookie(cookie, sessionSecret)) {
    return NextResponse.next();
  }

  // No valid session. API requests get a 401 in JSON so any browser
  // fetch() that races a session expiry sees a structured error
  // instead of an HTML redirect it can't parse. Everything else
  // bounces to /login with ?next= so we can return the analyst to
  // the page they tried to open.
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Unauthorized. Sign in at /login." },
      { status: 401 },
    );
  }

  const url = req.nextUrl.clone();
  const next = url.pathname + url.search;
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except:
  //   /login              the password form itself
  //   /api/login          the password-check route
  //   /api/logout         must always work, even with a stale cookie
  //   /_next/...          Next.js static assets and prefetched chunks
  //   /favicon.ico        the browser fetches it on every page load
  matcher: [
    "/((?!login|api/login|api/logout|_next/|favicon\\.ico).*)",
  ],
};
