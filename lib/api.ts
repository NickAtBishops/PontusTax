"use client";

export async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.error === "string") return body.error;
  } catch {
    // fall through
  }
  return `${res.status} ${res.statusText}`;
}
