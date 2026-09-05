// Recruitment / ATS — the shared reading of the silent manager-engagement report.
//
// Everything that decides what the report SAYS lives here rather than in either reader: which
// managers a filter keeps, how one manager's CVs bucket into areas, how an inactive manager is
// worded, and how an instant becomes a Cairo date. Two readers consume it — the screen
// (manager-engagement-view.tsx) and the XLSX export (manager-engagement-workbook.ts) — and the
// owner's standing rule is that an export MATCHES the screen it was taken from. A second copy of
// any of these four rules is exactly how a workbook starts answering a different question than the
// page above it, so there is one copy and both sides import it.
//
// PURE and client-safe on purpose: no database, no ExcelJS, no React. The view is a "use client"
// module and imports this directly; the workbook is server-only and imports the same functions.

import type { ManagerCvEngagementCandidate, ManagerCvEngagementRow } from "@/lib/recruitment/manager-cv-engagement";

/**
 * The two non-area buckets in a manager's CV list, always sorted after the real areas.
 *
 * "No area named" is the district catch-all the folder rule fills (REGION_FOLDER_LABEL in
 * district-manager-folders.ts); "Sent directly" is where a hand-push that belongs to no folder
 * lands. Held as local strings so this pure module need not import the folder module — were that
 * label ever renamed, the group would simply sort among the areas rather than break.
 */
export const NO_AREA_LABEL = "No area named";
export const SENT_DIRECTLY_LABEL = "Sent directly";

const CAIRO_TIME_ZONE = "Africa/Cairo";

/** The instant as a real Date, or null when there is nothing (or nothing parseable) to show. */
function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : value;
}

/**
 * Which CAIRO calendar day an instant falls on — the one resolver both readers date from.
 *
 * Returned as parts rather than a Date because the two consumers need it two ways: the screen and
 * the sheet's text want it formatted, and an Excel cell wants a serial number. Deriving the day
 * twice, once per reader, is how a CV that arrived at 01:00 Cairo ends up on two different dates.
 */
export function cairoCalendarDay(iso: string | null | undefined): { year: number; month: number; day: number } | null {
  const value = parseInstant(iso);
  if (!value) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    timeZone: CAIRO_TIME_ZONE,
    year: "numeric",
  }).formatToParts(value);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

/**
 * A date the way this report shows one — "05 Sep 2026", Cairo local, never a raw UTC string. The
 * owner's standing rule is Africa/Cairo everywhere, and an empty string for "no date" so a cell or
 * a table row simply reads blank rather than "Invalid Date".
 */
export function cairoEngagementDate(iso: string | null | undefined): string {
  const value = parseInstant(iso);
  if (!value) return "";
  return value.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: CAIRO_TIME_ZONE,
    year: "numeric",
  });
}

/** A date AND a wall-clock time, Cairo, labelled as such — used for "generated at" provenance. */
export function cairoEngagementStamp(iso: string | null | undefined): string {
  const value = parseInstant(iso);
  if (!value) return "";
  const time = value.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    timeZone: CAIRO_TIME_ZONE,
  });
  return `${cairoEngagementDate(iso)}, ${time} (Cairo)`;
}

/**
 * How a manager who has left is worded — "Resigned · left 31 Aug 2026".
 *
 * The reader needs to know that a wall of unopened CVs sitting on this row is stranded on somebody
 * who is gone: those CVs need reassigning, not a nudge to the manager. The label is whatever the
 * directory recorded (Resigned / Terminated / …), falling back to a plain "Inactive" when it
 * recorded nothing.
 */
export function managerInactiveText(label: string | null, lastWorkingDate: string | null): string {
  const suffix = lastWorkingDate ? ` · left ${cairoEngagementDate(lastWorkingDate)}` : "";
  return `${label || "Inactive"}${suffix}`;
}

/** The same wording as one column value: "Active", or the inactive text above. */
export function managerStatusText(
  row: Pick<ManagerCvEngagementRow, "employmentStatusLabel" | "inactive" | "lastWorkingDate">,
): string {
  return row.inactive ? managerInactiveText(row.employmentStatusLabel, row.lastWorkingDate) : "Active";
}

/**
 * The screen's manager filter, as a function — a case-insensitive substring over the four fields the
 * search box names in its own placeholder (manager, job title, area, line). A blank query keeps
 * every row.
 *
 * Shared with the export so a filtered sheet holds exactly the managers that were on screen when the
 * button was pressed. Generic over the row so the caller keeps its own row type.
 */
export function filterManagerEngagementRows<
  Row extends Pick<ManagerCvEngagementRow, "managerArea" | "managerJobTitle" | "managerLine" | "managerName">,
>(rows: readonly Row[], query: string): Row[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.managerName, row.managerJobTitle, row.managerArea, row.managerLine]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle)),
  );
}

/**
 * One manager's CVs, GROUPED BY AREA — what the expanded row shows, and what the export's CV sheet
 * writes in order.
 *
 * The candidates already arrive newest-first, so bucketing them in order keeps that order inside
 * each area. Named areas sort first (A→Z), then the district catch-all, then anything hand-pushed
 * with no folder.
 */
export function groupEngagementCandidatesByArea(
  candidates: readonly ManagerCvEngagementCandidate[],
): Array<{ area: string; list: ManagerCvEngagementCandidate[] }> {
  const byArea = new Map<string, ManagerCvEngagementCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.area?.trim() || SENT_DIRECTLY_LABEL;
    const list = byArea.get(key);
    if (list) list.push(candidate);
    else byArea.set(key, [candidate]);
  }
  const rank = (name: string) => (name === SENT_DIRECTLY_LABEL ? 2 : name === NO_AREA_LABEL ? 1 : 0);
  return [...byArea.keys()]
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
    .map((area) => ({ area, list: byArea.get(area) ?? [] }));
}
