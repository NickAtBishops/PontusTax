import { GoogleAuth } from "google-auth-library";
import { adminProjectId, serviceAccountRaw } from "@/lib/firebase-admin";

export interface TriggerResult {
  triggered: boolean;
  detail: string;
}

/**
 * Kick one execution of the Cloud Run JOB. The job receives no arguments —
 * it claims the oldest QUEUED run from Firestore itself (transactional), so
 * plain run.jobs.run (roles/run.invoker on the job) is sufficient; no
 * container overrides, no run.jobs.runWithOverrides.
 *
 * Requires:
 *   CLOUD_RUN_JOB     e.g. "tax-checker-worker"
 *   CLOUD_RUN_REGION  e.g. "us-west1"
 *
 * When CLOUD_RUN_JOB is unset (local dev), the run stays "queued" and the
 * worker is started by hand: `cd worker && python main.py --run-id <id>`.
 */
export async function triggerWorker(runId: string): Promise<TriggerResult> {
  const job = process.env.CLOUD_RUN_JOB;
  const region = process.env.CLOUD_RUN_REGION;
  if (!job || !region) {
    return {
      triggered: false,
      detail:
        "CLOUD_RUN_JOB / CLOUD_RUN_REGION not configured — start the worker " +
        `manually: cd worker && python main.py --run-id ${runId}`,
    };
  }

  const credentials = JSON.parse(serviceAccountRaw());
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const project = process.env.CLOUD_RUN_PROJECT ?? adminProjectId();
  const url =
    `https://run.googleapis.com/v2/projects/${project}` +
    `/locations/${region}/jobs/${job}:run`;

  await client.request({ url, method: "POST", data: {} });

  return { triggered: true, detail: `Cloud Run job ${job} execution started` };
}
