import crypto from "node:crypto";

import { cairoDateTime } from "@/lib/format/cairo-datetime";
import { getDeployRevision } from "@/lib/observability/deploy-identity";
import { logError, logWarning } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { sendSystemAuditDailyMessage, type SystemAuditDailyMessageResult } from "@/lib/system-audit/daily-message";
import {
  acquireSweepLease,
  createDatabaseSink,
  finishDetectorRun,
  releaseSweepLease,
  startDetectorRun,
} from "@/lib/system-audit/repository";
import {
  emptyDetectorResult,
  type AuditDetector,
  type DetectorMode,
  type DetectorResult,
  type DetectorRunStatus,
  type FindingSink,
} from "@/lib/system-audit/types";

/**
 * THE NIGHTLY SWEEP — every detector, one after another, then the one daily message.
 *
 * 04:57 Cairo (/api/cron/system-audit-sweep), seventeen minutes after the integrity checks, when
 * nobody is working and the database has the most room. Its guards are all about NOT being the thing
 * that hurts the database it is auditing — the 22 Oct 2026 stall was four restarts of an instance
 * swapping on 2 GB of RAM, and an audit that piled a heavy read onto that would make the next one:
 *
 *   ONE AT A TIME. A lease (`system_audit_acquire_lease("sweep", …, 300)`) so a re-fired or
 *     overlapping cron call finds the sweep already running and steps aside; detectors run strictly
 *     in sequence, never in parallel.
 *   NOT THE NIGHT AFTER A RESTART. If the database restarted in the last 18 hours, the detectors sit
 *     the night out — their watermarks stay put, so tomorrow's run reads everything tonight's would
 *     have. The restart time is READ from `database_restarts`, never noted: calling
 *     note_database_restart() here would consume the `is_new` the quarter-hourly restart alarm pages on.
 *   STOP WHEN IT LOOKS UNHEALTHY. A detector that fails with a timeout, a cancelled statement,
 *     a dropped connection, PostgREST's schema-cache 503 or a gateway 5xx ends the sweep: every
 *     detector after it is recorded as aborted, not tried.
 *   A TIME BUDGET. 240 s for the whole sweep inside the route's 300 s, at most 90 s per detector.
 *
 * Failures go to logError (the structured log and the error table), never straight into
 * logAppError: the sweep is a background job, and a background job's failure is a log line with a
 * job name on it like every other.
 *
 * The daily message goes out at the end even on a night the detectors sat out — the integrity
 * checks wrote their findings at 04:40 regardless, and those are owed a message too.
 *
 * A NIGHT THAT DID NOT RUN IS NEVER SILENT. The sweep writes its OWN row to
 * system_audit_detector_runs every night (detector `sweep`): started once it holds the lease,
 * finished with the night's status — ok, partial, skipped (and why) or aborted_db_unhealthy — before
 * the message goes. And the message is handed the night's result: when the sweep sat out, stopped,
 * or any detector did not finish ok, it says which checks did not run and why, even with no issue to
 * list. On 13 Nov 2026 the database had restarted at 20:23 Cairo the evening before; the 04:57 sweep
 * sat out, wrote no row and sent nothing, and the morning looked exactly like a clean one.
 */

const SWEEP_LEASE = "sweep";
/** The sweep's own row in system_audit_detector_runs — one a night, whatever the night did. */
export const SWEEP_RUN_DETECTOR = "sweep";
const SWEEP_LEASE_SECONDS = 300;
export const SWEEP_BUDGET_MS = 240_000;
export const PER_DETECTOR_MS = 90_000;
export const RESTART_QUIET_HOURS = 18;
const JOB = "system-audit-sweep";

/** The failures that mean the DATABASE is struggling, not that one detector has a bug. */
export function isDatabaseUnhealthy(text: string | null | undefined): boolean {
  const message = String(text ?? "");
  return (
    /timed? ?out|timeout|57014|canceling statement|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|PGRST002/i.test(message) ||
    /\b(?:502|503|504|52\d)\b/.test(message)
  );
}

type SweepDetectorSummary = {
  detector: string;
  status: DetectorRunStatus;
  scanned: number;
  inserted: number;
  updated: number;
  error: string | null;
};

export type SweepResult = {
  status: "ok" | "partial" | "skipped" | "aborted_db_unhealthy";
  reason: string | null;
  runGroup: string | null;
  detectors: SweepDetectorSummary[];
  dailyMessage: SystemAuditDailyMessageResult | null;
};

