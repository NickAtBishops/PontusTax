import { GoogleAuth } from "google-auth-library";
import { adminProjectId, serviceAccountRaw } from "@/lib/firebase-admin";

export interface TriggerResult {
  triggered: boolean;
  detail: string;
}

/**
 * Kick one execution of the Cloud Run JOB that processes a run.
 * The job container receives RUN_ID (plus any extra env) as overrides.
 *
 * Requires:
 *   CLOUD_RUN_JOB     e.g. "tax-checker-worker"
 *   CLOUD_RUN_REGION  e.g. "us-west1"
 * and the service account (FIREBASE_SERVICE_ACCOUNT_KEY) holding
 * roles/run.developer (or run.invoker) on the job.
 *
 * When CLOUD_RUN_JOB is unset (local dev), the run stays "queued" and the
 * worker is started by hand: `cd worker && python main.py --run-id <id>`.
 */
export async function triggerWorker(
  runId: string,
  extraEnv: Record<string, string> = {},
): Promise<TriggerResult> {
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

  const env = [
    { name: "RUN_ID", value: runId },
    ...Object.entries(extraEnv).map(([name, value]) => ({ name, value })),
  ];

  await client.request({
    url,
    method: "POST",
    data: { overrides: { containerOverrides: [{ env }] } },
  });

  return { triggered: true, detail: `Cloud Run job ${job} execution started` };
}
