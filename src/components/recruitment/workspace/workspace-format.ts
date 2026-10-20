// Recruitment workspace — how the screen words and colours what the server hands it.
//
// WHY ITS OWN FILE. The row, the opened CV, the bulk bar and the manager portal all print the same
// facts — when a CV arrived, what status it is in, what the interview came to, which answer key an
// edit writes — and each used to spell them its own way. One pure file is the one spelling, and it is
// what `tests/recruitment-workspace-screen.test.ts` reads.
//
// TIMES ARE CAIRO WALL-CLOCK, written the owner's way: "19 Oct · 17:32", the year only when it is not
// this year. "This year" is the server's Cairo date handed down as `today`, never a clock read during
// render — a render that reads the clock paints one thing on the server and another in the browser.
//
// Pure and client-safe: no database, no process.env.

import type { RecruitmentPillTone } from "@/components/recruitment/recruitment-premium";
import { CAIRO_MONTHS } from "@/lib/format/cairo-datetime";
import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import { interviewOutcomeLabels, type InterviewOutcome } from "@/lib/recruitment/interview-calendar-types";
import { serializeWorkspaceFilters, type WorkspaceFilters } from "@/lib/recruitment/workspace/filters";
import { workspaceRoleTabLabels, type WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";
import type { WorkspaceCursor, WorkspacePlacement, WorkspaceRow } from "@/lib/recruitment/workspace/types";

const CAIRO_PARTS = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "numeric",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

function cairoParts(iso: string): { day: number; month: number; year: number; time: string } | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = CAIRO_PARTS.formatToParts(instant);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    day: Number(value("day")),
    month: Number(value("month")),
    time: `${value("hour")}:${value("minute")}`,
    year: Number(value("year")),
  };
}

/** "19 Oct · 17:32" in Cairo; "19 Oct 2025 · 17:32" when it is not `today`'s year. Empty for no date. */
export function cairoStamp(iso: string | null | undefined, today: string): string {
  if (!iso) return "";
  const parts = cairoParts(iso);
  if (!parts) return "";
  const thisYear = Number(today.slice(0, 4));
  const month = CAIRO_MONTHS[parts.month - 1] ?? "";
  const day = parts.year === thisYear ? `${parts.day} ${month}` : `${parts.day} ${month} ${parts.year}`;
  return `${day} · ${parts.time}`;
}

/** "19 Oct" (or "19 Oct 2025") in Cairo, without the time. */
export function cairoDayLabel(iso: string | null | undefined, today: string): string {
  return cairoStamp(iso, today).split(" · ")[0] ?? "";
}

// ---------------------------------------------------------------------------------------------
// Status — the 3px left edge and the pill, in the Interview Calendar's colour language
// ---------------------------------------------------------------------------------------------

/** The row's 3px left edge. Sky = new, green = forward, amber = held, orange = with a manager, red = out. */
export const statusEdgeClassName: Record<CandidateStatus, string> = {
  backup: "bg-amber-500",
  hired: "bg-emerald-800",
  new: "bg-sky-600",
  rejected: "bg-red-600",
  sent_to_manager: "bg-orange-600",
  shortlisted: "bg-emerald-600",
};

export const statusTone: Record<CandidateStatus, RecruitmentPillTone> = {
  backup: "amber",
  hired: "emerald",
  new: "sky",
  rejected: "rose",
  sent_to_manager: "orange",
  shortlisted: "emerald",
};

/** The pill skin per tone, at 11px — the kit's own pill is 10px, below the owner's floor. */
export const chipToneClassName: Record<RecruitmentPillTone, string> = {
  amber: "border-amber-200 bg-amber-50 text-amber-900",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  orange: "border-orange-200 bg-orange-50 text-orange-900",
  rose: "border-rose-200 bg-rose-50 text-rose-900",
  sky: "border-sky-200 bg-sky-50 text-sky-900",
  slate: "border-slate-200 bg-slate-50 text-slate-700",
};

// ---------------------------------------------------------------------------------------------
// Interview outcome — what the row's chip says
// ---------------------------------------------------------------------------------------------

const PASSED = new Set(["shortlisted", "prioritized"]);
const NO_SHOW = new Set(["did_not_come", "no_answer", "withdrew", "will_reschedule"]);

