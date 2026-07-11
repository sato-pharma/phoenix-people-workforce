import { buildBackupWorkbook, loadDataBackup, type DataBackupScope } from "@/lib/admin/data-backup";
import { logError, logInfo } from "@/lib/observability/log";

import {
  claimNextBackgroundJob,
  completeBackgroundJob,
  failBackgroundJob,
  JOB_EXPORTS_BUCKET,
  uploadJobResult,
  type BackgroundJob,
} from "./service";

export const DATA_BACKUP_EXPORT_JOB = "data_backup_export";
export const BACKGROUND_JOB_TYPES = [DATA_BACKUP_EXPORT_JOB];

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function normalizeScope(value: unknown): DataBackupScope {
  const v = String(value ?? "all").toLowerCase();
  return v === "sales" || v === "weekly" || v === "marketing" ? (v as DataBackupScope) : "all";
}

function exportFilename(scope: DataBackupScope, format: "xlsx" | "json", createdAt: string) {
  const safeScope = scope === "all" ? "all-modules" : scope;
  const stamp = createdAt.replace(/[:.]/g, "-").slice(0, 19);
  return `phoenix-data-backup-${safeScope}-${stamp}.${format}`;
}

async function runDataBackupExport(job: BackgroundJob): Promise<void> {
  const scope = normalizeScope(job.params.scope);
  const format = job.params.format === "json" ? "json" : "xlsx";
  const requestedBy = job.requested_by ?? "system";

  const payload = await loadDataBackup(scope, requestedBy);
  const filename = exportFilename(scope, format, job.created_at);
  const path = `data-backup/${job.id}.${format}`;

  if (format === "json") {
    await uploadJobResult(path, Buffer.from(JSON.stringify(payload)), JSON_CONTENT_TYPE);
    await completeBackgroundJob(job.id, { bucket: JOB_EXPORTS_BUCKET, path, filename, contentType: JSON_CONTENT_TYPE });
    return;
  }

  const buffer = await buildBackupWorkbook(payload);
  await uploadJobResult(path, buffer as ArrayBuffer, XLSX_CONTENT_TYPE);
  await completeBackgroundJob(job.id, { bucket: JOB_EXPORTS_BUCKET, path, filename, contentType: XLSX_CONTENT_TYPE });
}

/**
 * Drain up to `maxJobs` queued background jobs. Each job is claimed atomically and either
 * completed (result written to Storage) or failed. Designed to be invoked by an authed
 * cron; keeps well under the Cloud Run request timeout by bounding how many jobs it takes
 * per invocation. Genuinely unbounded work should be escalated to a Cloud Run Job.
 */
export async function processBackgroundJobs(maxJobs = 3): Promise<{ processed: number; results: Array<{ id: string; jobType: string; status: "completed" | "failed"; error?: string }> }> {
  const results: Array<{ id: string; jobType: string; status: "completed" | "failed"; error?: string }> = [];

  for (let i = 0; i < maxJobs; i += 1) {
    const job = await claimNextBackgroundJob(BACKGROUND_JOB_TYPES);
    if (!job) break;

    try {
      if (job.job_type === DATA_BACKUP_EXPORT_JOB) {
        await runDataBackupExport(job);
      } else {
        throw new Error(`Unknown background job type: ${job.job_type}`);
      }
      results.push({ id: job.id, jobType: job.job_type, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failBackgroundJob(job.id, message).catch(() => undefined);
      logError("Background job failed", { labels: { event: "background_job_failed", job_type: job.job_type }, error });
      results.push({ id: job.id, jobType: job.job_type, status: "failed", error: message });
    }
  }

  if (results.length > 0) {
    logInfo("Background jobs processed", { labels: { event: "background_jobs_drained", count: results.length } });
  }
  return { processed: results.length, results };
}
