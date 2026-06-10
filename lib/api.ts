"use client";

/** Fetch an API route with the caller's Firebase ID token attached. */
export async function authedFetch(
  getToken: () => Promise<string>,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error === "string") return body.error;
  } catch {
    // fall through
  }
  return `${res.status} ${res.statusText}`;
}