/** The interview chip: passed, failed, a no-show, or the booked time when there is no outcome yet. */
export function interviewChip(
  interview: WorkspaceRow["interview"],
  today: string,
): { label: string; tone: RecruitmentPillTone } | null {
  if (!interview) return null;
  const outcome = interview.outcome;
  const word = outcome ? interviewOutcomeLabels[outcome as InterviewOutcome] ?? outcome : null;
  if (outcome && PASSED.has(outcome)) return { label: `Interview passed · ${word}`, tone: "emerald" };
  if (outcome === "rejected") return { label: "Interview failed", tone: "rose" };
  if (outcome === "backup") return { label: "Interview · Back-up", tone: "amber" };
  if (outcome && NO_SHOW.has(outcome)) return { label: `No-show · ${word}`, tone: "amber" };
  if (outcome) return { label: `Interview · ${word}`, tone: "sky" };
  return { label: `Interview ${cairoStamp(interview.startsAt, today)}`, tone: "sky" };
}

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

/**
 * The key the answer-edit route (`PATCH …/whatsapp-answer`) takes for a chip. The chip's built-in
 * "role" is the bot's `job_title` step; the other five built-ins keep their names; every
 * admin-defined question is written as `extra:<key>`.
 */
const BUILT_IN_EDIT_KEYS: Record<string, string> = {
  area: "area",
  background: "background",
  experience: "experience",
  region: "region",
  role: "job_title",
  salary: "salary",
};

export function answerEditKey(chipKey: string): string {
  return BUILT_IN_EDIT_KEYS[chipKey] ?? `extra:${chipKey}`;
}

export function completenessLabel(completeness: WorkspaceRow["completeness"]): string | null {
  if (!completeness || completeness.expected <= 0) return null;
  return `${completeness.given} of ${completeness.expected} answered`;
}

export function missingAnswerCount(row: Pick<WorkspaceRow, "answers" | "completeness">): number {
  const fromChips = row.answers.filter((chip) => chip.value === null).length;
  return Math.max(fromChips, row.completeness ? row.completeness.expected - row.completeness.given : 0);
}

// ---------------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------------

/** "Medical Rep · Alexandria · Alex-BHR" — where one filing puts this person. */
export function placementLabel(placement: WorkspacePlacement): string {
  const parts: string[] = [workspaceRoleTabLabels[placement.tab] ?? placement.tab];
  if (placement.regionName) parts.push(placement.regionName);
  if (placement.areaName) parts.push(placement.areaName);
  return parts.join(" · ");
}

/** Every tab this person is filed in other than the one being viewed — the "also applied for" mark. */
export function otherPlacements(row: Pick<WorkspaceRow, "placements">, viewing: string | null): WorkspacePlacement[] {
  return row.placements.filter((placement) => placement.tab !== viewing);
}

export function placedByLabel(placement: WorkspacePlacement): string {
  switch (placement.placedBy) {
    case "whatsapp":
      return "from the WhatsApp reply";
    case "website":
      return "from the careers form";
    case "migration":
      return "carried over";
    default:
      return placement.placedByName ? `added by HR · ${placement.placedByName}` : "added by HR";
  }
}

// ---------------------------------------------------------------------------------------------
// The rows query
// ---------------------------------------------------------------------------------------------

/** `<createdAt>~<id>`, the rows route's `after` parameter. */
export function cursorParam(cursor: WorkspaceCursor): string {
  return `${cursor.createdAt}~${cursor.id}`;
}

/**
 * The filters the rows, counts, arrivals and export routes are asked with. A search looks across
 * EVERY tab the reader can see (owner: "one search box for everything"), so while one is typed the
 * tab and the place are left out — the server reads "a search with no tab" as everywhere. The page
 * keeps its tab in the address bar, so clearing the search lands back where the reader was.
 */
export function listFilters(filters: WorkspaceFilters): WorkspaceFilters {
  const base = { ...filters, candidate: null };
  return filters.search ? { ...base, area: null, region: null, tab: null } : base;
}

/** The filter query the rows, counts, arrivals and export routes read — without the opened CV. */
export function filterQuery(filters: WorkspaceFilters): string {
  return serializeWorkspaceFilters(listFilters(filters)).toString();
}

/** The page's own URL query — the filters plus the opened CV. */
export function pageQuery(filters: WorkspaceFilters): string {
  return serializeWorkspaceFilters(filters).toString();
}

/** A role tab's label, or the raw key when the vocabulary has none (never blank). */
export function roleTabLabel(tab: WorkspaceRoleTab | string): string {
  return (workspaceRoleTabLabels as Record<string, string>)[tab] ?? tab;
}

/** A plain, stable message from anything thrown. */
export function errorText(error: unknown, fallback = "Something went wrong."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
