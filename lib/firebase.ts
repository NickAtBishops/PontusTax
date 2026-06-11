import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";

// All NEXT_PUBLIC_* values are safe to expose — they identify the project,
// they are not secrets. Access is controlled by Firestore security rules.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
};

export const isFirebaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
);

// Initialize only when configured so `next build` (and the setup screen)
// work without env vars. Components touch db strictly behind the
// ConfigGate, which blocks rendering until Firebase is configured.
function init(): { app: FirebaseApp; db: Firestore } | null {
  if (!isFirebaseConfigured) return null;
  // Guard against re-initialization during Next.js hot-reload.
  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
  return { app, db: getFirestore(app) };
}

const services = init();

export const db = services?.db as Firestore;
