import { getSupabaseAdmin } from "@/lib/supabase/server";

export const JOB_EXPORTS_BUCKET = "job-exports";

export type BackgroundJobStatus = "queued" | "processing" | "completed" | "failed";

export interface BackgroundJob {
  id: string;
  job_type: string;
  status: BackgroundJobStatus;
  params: Record<string, unknown>;
  requested_by: string | null;
  progress: number;
  result_bucket: string | null;
  result_path: string | null;
  result_filename: string | null;
  result_content_type: string | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface EnqueueBackgroundJobInput {
  jobType: string;
  params?: Record<string, unknown>;
  requestedBy?: string | null;
}

export async function enqueueBackgroundJob(input: EnqueueBackgroundJobInput): Promise<BackgroundJob> {
  const { data, error } = await getSupabaseAdmin()
    .from("background_jobs")
    .insert({
      job_type: input.jobType,
      params: input.params ?? {},
      requested_by: input.requestedBy ?? null,
      status: "queued",
    })
    .select("*")
    .single();

  if (error || !data) {
    throw error ?? new Error("Failed to enqueue background job.");
  }
  return data as BackgroundJob;
}

/**
 * Atomically claim the next queued job of one of the given types. Returns null when the
 * queue is empty. Uses FOR UPDATE SKIP LOCKED so concurrent workers never double-process.
 */
export async function claimNextBackgroundJob(jobTypes: string[]): Promise<BackgroundJob | null> {
  const { data, error } = await getSupabaseAdmin().rpc("claim_next_background_job", { p_job_types: jobTypes });
  if (error) throw error;
  const job = (Array.isArray(data) ? data[0] : data) as BackgroundJob | null;
  if (!job || !job.id) return null;
  return job;
}

/**
 * How long a job may sit in `processing` without a write before it is treated as abandoned. The only
 * producer today is the admin data backup, which builds in minutes, and the drain runs weekly — so a
 * `processing` row an hour old belongs to a process that died (a crash, a redeploy) mid-job.
 */
export const STALE_BACKGROUND_JOB_MINUTES = 60;

export const STALE_BACKGROUND_JOB_MESSAGE =
  "The job was interrupted (a restart, a deploy or a crash) while it was running.";

type StaleBackgroundJob = Pick<BackgroundJob, "attempts" | "id" | "max_attempts" | "updated_at">;

/**
 * What recovery writes for one abandoned `processing` job. Pure, so the attempt budget is tested
 * without a database.
 *
 * F-05 (23 Oct 2026 audit): the claim takes only `queued` rows and nothing else ever looked at a
 * `processing` one, so a job whose process died mid-run stayed `processing` for good and its
 * `max_attempts` was never read. The claim already counts each attempt; this decides from that count
 * whether the job gets another run (`queued`) or is finished as `failed`.
 */
export function planStaleBackgroundJobRecovery(job: StaleBackgroundJob, nowIso: string) {
  const attempts = Number(job.attempts ?? 0);
  const maxAttempts = Number(job.max_attempts ?? 3);
  if (attempts >= maxAttempts) {
    return {
      error: `${STALE_BACKGROUND_JOB_MESSAGE} It used all ${maxAttempts} attempts.`,
      finished_at: nowIso,
      status: "failed" as const,
      updated_at: nowIso,
    };
  }
  return {
    error: STALE_BACKGROUND_JOB_MESSAGE,
    started_at: null,
    status: "queued" as const,
    updated_at: nowIso,
  };
}

type BackgroundJobsClient = Pick<ReturnType<typeof getSupabaseAdmin>, "from">;

/**
 * Re-queues (or, out of attempts, fails) every job left `processing` past the stale window. Each write
 * is conditional on the row still being `processing` with the SAME `updated_at` it was read with, so a
 * job a live worker touched in between is never disturbed. `client` and `nowMs` are injectable for the
 * tests.
 */
export async function recoverStaleBackgroundJobs(
  client?: BackgroundJobsClient,
  nowMs: number = Date.now(),
): Promise<{ failed: number; requeued: number }> {
  const supabase = client ?? getSupabaseAdmin();
  const cutoff = new Date(nowMs - STALE_BACKGROUND_JOB_MINUTES * 60_000).toISOString();
  const { data, error } = await supabase
    .from("background_jobs")
    .select("id,attempts,max_attempts,updated_at")
    .eq("status", "processing")
    .lt("updated_at", cutoff);
  if (error) throw error;

  let failed = 0;
  let requeued = 0;
  for (const job of (data ?? []) as StaleBackgroundJob[]) {
    const plan = planStaleBackgroundJobRecovery(job, new Date(nowMs).toISOString());
    const { data: written, error: writeError } = await supabase
      .from("background_jobs")
      .update(plan)
      .eq("id", job.id)
      .eq("status", "processing")
      .eq("updated_at", job.updated_at)
      .select("id");
    if (writeError) throw writeError;
    if ((written ?? []).length === 0) continue;
    if (plan.status === "failed") failed += 1;
    else requeued += 1;
  }
  return { failed, requeued };
}

export async function getBackgroundJob(id: string): Promise<BackgroundJob | null> {
  const { data, error } = await getSupabaseAdmin().from("background_jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as BackgroundJob | null) ?? null;
}

export async function updateBackgroundJobProgress(id: string, progress: number): Promise<void> {
  await getSupabaseAdmin()
    .from("background_jobs")
    .update({ progress: Math.max(0, Math.min(100, Math.round(progress))), updated_at: new Date().toISOString() })
    .eq("id", id);
}

export interface CompleteBackgroundJobInput {
  bucket: string;
  path: string;
  filename: string;
  contentType: string;
}

export async function completeBackgroundJob(id: string, result: CompleteBackgroundJobInput): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from("background_jobs")
    .update({
      status: "completed",
      progress: 100,
      result_bucket: result.bucket,
      result_path: result.path,
      result_filename: result.filename,
      result_content_type: result.contentType,
      error: null,
      finished_at: now,
      updated_at: now,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function failBackgroundJob(id: string, message: string): Promise<void> {
  const now = new Date().toISOString();
  await getSupabaseAdmin()
    .from("background_jobs")
    .update({ status: "failed", error: message.slice(0, 2000), finished_at: now, updated_at: now })
    .eq("id", id);
}

export async function uploadJobResult(
  path: string,
  body: Blob | ArrayBuffer | ArrayBufferView | Buffer,
  contentType: string,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .storage.from(JOB_EXPORTS_BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw error;
}

export async function downloadJobResult(bucket: string, path: string): Promise<Blob> {
  const { data, error } = await getSupabaseAdmin().storage.from(bucket).download(path);
  if (error || !data) throw error ?? new Error("Result file not found.");
  return data;
}
