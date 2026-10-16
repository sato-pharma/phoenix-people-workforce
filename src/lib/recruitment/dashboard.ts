// Recruitment / ATS — dashboard aggregation for the admin pages.

import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import { listApplications, type ApplicationWithContext } from "@/lib/recruitment/applications";
import { type CandidateStatus } from "@/lib/recruitment/candidate-status";
import { recruitmentDb } from "@/lib/recruitment/db";
import { candidatePoolCountsFromTotals } from "@/lib/recruitment/pool-enrichment";
import { listRequisitions } from "@/lib/recruitment/requisitions";
import {
  applicationStages,
  isTerminalApplicationStage,
  type Requisition,
} from "@/lib/recruitment/types";

/**
 * The window the HIRED figure is counted over.
 *
 * `hires` is every application that ever reached the hired stage. That total is true, and it is
 * the wrong number to print beside "In Screening", "Interviewing" and "Active Candidates", which
 * are all counts of the pipeline AS IT STANDS. Read next to them, a lifetime total says the
 * company hired that many people recently — and it will still read 47 when the last hire was two
 * years ago. So the tile counts a WINDOW, and `hires` stays under its own honest name for
 * anything that genuinely wants the lifetime figure.
 *
 * Default: the running Cairo month (owner, 2026-09-22 — "make it by default cairo current month
 * but i have the option to date picker from to"). Both bounds are INCLUSIVE `YYYY-MM-DD` dates in
 * Cairo, because that is what a date picker hands back and the owner reads every time in Cairo.
 */
export type HiredWindow = {
  /** Inclusive `YYYY-MM-DD`, Cairo. */
  fromIso: string;
  /** Inclusive `YYYY-MM-DD`, Cairo. */
  toIso: string;
};

/**
 * How many candidates sit in each pile of the candidate pool (`ats_candidates.status`).
 *
 * THE POOL IS THE RECRUITMENT PIPELINE THAT PEOPLE ACTUALLY WORK. On production on 2026-10-14 it held
 * 1,417 candidates — 741 undecided, 124 shortlisted, 32 with a hiring manager — while the applications
 * half of the ATS held 38 rows, all of whom are also in the pool. The overview used to count the 38 and
 * call them "Active Candidates", so it understated the live pipeline thirty-fold.
 */
export type CandidatePoolCounts = Record<CandidateStatus, number>;

/**
 * Counts only — no candidate row leaves this function, so it is safe on any seat's overview.
 *
 * `new` is the remainder after the five other piles are taken off the total, not a count of its own:
 * the decision tabs file a status nothing can read under "not decided yet", and counting the same way
 * keeps this figure equal to the pile the recruiter sees (`candidatePoolCountsFromTotals`, shared with
 * the page's own derivation from the pool rows, so the two cannot disagree).
 *
 * Six requests, one per pile. The Recruitment page does not make them: it already reads the whole pool,
 * so it hands the dashboard counts taken from those rows (`candidatePoolCounts`, below) and this read
 * stays for the callers with no pool in hand, and as the fallback when the pool read fails.
 */
export async function getCandidatePoolCounts(): Promise<CandidatePoolCounts> {
  const db = recruitmentDb();
  const countOf = async (status?: CandidateStatus): Promise<number> => {
    const base = db.from("ats_candidates").select("id", { count: "exact", head: true });
    const { count, error } = status ? await base.eq("status", status) : await base;
    if (error) throw new Error(error.message);
    return count ?? 0;
  };
  const [total, shortlisted, backup, sentToManager, rejected, hired] = await Promise.all([
    countOf(),
    countOf("shortlisted"),
    countOf("backup"),
    countOf("sent_to_manager"),
    countOf("rejected"),
    countOf("hired"),
  ]);
  return candidatePoolCountsFromTotals({ backup, hired, rejected, sentToManager, shortlisted, total });
}

/** One CV nobody has decided on yet, as the "Screen" queue names it. */
export type AwaitingReviewRow = {
  fullName: string | null;
  id: string;
  /** When the CV reached us (`created_at`), so the queue can say how long it has waited. */
  receivedAt: string | null;
  /** The intake channel code, shown through `intakeSourceLabel` and never raw. */
  source: string | null;
};

/**
 * The CVs that have waited longest with no decision, oldest first.
 *
 * THE SCREEN QUEUE READS THE CANDIDATE POOL (owner, 2026-10-16: "count new candidates"). It used to
 * read applications against a requisition, which is a half of the ATS almost nobody uses — it read
 * 0 on the day 754 candidates sat at status New. The total comes from `getCandidatePoolCounts().new`
 * so it equals the "Awaiting Review" figure everywhere else; this read only NAMES the first few, and
 * a row is a strict `new` while the total also holds any legacy free-text status, so the two can
 * differ by a handful and the total is the one that counts.
 */
export async function listAwaitingReview(limit: number): Promise<AwaitingReviewRow[]> {
  const { data, error } = await recruitmentDb()
    .from("ats_candidates")
    .select("id,full_name,created_at,source")
    .eq("status", "new")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as {
    created_at: string | null;
    full_name: string | null;
    id: string;
    source: string | null;
  }[]).map((row) => ({
    fullName: row.full_name,
    id: String(row.id),
    receivedAt: row.created_at,
    source: row.source,
  }));
}

