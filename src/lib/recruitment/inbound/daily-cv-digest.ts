// Recruitment / ATS — one Cairo-daily summary of the CVs that arrived, in place of one alert per CV.
//
// Measured against production on 2026-08-15: 628 `recruitment_inbound_cv` deliveries reached 3
// Talent Acquisition reviewers over 30 days — roughly 21 CVs a day, each one raising its own in-app
// item, Telegram message and push. Nobody reads the twenty-first notification of the day, and the
// consequence is not merely noise: the alert that DOES matter (a CV whose file could not be
// attached, a dead-letter, an intake spike) arrives in the same stream and is muted along with the
// rest. The pool screen already shows what arrived and when, so the per-CV push was telling a
// reviewer something the screen tells them better.
//
// So this replaces the twenty-one with one. It is deliberately a SUMMARY, not a list of names: the
// digest exists to answer "is there work waiting, and what kind" in one line, and the names are one
// click away on a screen built to show them.
//
// The pure half (buildDailyCvDigest, dailyCvDigestMessage) takes rows and returns text, so the
// wording and the counting are unit-testable without a database, a clock or a notification.

import { isUnreviewedCandidateStatus } from "@/lib/recruitment/candidate-status";
import { recruitmentDb } from "@/lib/recruitment/db";
import { cairoDateKey, cairoHour } from "@/lib/recruitment/inbound/whatsapp-health";

/**
 * Whether ONE arriving CV still deserves its own alert now that the day is summarised here.
 *
 * The answer is no for a CV that arrived normally — that is what the digest is for. It stays YES for
 * a CV whose file could not be attached, because that is not routine arrival: it is a candidate
 * record with no CV behind it, needing a human to open the original message, and it is rare enough
 * to never become noise. Same reasoning this module's siblings already apply to the dead-letter and
 * spike alerts — the exception pages, the routine accumulates.
 *
 * It lives here rather than beside the notification it gates so it can be tested as a pure rule,
 * without loading the notification pipeline.
 */
export function shouldAlertImmediatelyForInboundCv(input: { fileAttached: boolean }): boolean {
  return !input.fileAttached;
}

/**
 * The Cairo hour the digest is sent in. 18:00 rather than the end of the day: the intake runs on the
 * every-10-minute email cron, so a digest can only fire on one of those ticks, and 18:00 puts it
 * after a Cairo working day's arrivals while there is still somebody at a desk to act on it.
 *
 * The cron ticks six times inside that hour. Only the first one actually delivers — the notification
 * layer claims a per-recipient idempotency key derived from the Cairo date (see
 * notifyDailyCvDigest), and a claim that loses the race is dropped before anything is sent.
 */
export const DAILY_CV_DIGEST_CAIRO_HOUR = 18;

/**
 * How far back the loader reads. The digest only ever reports ONE Cairo day, but "today in Cairo"
 * spans up to 26 hours of UTC depending on the hour the job fires, and Egypt observes DST — so the
 * window is deliberately generous and the day boundary is decided by cairoDateKey on each row, not
 * by arithmetic on a timestamp.
 */
const LOOKBACK_HOURS = 36;

/** What the digest needs off a candidate row. Nothing else is read, so nothing else can go stale. */
export type DailyCvDigestRow = {
  appliedForJobTitle?: string | null;
  createdAt?: string | null;
  source?: string | null;
  status?: string | null;
};

export type DailyCvDigestGroup = { count: number; label: string };

export type DailyCvDigest = {
  /** Of the day's arrivals, how many nobody has looked at yet. */
  awaitingReview: number;
  byJobTitle: DailyCvDigestGroup[];
  bySource: DailyCvDigestGroup[];
  /** Africa/Cairo YYYY-MM-DD — the day being reported, and the throttle bucket. */
  dayKey: string;
  total: number;
};

/**
 * What the AI reads off the CV when the applicant says what they are applying for. Blank is common
 * and is shown as its own group rather than being dropped: "9 of today's 21 did not say" is exactly
 * the kind of thing a recruiter wants to know, and a silently omitted group would make the numbers
 * under the total stop adding up to it.
 */
const UNSTATED_JOB_TITLE = "Role not stated";

const UNRECORDED_SOURCE = "Source not recorded";

/** `source` is written as the intake channel (see cv-intake-service.ts), so these are the two live values. */
const SOURCE_LABELS: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
};

function sourceLabel(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  // Anything unrecognised is shown verbatim rather than folded into an "other" bucket — a value
  // somebody or something recorded is information, and the owner's rule is that text is never hidden.
  return SOURCE_LABELS[raw.toLowerCase()] ?? raw;
}

/** Counts by label, biggest first, ties alphabetical so the same day always reads the same way. */
function groupByLabel(values: Array<string | null | undefined>, fallback: string): DailyCvDigestGroup[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = String(value ?? "").trim() || fallback;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts, ([label, count]) => ({ count, label })).sort(
    (left, right) => right.count - left.count || left.label.localeCompare(right.label),
  );
}

