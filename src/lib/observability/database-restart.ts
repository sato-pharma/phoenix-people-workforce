// THE JUDGEMENT behind the database restart alarm — pure, no IO, so the unit suite can import it
// without pulling `@/lib/supabase/server` into a test (the same split as `job-heartbeat-assess.ts`).
//
// The account of the two crash-restarts this exists to catch is in the migration header
// (`20261013150000_database_restart_watch.sql`) and in docs/observability.md. The one rule worth
// restating here: a restart is `pg_postmaster_start_time()` MOVING, and nothing else. Not an edge
// status code, not a 5xx count, not project status — the project reads ACTIVE_HEALTHY a minute
// afterwards, because by then it is.

/** Exactly what `public.note_database_restart()` returns, in app shape. */
export type DatabaseRestartObservation = {
  currentStartAt: string;
  isNew: boolean;
  previousStartAt: string | null;
};

export type DatabaseRestartVerdict =
  /** The start time is one we have already recorded — the database has not restarted. */
  | { kind: "unchanged"; currentStartAt: string }
  /**
   * A start time we had never seen, with nothing before it. The watch has only just been
   * installed, or the table was emptied. NEVER alerts: the alternative is that installing the
   * alarm fires it, which trains the owner to ignore it on the day it ships.
   */
  | { kind: "first-sighting"; currentStartAt: string }
  /** A start time we had never seen, with an older one on record. The database restarted. */
  | { kind: "restarted"; currentStartAt: string; previousStartAt: string; upForMs: number };

/** Africa/Cairo, per the owner's standing rule that every time he reads is Cairo local. */
export function cairoTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    second: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(parsed);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")} ${get("hour")}:${get("minute")}:${get("second")} Cairo`;
}

/** Whole days and hours, for "it had been up for …" — never an ellipsis, never a bare millisecond. */
export function describeUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "an unknown length of time";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0
      ? `${hours} hour${hours === 1 ? "" : "s"}`
      : `${hours} hour${hours === 1 ? "" : "s"} ${rest} minute${rest === 1 ? "" : "s"}`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0
    ? `${days} days`
    : `${days} days ${restHours} hour${restHours === 1 ? "" : "s"}`;
}

/**
 * Turn one observation into a verdict.
 *
 * `isNew` is the only thing that decides whether something happened — it is TRUE only when the
 * database itself inserted the row, which makes the check safe to run from several replicas at
 * once: the second caller's insert conflicts, so exactly one of them reports the restart.
 */
export function assessDatabaseRestart(observation: DatabaseRestartObservation): DatabaseRestartVerdict {
  if (!observation.isNew) {
    return { currentStartAt: observation.currentStartAt, kind: "unchanged" };
  }
  if (!observation.previousStartAt) {
    return { currentStartAt: observation.currentStartAt, kind: "first-sighting" };
  }
  const upForMs = new Date(observation.currentStartAt).getTime() - new Date(observation.previousStartAt).getTime();
  return {
    currentStartAt: observation.currentStartAt,
    kind: "restarted",
    previousStartAt: observation.previousStartAt,
    upForMs: Number.isFinite(upForMs) ? upForMs : 0,
  };
}

/** True when a human should be paged. Only a proven restart qualifies. */
export function shouldAlertOnRestart(verdict: DatabaseRestartVerdict): boolean {
  return verdict.kind === "restarted";
}

/**
 * The message a human reads. Pure, so the suite pins its wording.
 *
 * It says what to do next, because an alarm that only reports a fact gets read once and then
 * ignored: the two reads that turn "it restarted" into "this is the same fault as before" are
 * named here rather than left in a doc nobody opens at the moment the phone buzzes.
 */
export function buildDatabaseRestartMessage(verdict: DatabaseRestartVerdict): string {
  if (verdict.kind !== "restarted") return "";
  return [
    "🛑 The production database restarted.",
    "",
    `It came back up at ${cairoTimestamp(verdict.currentStartAt)}.`,
    `The run before it started at ${cairoTimestamp(verdict.previousStartAt)}, so it had been up for ${describeUptime(verdict.upForMs)}.`,
    "",
    "While it was down, every REST read failed — the browser sees Cloudflare 521/520/525 and",
    "PostgREST 503, pages stall, and nobody is signed out. It recovers by itself.",
    "",
    "The two reads that tell you whether this is the same fault as 10 and 12 October 2026:",
    "the Postgres log around that minute (an unclean restart says \"database system was not",
    "properly shut down\" with no shutdown request and no PANIC, which means the process was",
    "killed from outside), and cron.job_run_details for a job whose message is \"server restarted\".",
  ].join("\n");
}
