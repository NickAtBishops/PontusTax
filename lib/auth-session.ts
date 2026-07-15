// Shared cookie-signing helpers used by the login API route and the
// middleware that gates every other path. Web Crypto API only, so the
// same code runs on the Edge runtime (middleware) and Node runtime
// (API routes) without an extra dependency.
//
// Cookie format: "{expiry}:{id}:{signature}"
//   expiry   — unix timestamp (seconds) at which the cookie stops
//              being valid; checked against the server clock on every
//              request.
//   id       — 16-byte random hex string. Not strictly required for
//              security; useful for debugging ("which session was
//              this?") and ensures every issued cookie is unique even
//              if two analysts log in at the same second.
//   signature — HMAC-SHA256 over "{expiry}:{id}" using SESSION_SECRET,
//              hex-encoded. The middleware re-derives this on every
//              request and rejects the cookie on mismatch.

export const COOKIE_NAME = "pontus-session";

// Session lifetime. 7 days is enough that the analyst doesn't re-enter
// the password every morning, short enough that a forgotten laptop on
// a coffee-shop table doesn't leak access forever.
export const SESSION_DURATION_SECONDS = 7 * 24 * 60 * 60;

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmacSha256(
  secret: string,
  message: string,
): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time string comparison so an attacker can't probe the
// password (or signature) one character at a time by measuring how
// long the response takes. Plain === short-circuits on the first
// mismatch and leaks length info; this XORs every byte and only
// returns at the end.
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildSessionCookie(
  sessionSecret: string,
): Promise<{ value: string; expirySeconds: number }> {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
  const id = randomId();
  const signature = await hmacSha256(sessionSecret, `${expiry}:${id}`);
  return {
    value: `${expiry}:${id}:${signature}`,
    expirySeconds: SESSION_DURATION_SECONDS,
  };
}

// Returns true when the cookie is well-formed, signed by the right
// secret, and not expired. The middleware uses this on every request.
export async function isValidSessionCookie(
  cookie: string | undefined,
  sessionSecret: string,
): Promise<boolean> {
  return (await parseSessionCookie(cookie, sessionSecret)) !== null;
}

export async function parseSessionCookie(
  cookie: string | undefined,
  sessionSecret: string,
): Promise<{ expiry: number; id: string } | null> {
  if (!cookie) return null;
  const parts = cookie.split(":");
  if (parts.length !== 3) return null;
  const [expiryStr, id, sig] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry)) return null;
  if (expiry < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmacSha256(sessionSecret, `${expiryStr}:${id}`);
  if (!safeEqual(sig, expected)) return null;
  return { expiry, id };
}