function isOnCairoDay(createdAt: string | null | undefined, dayKey: string): boolean {
  const raw = String(createdAt ?? "").trim();
  if (!raw) return false;
  const stamped = new Date(raw);
  if (Number.isNaN(stamped.getTime())) return false;
  return cairoDateKey(stamped) === dayKey;
}

/**
 * Pure. Rows in, counts out — the caller decides which rows to hand over and the day key decides
 * which of them count.
 */
export function buildDailyCvDigest(rows: readonly DailyCvDigestRow[], dayKey: string): DailyCvDigest {
  const arrived = rows.filter((row) => isOnCairoDay(row.createdAt, dayKey));
  return {
    awaitingReview: arrived.filter((row) => isUnreviewedCandidateStatus(row.status)).length,
    byJobTitle: groupByLabel(
      arrived.map((row) => row.appliedForJobTitle),
      UNSTATED_JOB_TITLE,
    ),
    bySource: groupByLabel(
      arrived.map((row) => sourceLabel(row.source)),
      UNRECORDED_SOURCE,
    ),
    dayKey,
    total: arrived.length,
  };
}

export function dailyCvDigestTitle(digest: DailyCvDigest): string {
  return digest.total === 1 ? "1 CV arrived today" : `${digest.total} CVs arrived today`;
}

/**
 * The message body. Every group is listed — no ellipsis and no "and N others", per the owner's
 * standing rule that text is never truncated. The number of distinct job titles in a single day is
 * bounded by the number of CVs in that day, which is ~21.
 */
export function dailyCvDigestMessage(digest: DailyCvDigest): string {
  if (digest.total === 0) return "";

  const lines: string[] = [];
  lines.push(
    digest.awaitingReview === 0
      ? "Every one of them has already been looked at."
      : `${digest.awaitingReview} of them ${digest.awaitingReview === 1 ? "is" : "are"} still waiting for a first look.`,
  );

  lines.push("");
  lines.push("Applying for:");
  for (const group of digest.byJobTitle) lines.push(`- ${group.label} — ${group.count}`);

  lines.push("");
  lines.push("Arrived by:");
  for (const group of digest.bySource) lines.push(`- ${group.label} — ${group.count}`);

  return lines.join("\n");
}

const DIGEST_COLUMNS = "applied_for_job_title,created_at,source,status";
const PRE_MIGRATION_DIGEST_COLUMNS = "created_at,source,status";

type CandidateDigestDbRow = {
  applied_for_job_title?: string | null;
  created_at?: string | null;
  source?: string | null;
  status?: string | null;
};

function mapDigestRow(row: CandidateDigestDbRow): DailyCvDigestRow {
  return {
    appliedForJobTitle: row.applied_for_job_title ?? null,
    createdAt: row.created_at ?? null,
    source: row.source ?? null,
    status: row.status ?? null,
  };
}

/**
 * Reads the recent candidate rows the digest might report on. Four columns only — never `select("*")`,
 * which would drag every jsonb extraction block across the Atlantic for a job that needs a count.
 *
 * The narrow select is retried without `applied_for_job_title` on a 42703 (undefined column), which
 * is the pre-migration state: 20260815200000_candidate_applied_for_role adds it, that migration is a
 * separate announced production step, and the code reaches production on the merge — so there is a
 * real window in which new code reads a table without that column. Every other error is thrown.
 */
export async function loadRecentCandidateDigestRows(now: Date = new Date()): Promise<DailyCvDigestRow[]> {
  const since = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();
  const supabase = recruitmentDb();

  const first = await supabase.from("ats_candidates").select(DIGEST_COLUMNS).gte("created_at", since);
  if (!first.error) return ((first.data ?? []) as CandidateDigestDbRow[]).map(mapDigestRow);
  if ((first.error as { code?: string }).code !== "42703") throw first.error;

  const fallback = await supabase.from("ats_candidates").select(PRE_MIGRATION_DIGEST_COLUMNS).gte("created_at", since);
  if (fallback.error) throw fallback.error;
  return ((fallback.data ?? []) as CandidateDigestDbRow[]).map(mapDigestRow);
}

/** True only inside the one Cairo hour the digest is allowed to send in. Pure, so the gate is testable. */
export function isDailyCvDigestHour(hour: number): boolean {
  return hour === DAILY_CV_DIGEST_CAIRO_HOUR;
}

/** The same gate against a real instant — what the cron actually calls. */
export function isDailyCvDigestTime(now: Date = new Date()): boolean {
  return isDailyCvDigestHour(cairoHour(now));
}

/** Builds today's digest from live data. Returns a digest with total 0 when nothing arrived. */
export async function buildTodaysCvDigest(now: Date = new Date()): Promise<DailyCvDigest> {
  const rows = await loadRecentCandidateDigestRows(now);
  return buildDailyCvDigest(rows, cairoDateKey(now));
}
