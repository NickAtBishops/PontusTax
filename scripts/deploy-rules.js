/**
 * Deploy firestore.rules + storage.rules + firestore.indexes.json using the
 * service account directly (Firebase Rules API + Firestore Admin API).
 * Skips firebase-tools' serviceusage preflight, which the admin-SDK service
 * account is not allowed to call.
 *
 * Run: node scripts/deploy-rules.js
 */

const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

const ROOT = path.join(__dirname, "..");
const sa = JSON.parse(fs.readFileSync(path.join(ROOT, "serviceAccount.json"), "utf8"));
const PROJECT = sa.project_id;
const RULES_API = "https://firebaserules.googleapis.com/v1";

async function main() {
  const auth = new GoogleAuth({
    credentials: sa,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();

  async function createRuleset(fileName) {
    const content = fs.readFileSync(path.join(ROOT, fileName), "utf8");
    const res = await client.request({
      url: `${RULES_API}/projects/${PROJECT}/rulesets`,
      method: "POST",
      data: { source: { files: [{ name: fileName, content }] } },
    });
    return res.data.name; // projects/<p>/rulesets/<id>
  }

  async function release(releaseId, rulesetName) {
    const name = `projects/${PROJECT}/releases/${releaseId}`;
    try {
      await client.request({
        url: `${RULES_API}/${name}`,
        method: "PATCH",
        data: { release: { name, rulesetName } },
      });
    } catch (e) {
      if (e.response?.status !== 404) throw e;
      await client.request({
        url: `${RULES_API}/projects/${PROJECT}/releases`,
        method: "POST",
        data: { name, rulesetName },
      });
    }
    console.log(`RULES: ${releaseId} → ${rulesetName.split("/").pop()}`);
  }

  // ---- Firestore + Storage rules ----------------------------------------
  await release("cloud.firestore", await createRuleset("firestore.rules"));
  const bucket =
    process.env.FIREBASE_STORAGE_BUCKET || `${PROJECT}.firebasestorage.app`;
  await release(
    `firebase.storage/${bucket}`,
    await createRuleset("storage.rules"),
  );

  // ---- Composite indexes --------------------------------------------------
  const indexes = JSON.parse(
    fs.readFileSync(path.join(ROOT, "firestore.indexes.json"), "utf8"),
  );
  for (const idx of indexes.indexes ?? []) {
    const url =
      `https://firestore.googleapis.com/v1/projects/${PROJECT}` +
      `/databases/(default)/collectionGroups/${idx.collectionGroup}/indexes`;
    try {
      await client.request({
        url,
        method: "POST",
        data: {
          queryScope: idx.queryScope,
          fields: idx.fields.map((f) => ({
            fieldPath: f.fieldPath,
            order: f.order,
          })),
        },
      });
      console.log(`INDEX: ${idx.collectionGroup} created (builds in background)`);
    } catch (e) {
      if (e.response?.status === 409) {
        console.log(`INDEX: ${idx.collectionGroup} already exists`);
      } else {
        throw e;
      }
    }
  }
  console.log("DEPLOY OK");
}

main().catch((e) => {
  console.error(
    "deploy failed:",
    e.response?.data?.error?.message ?? e.message,
  );
  console.error(
    "fallback: npx firebase-tools login && npm run deploy:firebase",
  );
  process.exit(1);
});