export type SweepDeps = {
  detectors?: readonly AuditDetector[];
  sink?: FindingSink;
  acquireLease?: (holder: string) => Promise<boolean>;
  releaseLease?: (holder: string) => Promise<void>;
  /** The newest database start time on record, or null. */
  lastDatabaseRestart?: () => Promise<string | null>;
  startRun?: (input: { detector: string; mode: DetectorMode; runGroup: string; release: string | null }) => Promise<string>;
  finishRun?: (runId: string, result: DetectorResult) => Promise<void>;
  /** Handed the night's result, so a night whose checks did not all run is said out loud. */
  sendDailyMessage?: (sweep: SweepResult) => Promise<SystemAuditDailyMessageResult>;
  now?: () => number;
  release?: string | null;
  mode?: DetectorMode;
};

async function readLastDatabaseRestart(): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin({ requestTimeoutMs: 10_000 })
    .from("database_restarts")
    .select("postmaster_start_at")
    .order("postmaster_start_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`The database restart record could not be read: ${error.message}`);
  return (data as { postmaster_start_at?: string } | null)?.postmaster_start_at ?? null;
}

function summary(detector: string, result: DetectorResult): SweepDetectorSummary {
  return {
    detector,
    status: result.status,
    scanned: result.scanned,
    inserted: result.inserted,
    updated: result.updated,
    error: result.error ?? null,
  };
}

function thrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The sweep's own run row, from the night's result. Every status it can carry is one the table allows. */
function sweepRunResult(result: SweepResult): DetectorResult {
  const run = emptyDetectorResult(result.status);
  run.scanned = result.detectors.length;
  const notClean = result.detectors.filter((row) => row.status !== "ok");
  // `error` is the one line the Integrity tab prints under a run, so the reason a night did not run
  // (or ran only in part) goes there, where it is seen.
  run.error =
    result.reason ??
    (notClean.length > 0
      ? `Not every detector finished ok: ${notClean.map((row) => `${row.detector} (${row.status})`).join(", ")}.`
      : null);
  run.report = {
    reason: result.reason,
    detectors: result.detectors.map((row) => ({ detector: row.detector, status: row.status })),
  };
  return run;
}

/**
 * Run the sweep once. Throws only when the lease itself cannot be taken — then the
 * database is not answering at all, and the cron route reports the run as failed.
 */
