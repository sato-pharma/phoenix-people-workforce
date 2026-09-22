// Recruitment / ATS — dashboard aggregation for the admin pages.

import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import { listApplications, type ApplicationWithContext } from "@/lib/recruitment/applications";
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

export type RecruitmentDashboard = {
  requisitions: Requisition[];
  applications: ApplicationWithContext[];
  summary: {
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
  const clean = (value?: string | null) =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : null;

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
  options: { hiredWindow?: HiredWindow } = {},
): Promise<RecruitmentDashboard> {
  const [requisitions, applications] = await Promise.all([
    listRequisitions(access),
    listApplications(access),
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
    requisitions,
    applications,
    summary: {
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