export type RecruitmentDashboard = {
  /**
   * The longest-waiting CVs with no decision. Present only when the caller asked for them
   * (`awaitingReviewLimit`), because it is one more read and only the HR task queue names them.
   */
  awaitingReview?: AwaitingReviewRow[];
  requisitions: Requisition[];
  applications: ApplicationWithContext[];
  summary: {
    /** The candidate pool by status — what the overview's candidate tiles and funnel count. */
    candidatePool: CandidatePoolCounts;
    totalRequisitions: number;
    openRequisitions: number;
    totalApplications: number;
    activeApplications: number;
    /** Every application that ever reached the hired stage. Lifetime, never a period. */
    hires: number;
    /** Hires whose stage moved to hired inside `hiredWindow`. This is what the tile shows. */
    hiresInWindow: number;
    /** The window `hiresInWindow` covers, so a caption can NAME it instead of implying it. */
    hiredWindow: HiredWindow;
    stageCounts: Record<string, number>;
  };
};

/** First and last day of the running Cairo month, inclusive, as `YYYY-MM-DD`. */
export function currentCairoMonthWindow(now: Date = new Date()): HiredWindow {
  const { year, month } = currentCairoDateParts(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  // Day 0 of the NEXT month is the last day of this one — no month-length table, and February in
  // a leap year comes out right with no special case.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { fromIso: `${year}-${pad(month)}-01`, toIso: `${year}-${pad(month)}-${pad(lastDay)}` };
}

/**
 * Normalise whatever reached us from the URL into a usable window.
 *
 * A picker can hand back one bound, neither, a malformed string, or a range the wrong way round.
 * None of those may produce a count that looks authoritative and is not, so anything unusable
 * falls back to the running Cairo month, and a reversed range is SWAPPED rather than counting
 * zero — a tile reading 0 is a claim, and "no hires" is the most misleading claim it can make.
 */
export function resolveHiredWindow(
  input: { from?: string | null; to?: string | null } = {},
  now: Date = new Date(),
): HiredWindow {
  const fallback = currentCairoMonthWindow(now);
  // A REAL calendar day, not just the right shape: "2026-13-45" matches a digit pattern, rolls over
  // inside the Cairo conversion without an error, and then fails far from here ("Invalid time
  // value") and takes the whole page down. `2026-02-31` would silently have become 3 March.
  const clean = (value?: string | null) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const [year, month, day] = text.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
      ? text
      : null;
  };

  const from = clean(input.from) ?? fallback.fromIso;
  const to = clean(input.to) ?? fallback.toIso;
  return from <= to ? { fromIso: from, toIso: to } : { fromIso: to, toIso: from };
}

/**
 * Is this application's move to `hired` inside the window?
 *
 * The timestamp is `lastStageChangedAt`, not `updatedAt`: `updatedAt` moves when an offer id is
 * attached or a note is edited, which would drag a year-old hire into this month. `hired` is a
 * terminal stage, so for a hired application the last stage change IS the hire.
 *
 * The comparison is made on the CAIRO calendar day, not on the raw UTC timestamp. A hire stamped
 * 2026-09-30T22:30Z is 1 October in Cairo, and the owner reads every date in Cairo.
 *
 * A hired application with no usable stamp is counted OUT of every window rather than into all of
 * them: it cannot be placed in time, and inventing a date for it would put a hire in a month that
 * never had one.
 */
export function isHiredInsideWindow(
  application: Pick<ApplicationWithContext, "stage" | "lastStageChangedAt">,
  window: HiredWindow,
): boolean {
  if (application.stage !== "hired") return false;
  const stamp = application.lastStageChangedAt;
  if (typeof stamp !== "string" || !stamp.trim()) return false;
  const parsed = new Date(stamp);
  if (Number.isNaN(parsed.getTime())) return false;
  const dayIso = currentCairoDateOnlyIso(parsed);
  return dayIso >= window.fromIso && dayIso <= window.toIso;
}

export async function getRecruitmentDashboard(
  access: AccessContext,
  options: {
    awaitingReviewLimit?: number;
    /**
     * The pool's piles, counted from the pool rows the caller is already reading — resolved to null
     * when that read failed. Given, the six `head` counts are not made; null falls back to them, so a
     * failed pool still leaves the dashboard its figures. Only a caller whose rows ARE the whole pool
     * may pass this: a page whose viewer may not read candidates holds an empty list, which would
     * count as an empty pool.
     */
    candidatePoolCounts?: Promise<CandidatePoolCounts | null>;
    hiredWindow?: HiredWindow;
  } = {},
): Promise<RecruitmentDashboard> {
  const [requisitions, applications, candidatePool, awaitingReview] = await Promise.all([
    listRequisitions(access),
    listApplications(access),
    (async () => (options.candidatePoolCounts ? await options.candidatePoolCounts : null) ?? getCandidatePoolCounts())(),
    options.awaitingReviewLimit ? listAwaitingReview(options.awaitingReviewLimit) : undefined,
  ]);

  const stageCounts: Record<string, number> = {};
  for (const stage of applicationStages) stageCounts[stage] = 0;
  for (const application of applications) {
    stageCounts[application.stage] = (stageCounts[application.stage] ?? 0) + 1;
  }

  const openRequisitions = requisitions.filter((requisition) =>
    ["req_open", "req_published"].includes(requisition.status),
  ).length;
  const activeApplications = applications.filter(
    (application) => !isTerminalApplicationStage(application.stage),
  ).length;
  const hires = applications.filter((application) => application.stage === "hired").length;

  const hiredWindow = options.hiredWindow ?? currentCairoMonthWindow();
  const hiresInWindow = applications.filter((application) =>
    isHiredInsideWindow(application, hiredWindow),
  ).length;

  return {
    ...(awaitingReview ? { awaitingReview } : {}),
    requisitions,
    applications,
    summary: {
      candidatePool,
      totalRequisitions: requisitions.length,
      openRequisitions,
      totalApplications: applications.length,
      activeApplications,
      hires,
      hiresInWindow,
      hiredWindow,
      stageCounts,
    },
  };
}
