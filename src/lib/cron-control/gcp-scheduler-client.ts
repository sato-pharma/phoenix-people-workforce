// Raw GCP Cloud Scheduler REST client for the cron-control dashboard. Mirrors
// src/lib/observability/gcp-metrics.ts's pattern precisely: module-cached GoogleAuth via
// Application Default Credentials, raw fetch + Bearer token (no @google-cloud/scheduler SDK,
// staying consistent with how this repo already talks to GCP), narrowest-available OAuth
// scope, never-throw callers layer their own {available,error} contract on top in service.ts.
//
// SECURITY: Cloud Scheduler's Job resource stores the CRON_SECRET as a plain string in
// httpTarget.headers.Authorization and GCP returns it in cleartext on get/list to any caller
// with view permission — there is no built-in redaction. `shapeJob()` strips `httpTarget`
// down to only `{uri, httpMethod}` before anything else in this codebase ever sees the
// response, and `RawSchedulerJob` has no `headers` field at all so a later change can't
// accidentally start returning it.

import { GoogleAuth } from "google-auth-library";

const SCHEDULER_SCOPE = "https://www.googleapis.com/auth/cloud-scheduler";
const SCHEDULER_ENDPOINT = "https://cloudscheduler.googleapis.com/v1";

export type RawSchedulerJob = {
  name: string; // "projects/{p}/locations/{l}/jobs/{jobId}"
  schedule: string;
  timeZone: string;
  state: "ENABLED" | "PAUSED" | "DISABLED" | "UPDATE_FAILED" | string;
  uri: string;
  httpMethod: string;
  lastAttemptTime: string | null;
  scheduleTime: string | null;
  status: { code?: number; message?: string } | null;
};

type GcpJobResponse = {
  name: string;
  schedule?: string;
  timeZone?: string;
  state?: string;
  httpTarget?: { uri?: string; httpMethod?: string; headers?: Record<string, string> };
  lastAttemptTime?: string;
  scheduleTime?: string;
  status?: { code?: number; message?: string };
};

let cachedAuth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!cachedAuth) cachedAuth = new GoogleAuth({ scopes: SCHEDULER_SCOPE });
  return cachedAuth;
}

async function getAccessToken(): Promise<string> {
  const token = await getAuth().getAccessToken();
  if (!token) {
    throw new Error("Could not obtain a Google Cloud access token from Application Default Credentials.");
  }
  return token;
}

function shapeJob(raw: GcpJobResponse): RawSchedulerJob {
  const jobId = raw.name.split("/").pop() ?? raw.name;
  return {
    name: jobId,
    schedule: raw.schedule ?? "",
    timeZone: raw.timeZone ?? "UTC",
    state: (raw.state as RawSchedulerJob["state"]) ?? "ENABLED",
    uri: raw.httpTarget?.uri ?? "",
    httpMethod: raw.httpTarget?.httpMethod ?? "GET",
    lastAttemptTime: raw.lastAttemptTime ?? null,
    scheduleTime: raw.scheduleTime ?? null,
    status: raw.status ?? null,
  };
}

async function schedulerFetch(path: string, init?: RequestInit): Promise<unknown> {
  const token = await getAccessToken();
  const response = await fetch(`${SCHEDULER_ENDPOINT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Cloud Scheduler API call failed (${response.status}): ${body.slice(0, 400)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function jobResourcePath(projectId: string, location: string, jobName: string): string {
  return `/projects/${projectId}/locations/${location}/jobs/${jobName}`;
}

export async function listSchedulerJobs(projectId: string, location: string): Promise<RawSchedulerJob[]> {
  const json = (await schedulerFetch(`/projects/${projectId}/locations/${location}/jobs`)) as { jobs?: GcpJobResponse[] };
  return (json.jobs ?? []).map(shapeJob);
}

export async function runSchedulerJob(projectId: string, location: string, jobName: string): Promise<void> {
  await schedulerFetch(`${jobResourcePath(projectId, location, jobName)}:run`, { method: "POST" });
}

export async function pauseSchedulerJob(projectId: string, location: string, jobName: string): Promise<RawSchedulerJob> {
  const json = (await schedulerFetch(`${jobResourcePath(projectId, location, jobName)}:pause`, { method: "POST" })) as GcpJobResponse;
  return shapeJob(json);
}

export async function resumeSchedulerJob(projectId: string, location: string, jobName: string): Promise<RawSchedulerJob> {
  const json = (await schedulerFetch(`${jobResourcePath(projectId, location, jobName)}:resume`, { method: "POST" })) as GcpJobResponse;
  return shapeJob(json);
}

/**
 * Patches ONLY schedule + timeZone. Deliberately has no way to accept uri/headers/httpMethod —
 * the function signature is the first line of defense against ever repointing a job's target
 * or auth header through this dashboard; the updateMask below is the second (belt + suspenders).
 */
export async function updateSchedulerJobSchedule(
  projectId: string,
  location: string,
  jobName: string,
  input: { cronExpression: string; timeZone: string },
): Promise<RawSchedulerJob> {
  const json = (await schedulerFetch(
    `${jobResourcePath(projectId, location, jobName)}?updateMask=schedule,timeZone`,
    {
      method: "PATCH",
      body: JSON.stringify({ schedule: input.cronExpression, timeZone: input.timeZone }),
    },
  )) as GcpJobResponse;
  return shapeJob(json);
}
