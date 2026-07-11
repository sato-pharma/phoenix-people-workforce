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
