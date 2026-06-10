/**
 * Firebase project status + .env.local autofill.
 *
 * Uses ./serviceAccount.json to check, without touching the browser console:
 *   - is the service-account key still valid
 *   - is Firestore created
 *   - is a Web App registered (creates "Pontus Tax Checker" if none) and
 *     pulls its public config into .env.local's empty NEXT_PUBLIC_* slots
 *   - is Google sign-in enabled in Authentication
 *
 * Run: node scripts/firebase-status.js
 * Prints only non-secret values.
 */

const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

const ROOT = path.join(__dirname, "..");
const SA_PATH = path.join(ROOT, "serviceAccount.json");
const ENV_PATH = path.join(ROOT, ".env.local");

async function main() {
  const sa = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
  const project = sa.project_id;
  const auth = new GoogleAuth({
    credentials: sa,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();

  const get = async (url) => {
    try {
      const res = await client.request({ url });
      return { ok: true, data: res.data };
    } catch (e) {
      return {
        ok: false,
        status: e.response?.status,
        msg:
          e.response?.data?.error?.message ??
          String(e.message ?? e).split("\n")[0],
      };
    }
  };

  // ---- 1. key validity + Firestore --------------------------------------
  let keyValid = true;
  let firestoreReady = false;
  {
    const r = await get(
      `https://firestore.googleapis.com/v1/projects/${project}/databases`,
    );
    if (!r.ok && (r.status === 401 || /invalid_grant/i.test(r.msg))) {
      keyValid = false;
      console.log("KEY: INVALID (revoked?) — swap in the new serviceAccount.json");
      process.exit(1);
    }
    const dbs = r.ok ? r.data.databases ?? [] : [];
    firestoreReady = dbs.some((d) => d.name?.endsWith("/(default)"));
    console.log(`KEY: valid (project ${project})`);
    console.log(
      `FIRESTORE: ${firestoreReady ? "ready" : `NOT CREATED — console → Build → Firestore Database → Create (${r.ok ? "api reachable" : r.msg})`}`,
    );
  }

  // ---- 2. web app + public config ---------------------------------------
  let webConfig = null;
  {
    const base = `https://firebase.googleapis.com/v1beta1/projects/${project}`;
    let r = await get(`${base}/webApps`);
    let apps = r.ok ? r.data.apps ?? [] : [];
    if (r.ok && apps.length === 0) {
      console.log("WEB APP: none registered — creating 'Pontus Tax Checker'…");
      try {
        const op = await client.request({
          url: `${base}/webApps`,
          method: "POST",
          data: { displayName: "Pontus Tax Checker" },
        });
        // poll the long-running operation
        for (let i = 0; i < 15; i++) {
          await new Promise((s) => setTimeout(s, 2000));
          const opState = await get(
            `https://firebase.googleapis.com/v1beta1/${op.data.name}`,
          );
          if (opState.ok && opState.data.done) break;
        }
        r = await get(`${base}/webApps`);
        apps = r.ok ? r.data.apps ?? [] : [];
      } catch (e) {
        console.log(`WEB APP: create failed — ${e.response?.data?.error?.message ?? e.message}`);
      }
    }
    if (apps.length > 0) {
      const appId = apps[0].appId;
      const cfg = await get(`${base}/webApps/${appId}/config`);
      if (cfg.ok) {
        webConfig = cfg.data;
        console.log(`WEB APP: ${apps[0].displayName ?? appId} — config fetched`);
      } else {
        console.log(`WEB APP: exists but config fetch failed — ${cfg.msg}`);
      }
    } else if (!r.ok) {
      console.log(`WEB APP: cannot list — ${r.msg}`);
    }
  }

  // ---- 3. Authentication / Google provider ------------------------------
  {
    const r = await get(
      `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/defaultSupportedIdpConfigs`,
    );
    if (r.ok) {
      const idps = r.data.defaultSupportedIdpConfigs ?? [];
      const google = idps.find((i) => i.name?.endsWith("google.com"));
      console.log(
        `AUTH (Google sign-in): ${google?.enabled ? "ENABLED" : "NOT ENABLED — console → Build → Authentication → Sign-in method → Google"}`,
      );
    } else {
      console.log(
        `AUTH: not initialized — console → Build → Authentication → Get started → Google (${r.msg})`,
      );
    }
  }

  // ---- 4. fill empty .env.local slots ------------------------------------
  if (webConfig && fs.existsSync(ENV_PATH)) {
    const map = {
      NEXT_PUBLIC_FIREBASE_API_KEY: webConfig.apiKey,
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: webConfig.authDomain,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: webConfig.projectId,
      NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: webConfig.storageBucket,
      NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: webConfig.messagingSenderId,
      NEXT_PUBLIC_FIREBASE_APP_ID: webConfig.appId,
    };
    let env = fs.readFileSync(ENV_PATH, "utf8");
    const filled = [];
    for (const [key, value] of Object.entries(map)) {
      if (!value) continue;
      const re = new RegExp(`^${key}=.*$`, "m");
      const line = `${key}=${value}`;
      if (re.test(env)) {
        if (new RegExp(`^${key}=\\s*$`, "m").test(env)) {
          env = env.replace(re, line);
          filled.push(key);
        }
      } else {
        env += `${line}\n`;
        filled.push(key);
      }
    }
    if (filled.length) {
      fs.writeFileSync(ENV_PATH, env);
      console.log(`ENV: filled ${filled.join(", ")} in .env.local`);
    } else {
      console.log("ENV: .env.local already complete");
    }
  }
}

main().catch((e) => {
  console.error("status check failed:", e.message);
  process.exit(1);
});
