import { initializeApp, getApps, getApp, cert } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Bucket } from "@google-cloud/storage";

// NOTE: firebase-admin/auth is deliberately NOT imported — its jwks-rsa →
// jose require chain breaks under Vercel's external-module loader
// (ERR_REQUIRE_ESM). (Auth was removed entirely on 2026-06-11; if it ever
// comes back, verify ID tokens with jose directly, not firebase-admin/auth.)

// The service-account credential comes from either:
//   FIREBASE_SERVICE_ACCOUNT_KEY       — the JSON itself as one line (Vercel), or
//   FIREBASE_SERVICE_ACCOUNT_KEY_FILE  — a path to the downloaded .json
//                                        (local dev; gitignored via
//                                        *serviceAccount*.json).
// NEVER expose either to the browser; full read/write on the project.
export function serviceAccountRaw(): string {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (inline) return inline;
  const file = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_FILE;
  if (file) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("fs").readFileSync(file, "utf8") as string;
  }
  throw new Error(
    "Set FIREBASE_SERVICE_ACCOUNT_KEY (JSON as one line) or " +
      "FIREBASE_SERVICE_ACCOUNT_KEY_FILE (path to the downloaded .json) " +
      "in .env.local / the Vercel dashboard.",
  );
}

// Initialization is lazy so `next build` succeeds without the secret present.
function getAdminApp() {
  if (getApps().length > 0) {
    return getApp();
  }
  const serviceAccount = JSON.parse(serviceAccountRaw());
  return initializeApp({
    credential: cert(serviceAccount),
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET ??
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  });
}

export function adminDb(): Firestore {
  return getFirestore(getAdminApp());
}

export function adminBucket(): Bucket {
  return getStorage(getAdminApp()).bucket();
}

export function adminProjectId(): string {
  return JSON.parse(serviceAccountRaw()).project_id as string;
}
