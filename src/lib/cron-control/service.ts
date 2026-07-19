// Orchestration for the cron-control dashboard: validates job names against the GCP job-ID
// format (not registry membership — see job-registry.ts), calls the GCP Cloud Scheduler REST
// client for real, writes a REQUIRED audit log for every mutation (matching
// src/lib/admin/modules-control.ts's bar for toggling production-affecting state), and merges
// live GCP state with registry metadata into the shape the UI/API use. Every real job in the
// project's scheduler is listed and controllable, whether or not the static registry recognizes
// its name — the registry only supplies nicer labels, it never gates visibility or control.
//
// Never throws on read: listCronJobs() returns {available:false, error} when GCP_PROJECT_ID is
// unset or the runtime service account's Cloud Scheduler IAM grant hasn't landed yet, mirroring
// getServiceHealthSnapshot()'s contract — so this can ship and be reviewed ahead of that
// separate IAM approval.

import type { AccessContext } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import {
  listSchedulerJobs,
  pauseSchedulerJob,
  resumeSchedulerJob,
  runSchedulerJob,
  updateSchedulerJobSchedule,
  type RawSchedulerJob,
} from "@/lib/cron-control/gcp-scheduler-client";
import { findCronJobRegistryEntry, isValidGcpJobIdFormat } from "@/lib/cron-control/job-registry";

const DEFAULT_SCHEDULER_LOCATION = "us-central1";

export type CronJobSummary = {
  jobName: string;
  /** False when this job exists in GCP but isn't in the static registry — still fully
   *  listed/controllable, just without a curated label/description/route. */
  isKnown: boolean;
  label: string;
  description: string;
  route: string;
  schedule: string;
  timeZone: string;
  state: "ENABLED" | "PAUSED" | "DISABLED" | "UPDATE_FAILED" | string;
  lastAttemptTime: string | null;
  lastAttemptOutcome: "SUCCESS" | "FAILED" | "UNKNOWN" | null;
  nextScheduleTime: string | null;
  httpMethod: string;
  uri: string;
  // Deliberately no `headers` field — see gcp-scheduler-client.ts's shapeJob().
};

export type ListCronJobsResult =
  | { available: true; fetchedAt: string; jobs: CronJobSummary[] }
  | { available: false; error: string };

function resolveGcpConfig(): { projectId: string; location: string } | null {
  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) return null;
  const location = process.env.GCP_SCHEDULER_LOCATION || DEFAULT_SCHEDULER_LOCATION;
  return { projectId, location };
}

// Always returns a summary — a real GCP job is never hidden just because it's absent from the
// static registry (see job-registry.ts's isValidGcpJobIdFormat comment). Registry metadata only
// upgrades the label/description/route when it recognizes the name.
function toSummary(raw: RawSchedulerJob): CronJobSummary {
  const entry = findCronJobRegistryEntry(raw.name);
  return {
    jobName: raw.name,
    isKnown: entry !== null,
    label: entry?.label ?? raw.name,
    description: entry?.description ?? "Not in the local job registry — showing live GCP state only.",
    route: entry?.route ?? "",
    schedule: raw.schedule,
    timeZone: raw.timeZone,
    state: raw.state,
    lastAttemptTime: raw.lastAttemptTime,
    lastAttemptOutcome: deriveOutcome(raw),
    nextScheduleTime: raw.scheduleTime,
    httpMethod: raw.httpMethod,
    uri: raw.uri,
  };
}

function deriveOutcome(raw: RawSchedulerJob): CronJobSummary["lastAttemptOutcome"] {
  if (!raw.lastAttemptTime) return null;
  if (!raw.status) return "UNKNOWN";
  const code = raw.status.code ?? 0;
  return code === 0 ? "SUCCESS" : "FAILED";
}

export async function listCronJobs(): Promise<ListCronJobsResult> {
  const config = resolveGcpConfig();
  if (!config) {
    return { available: false, error: "GCP_PROJECT_ID is not configured." };
  }
  try {
    const raw = await listSchedulerJobs(config.projectId, config.location);
    const jobs = raw.map(toSummary);
    return { available: true, fetchedAt: new Date().toISOString(), jobs };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Cloud Scheduler error.";
    return { available: false, error: message };
  }
}

function requireGcpConfig(): { projectId: string; location: string } {
  const config = resolveGcpConfig();
  if (!config) throw new Error("GCP_PROJECT_ID is not configured.");
  return config;
}

// The real safety gate: a syntactically valid GCP job-ID format, not registry membership — any
// real job in this project's scheduler is controllable here, whether or not job-registry.ts
// happens to recognize its name (see that file's isValidGcpJobIdFormat comment). The GCP API
// itself 404s on a name that doesn't exist, which is the actual existence check.
function requireValidJobId(jobName: string): string {
  if (!isValidGcpJobIdFormat(jobName)) {
    throw new Error(`"${jobName}" is not a valid Cloud Scheduler job id.`);
  }
  return jobName;
}

async function auditMutation(params: {
  actor: AccessContext;
  jobName: string;
  action: string;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
}) {
  await writeRequiredAuditLog({
    actorLoginId: params.actor.loginId ?? params.actor.hrId ?? null,
    entityId: params.jobName,
    entityType: "cron_job_control",
    newValues: params.newValues ?? null,
    oldValues: params.oldValues ?? null,
    summary: `${params.actor.hrId ?? "admin"} ${params.action} cron job "${params.jobName}".`,
  });
}

export async function pauseCronJob(jobName: string, actor: AccessContext): Promise<CronJobSummary> {
  const validJobName = requireValidJobId(jobName);
  const config = requireGcpConfig();
  const raw = await pauseSchedulerJob(config.projectId, config.location, validJobName);
  await auditMutation({ actor, jobName: validJobName, action: "paused", newValues: { state: raw.state } });
  return toSummary(raw);
}

export async function resumeCronJob(jobName: string, actor: AccessContext): Promise<CronJobSummary> {
  const validJobName = requireValidJobId(jobName);
  const config = requireGcpConfig();
  const raw = await resumeSchedulerJob(config.projectId, config.location, validJobName);
  await auditMutation({ actor, jobName: validJobName, action: "resumed", newValues: { state: raw.state } });
  return toSummary(raw);
}

/**
 * Cloud Scheduler's :run fires the HTTP target asynchronously and returns almost immediately —
 * it does NOT wait for the target route to finish and does NOT return that route's
 * response/status. Callers must present this as "triggered", never "ran successfully"; actual
 * outcome only becomes visible on the next listCronJobs() poll via lastAttemptTime/Outcome.
 */
export async function runCronJobNow(jobName: string, actor: AccessContext): Promise<{ triggeredAt: string }> {
  const validJobName = requireValidJobId(jobName);
  const config = requireGcpConfig();
  await runSchedulerJob(config.projectId, config.location, validJobName);
  const triggeredAt = new Date().toISOString();
  await auditMutation({ actor, jobName: validJobName, action: "manually triggered" });
  return { triggeredAt };
}

export async function updateCronJobSchedule(
  jobName: string,
  input: { cronExpression: string; timeZone: string },
  actor: AccessContext,
  previousSchedule?: { cronExpression: string; timeZone: string },
): Promise<CronJobSummary> {
  const validJobName = requireValidJobId(jobName);
  const config = requireGcpConfig();
  const raw = await updateSchedulerJobSchedule(config.projectId, config.location, validJobName, input);
  await auditMutation({
    actor,
    jobName: validJobName,
    action: "edited the schedule of",
    oldValues: previousSchedule ?? null,
    newValues: { cronExpression: input.cronExpression, timeZone: input.timeZone },
  });
  return toSummary(raw);
}