export async function runSystemAuditSweep(deps: SweepDeps = {}): Promise<SweepResult> {
  // Imported lazily: the detector list pulls in every detector's sources, which a test of the
  // sweep's own rules (lease, restart, abort) injects instead.
  const detectors = deps.detectors ?? (await import("@/lib/system-audit/detectors/index")).SWEEP_DETECTORS;
  const now = deps.now ?? (() => Date.now());
  const acquireLease = deps.acquireLease ?? ((holder: string) => acquireSweepLease(SWEEP_LEASE, holder, SWEEP_LEASE_SECONDS));
  const releaseLease = deps.releaseLease ?? ((holder: string) => releaseSweepLease(SWEEP_LEASE, holder));
  const lastDatabaseRestart = deps.lastDatabaseRestart ?? readLastDatabaseRestart;
  const startRun = deps.startRun ?? ((input) => startDetectorRun(input));
  const finishRun = deps.finishRun ?? ((runId, result) => finishDetectorRun(runId, result));
  const sendDailyMessage = deps.sendDailyMessage ?? ((sweep: SweepResult) => sendSystemAuditDailyMessage({}, { sweep }));
  const release = deps.release === undefined ? getDeployRevision() : deps.release;
  const mode = deps.mode ?? "cron";

  const holder = `${JOB}:${crypto.randomUUID()}`;
  if (!(await acquireLease(holder))) {
    logWarning("System audit sweep skipped — another sweep holds the lease", { labels: { event: "system_audit_sweep_overlap", job: JOB } });
    // No daily message either: the sweep holding the lease sends it when it finishes.
    return { status: "skipped", reason: "Another sweep is already running.", runGroup: null, detectors: [], dailyMessage: null };
  }

  const runGroup = crypto.randomUUID();
  const result: SweepResult = { status: "ok", reason: null, runGroup, detectors: [], dailyMessage: null };
  // The sweep's own row, started now so a sweep that dies part-way is left reading "running" on the
  // Integrity tab rather than leaving no trace. A row that cannot be written never stops the sweep.
  let sweepRunId: string | null = null;
  try {
    sweepRunId = await startRun({ detector: SWEEP_RUN_DETECTOR, mode, runGroup, release });
  } catch (error) {
    logError("System audit sweep could not record its own run", {
      error,
      labels: { event: "system_audit_sweep_run_unrecorded", job: JOB, detector: SWEEP_RUN_DETECTOR },
    });
  }
  try {
    let restartAt: string | null = null;
    try {
      restartAt = await lastDatabaseRestart();
    } catch (error) {
      // Unknown is not "restarted": the sweep runs, and its own unhealthy check is still the backstop.
      logWarning("System audit sweep could not read the database restart record", {
        error,
        labels: { event: "system_audit_sweep_restart_unreadable", job: JOB },
      });
    }
    const restartMs = restartAt ? Date.parse(restartAt) : Number.NaN;
    if (Number.isFinite(restartMs) && now() - restartMs < RESTART_QUIET_HOURS * 3_600_000) {
      result.status = "skipped";
      result.reason = `The database restarted at ${cairoDateTime(restartAt)} Cairo, so the detectors sit this night out; their watermarks stay where they are and tomorrow's run reads everything tonight's would have.`;
      logWarning("System audit sweep sat the night out after a database restart", {
        labels: { event: "system_audit_sweep_after_restart", job: JOB, restart_at: String(restartAt) },
      });
    } else {
      const sink = deps.sink ?? createDatabaseSink();
      const sweepDeadline = now() + SWEEP_BUDGET_MS;
      let abortedBy: string | null = null;

      for (const detector of detectors) {
        if (abortedBy || now() >= sweepDeadline) {
          // Never tried — and recorded as such, so the page shows a gap, not a quiet night.
          const notRun = emptyDetectorResult(abortedBy ? "aborted_db_unhealthy" : "budget_exhausted");
          notRun.error = abortedBy
            ? `Not run: the sweep stopped after ${abortedBy} found the database unhealthy.`
            : "Not run: the sweep's time budget ran out before this detector started.";
          try {
            await finishRun(await startRun({ detector: detector.id, mode, runGroup, release }), notRun);
          } catch {
            // The database that just failed may not take this row either; the response still says so.
          }
          result.detectors.push(summary(detector.id, notRun));
          continue;
        }

        let runId: string | null = null;
        let outcome: DetectorResult;
        try {
          runId = await startRun({ detector: detector.id, mode, runGroup, release });
          outcome = await detector.run({
            mode,
            deadline: Math.min(sweepDeadline, now() + PER_DETECTOR_MS),
            sink,
            runId,
            now,
            window: null,
          });
        } catch (error) {
          outcome = emptyDetectorResult("errored");
          outcome.error = thrown(error);
        }
        if (runId) {
          await finishRun(runId, outcome).catch((error: unknown) => {
            logError("System audit sweep could not record a detector run", {
              error,
              labels: { event: "system_audit_sweep_run_unrecorded", job: JOB, detector: detector.id },
            });
          });
        }
        result.detectors.push(summary(detector.id, outcome));

        if (outcome.status === "errored") {
          logError(`System audit detector failed: ${detector.id}`, {
            labels: { event: "system_audit_detector_failed", job: JOB, detector: detector.id },
            error: new Error(outcome.error ?? "unknown error"),
          });
          if (isDatabaseUnhealthy(outcome.error)) abortedBy = detector.id;
        }
      }

      if (abortedBy) {
        result.status = "aborted_db_unhealthy";
        result.reason = `Stopped after ${abortedBy}: the database looked unhealthy, so the detectors after it were not run.`;
      } else if (result.detectors.some((row) => row.status !== "ok" && row.status !== "skipped")) {
        result.status = "partial";
      }
    }

    if (sweepRunId) {
      await finishRun(sweepRunId, sweepRunResult(result)).catch((error: unknown) => {
        logError("System audit sweep could not record its own run", {
          error,
          labels: { event: "system_audit_sweep_run_unrecorded", job: JOB, detector: SWEEP_RUN_DETECTOR },
        });
      });
    }

    // Best-effort and never throws (daily-message.ts). Sent while the lease is still held, so an
    // overlapping call cannot race it — and the per-day idempotency key would stop a second one anyway.
    // It is handed the night's result: a night that sat out or stopped is said, never left silent.
    result.dailyMessage = await sendDailyMessage(result);
    return result;
  } finally {
    await releaseLease(holder).catch((error: unknown) => {
      // The lease expires on its own after 300 s; a failed release only delays the next manual run.
      logWarning("System audit sweep could not release its lease", { error, labels: { event: "system_audit_sweep_lease_release_failed", job: JOB } });
    });
  }
}
