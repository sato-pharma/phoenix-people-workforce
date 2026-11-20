/**
 * The film queue (public.connector_film_jobs): phoenix_make_film writes a row, the worker claims it,
 * renders it and links the finished MP4 through connector_files. Server only (service role).
 *
 * A claim is a conditional update (status queued → rendering, only if still queued), so two worker
 * processes can never render the same film. A render that dies with its process stays "rendering"; the
 * next tick of any worker marks it failed once it is older than FILM_JOB_STALE_MS.
 */
import type { AccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { ToolRefusal } from "../types";
import type { FilmProgress } from "./render";
import type { FilmScript } from "./script";

export const FILM_JOB_STALE_MS = 90 * 60_000;
/** Films one person may have waiting or being made at once. */
export const FILM_JOBS_PER_PERSON = 3;

export type FilmJobStatus = "queued" | "rendering" | "done" | "failed";

export type FilmJobRow = {
  id: string;
  login_id: string;
  hr_id: string | null;
  role: string;
  session_version: number;
  title: string;
  script: FilmScript;
  status: FilmJobStatus;
  progress: Partial<FilmProgress>;
  file_id: string | null;
  duration_seconds: number | null;
  voice_used: boolean | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const COLUMNS =
  "id, login_id, hr_id, role, session_version, title, script, status, progress, file_id, duration_seconds, voice_used, error, created_at, started_at, finished_at";

export async function queueFilmJob(ctx: AccessContext, script: FilmScript, sessionVersion: number, db = getSupabaseAdmin()): Promise<FilmJobRow> {
  if (!ctx.loginId) throw new ToolRefusal("Sign in to Phoenix again.");
  const { count, error: countError } = await db
    .from("connector_film_jobs")
    .select("id", { count: "exact", head: true })
    .eq("login_id", ctx.loginId)
    .in("status", ["queued", "rendering"]);
  if (countError) throw countError;
  if ((count ?? 0) >= FILM_JOBS_PER_PERSON) {
    throw new ToolRefusal(`You already have ${count} films waiting or being made. Ask again when one is ready.`);
  }
  const { data, error } = await db
    .from("connector_film_jobs")
    .insert({
      login_id: ctx.loginId,
      hr_id: ctx.hrId ?? null,
      role: String(ctx.role),
      session_version: sessionVersion,
      title: script.title.slice(0, 150),
      script,
      progress: { scene: 0, scenes: script.scenes.length, stage: "Waiting for its turn" },
    })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as FilmJobRow;
}

/** The person's own film by id, or their newest one. Someone else's film reads as not found. */
export async function readFilmJob(ctx: AccessContext, id: string | undefined, db = getSupabaseAdmin()): Promise<FilmJobRow | null> {
  if (!ctx.loginId) throw new ToolRefusal("Sign in to Phoenix again.");
  let query = db.from("connector_film_jobs").select(COLUMNS).eq("login_id", ctx.loginId);
  if (id) query = query.eq("id", id);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return (data as unknown as FilmJobRow | null) ?? null;
}

export async function claimNextFilmJob(workerId: string, db = getSupabaseAdmin()): Promise<FilmJobRow | null> {
  const { data: next, error } = await db
    .from("connector_film_jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!next) return null;
  const { data: claimed, error: claimError } = await db
    .from("connector_film_jobs")
    .update({ status: "rendering", started_at: new Date().toISOString(), claimed_by: workerId.slice(0, 120) })
    .eq("id", (next as { id: string }).id)
    .eq("status", "queued")
    .select(COLUMNS)
    .maybeSingle();
  if (claimError) throw claimError;
  return (claimed as unknown as FilmJobRow | null) ?? null;
}

export async function reportFilmProgress(id: string, progress: FilmProgress, db = getSupabaseAdmin()): Promise<void> {
  // Progress is a courtesy: a failed write never stops a render.
  await db.from("connector_film_jobs").update({ progress }).eq("id", id).eq("status", "rendering");
}

export async function finishFilmJob(id: string, result: { fileId: string; durationSeconds: number; voiceUsed: boolean }, db = getSupabaseAdmin()) {
  const { error } = await db
    .from("connector_film_jobs")
    .update({
      status: "done",
      file_id: result.fileId,
      duration_seconds: result.durationSeconds,
      voice_used: result.voiceUsed,
      finished_at: new Date().toISOString(),
      progress: { stage: "Ready" },
    })
    .eq("id", id);
  if (error) throw error;
}

export async function failFilmJob(id: string, reason: string, db = getSupabaseAdmin()): Promise<void> {
  await db
    .from("connector_film_jobs")
    .update({ status: "failed", error: reason.slice(0, 1_000), finished_at: new Date().toISOString() })
    .eq("id", id);
}

/** A render older than the stale limit died with its process: say so instead of leaving it "being made". */
export async function failStaleFilmJobs(nowMs = Date.now(), db = getSupabaseAdmin()): Promise<void> {
  await db
    .from("connector_film_jobs")
    .update({ status: "failed", error: "The film stopped part-way (the worker restarted). Ask for it again.", finished_at: new Date(nowMs).toISOString() })
    .eq("status", "rendering")
    .lt("started_at", new Date(nowMs - FILM_JOB_STALE_MS).toISOString());
}

/** The finished film's file, for the same person, or null when it is gone or expired. */
export async function filmFileLink(fileId: string, db = getSupabaseAdmin()): Promise<{ id: string; sizeBytes: number; expiresAt: string } | null> {
  const { data, error } = await db.from("connector_files").select("id, size_bytes, expires_at").eq("id", fileId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { id: string; size_bytes: number; expires_at: string };
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return { id: row.id, sizeBytes: Number(row.size_bytes), expiresAt: row.expires_at };
}
