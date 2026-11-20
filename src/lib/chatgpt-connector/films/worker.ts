/**
 * The film studio: a timer on the worker service that takes one queued film at a time and renders it.
 *
 * It runs where the other background work runs (PHOENIX_PROCESS_ROLE worker, or "all" before a split) and
 * never on the page server, because a twenty-minute render holds a browser and ffmpeg for twenty minutes.
 * It needs a production build on Railway: a laptop's `next dev` — whose .env.local points at PRODUCTION —
 * must never pick up a film. Started from instrumentation.ts.
 *
 * Each film is rendered as the person who asked, re-checked live first (the account still active, the same
 * role, the same session_version), so a password change or a sign-out everywhere between the ask and the
 * render stops it.
 */
import { hostname } from "node:os";

import { logError } from "@/lib/observability/log";
import { processRoleRefusal } from "@/lib/platform/process-role";

import { connectorAccessContext } from "../identity";
import { storeConnectorFile } from "../files";
import { isConnectorRole } from "../oauth";
import { ToolRefusal } from "../types";
import { claimNextFilmJob, failFilmJob, failStaleFilmJobs, finishFilmJob, reportFilmProgress, type FilmJobRow } from "./jobs";
import { renderFilm } from "./render";

export const FILM_WORKER_TICK_MS = 20_000;

/** Why this process must not render films, or null when it may. */
export function filmWorkerRefusal(env: Record<string, string | undefined> = process.env): string | null {
  const role = processRoleRefusal(env.PHOENIX_PROCESS_ROLE);
  if (role) return role;
  if (env.NODE_ENV !== "production") return "not a production build";
  if (!(env.RAILWAY_ENVIRONMENT_NAME ?? "").trim()) return "not running on Railway";
  return null;
}

export async function runFilmJob(job: FilmJobRow): Promise<void> {
  try {
    if (!isConnectorRole(job.role)) throw new ToolRefusal("Only the owner and the CEO can make films.");
    const access = await connectorAccessContext({ loginId: job.login_id, hrId: job.hr_id, role: job.role, sessionVersion: Number(job.session_version) });
    if (!access.ok) throw new ToolRefusal(access.reason);
    let last = 0;
    const rendered = await renderFilm(access.ctx, job.script, async (progress) => {
      if (Date.now() - last < 3_000 && progress.stage !== "Putting the film together") return;
      last = Date.now();
      await reportFilmProgress(job.id, progress).catch(() => undefined);
    });
    const file = await storeConnectorFile(access.ctx, { kind: "mp4", title: `Phoenix film ${job.title}`.slice(0, 150), body: rendered.body });
    await finishFilmJob(job.id, { fileId: file.id, durationSeconds: rendered.durationSeconds, voiceUsed: rendered.voiceUsed });
  } catch (error) {
    const reason =
      error instanceof ToolRefusal
        ? error.message
        : `Phoenix could not make the film: ${error instanceof Error ? error.message.split("\n")[0] : "an unexpected error"}. Ask for it again.`;
    if (!(error instanceof ToolRefusal)) {
      logError("ChatGPT connector film render failed", { labels: { event: "chatgpt_connector_film_failed", job: job.id }, error });
    }
    await failFilmJob(job.id, reason).catch(() => undefined);
  }
}

let started = false;

export function startFilmWorker(): { started: boolean; reason?: string } {
  const refusal = filmWorkerRefusal();
  if (refusal) return { started: false, reason: refusal };
  if (started) return { started: false, reason: "already running" };
  started = true;
  const workerId = `${hostname()}:${process.pid}`;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await failStaleFilmJobs();
      const job = await claimNextFilmJob(workerId);
      if (job) await runFilmJob(job);
    } catch (error) {
      logError("ChatGPT connector film queue tick failed", { labels: { event: "chatgpt_connector_film_tick_failed" }, error });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), FILM_WORKER_TICK_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { started: true };
}
