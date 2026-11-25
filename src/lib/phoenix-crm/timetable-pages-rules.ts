/**
 * Phoenix CRM — a polyclinic's timetable in more than one photo (owner, 25 Nov 2026: "make the rep able
 * to upload multiple photos for a timetable … and every photo appear … he can validate 1, 2, 3 doctors
 * in one timetable if it has their name").
 *
 * The first photo stays the building's board exactly as before (`schedule_photo_path`, and the
 * `photo_path` of every customer seated there). Pages 2 to 5 hang off that first photo in
 * `phoenix_crm_timetable_pages`, written once per board by `phoenix_crm_add_timetable_pages`.
 *
 * 🔴 A DOCTOR NAMED ON ANY PAGE IS NAMED ON THE TIMETABLE. Each page is read on its own (the question put
 * to the reader still names nobody), each customer's name is judged against every page, and the page that
 * says the most for him is his verdict (`bestTimetablePageCheck`). Every other door rule is the one-photo
 * rule, unchanged: a lost call saves, a board on a screen holds, a clear board without his name holds.
 *
 * Pure: no I/O. The reads live in `server/schedule-check.ts`, the writes in `server/timetable-pages.ts`.
 */

import { SCHEDULE_REREAD_REASONS, type PhoenixCrmScheduleCheck } from "@/lib/phoenix-crm/schedule-rules";

/** Pages after the first one, at most — five photos in all, the database's own CHECK. */
export const TIMETABLE_EXTRA_PAGES_MAX = 4;

export const TIMETABLE_TOO_MANY_PAGES = `A timetable takes ${TIMETABLE_EXTRA_PAGES_MAX + 1} photos at most.`;

/** Under the camera, once the first photo is taken. */
export const TIMETABLE_ADD_PAGE = "Add another photo of the timetable";
export const TIMETABLE_PAGES_HINT =
  "If the timetable does not fit in one photo, or the building has more than one, add a photo for each part. A customer named on any of them counts.";

/** The extra pages the phone sent, cleaned: unique, never the first photo, at most four. */
export function parseExtraPhotoPaths(raw: unknown, firstPath: string | null): { ok: true; paths: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, paths: [] };
  if (!Array.isArray(raw)) return { ok: true, paths: [] };
  const paths: string[] = [];
  for (const entry of raw) {
    const path = typeof entry === "string" ? entry.trim() : "";
    if (!path || path === firstPath || paths.includes(path)) continue;
    paths.push(path);
  }
  // Pages without a first photo say nothing: the board on file keeps its own pages.
  if (!firstPath) return { ok: true, paths: [] };
  if (paths.length > TIMETABLE_EXTRA_PAGES_MAX) return { ok: false, error: TIMETABLE_TOO_MANY_PAGES };
  return { ok: true, paths };
}

/**
 * How strongly one page's verdict speaks for the customer — lower wins.
 *
 * A match beats everything. A page nobody could get an answer about comes next, because the one-photo door
 * already saves on a lost call (`scheduleDoorAction`) and the night reads it again: his name may be on that
 * page. A clear board without his name, then a board too hard to read, then a timetable on a screen, then a
 * photo with no timetable at all.
 */
function rank(check: PhoenixCrmScheduleCheck): number {
  if (check.verdict === "match") return 0;
  if (check.verdict === "unjudged" && check.reason !== null && (SCHEDULE_REREAD_REASONS as readonly string[]).includes(check.reason)) return 1;
  if (check.verdict === "other_name") return 2;
  if (check.verdict === "unjudged") return 3;
  if (check.problem === "on_a_screen") return 4;
  return 5;
}

/**
 * The one verdict a customer keeps from a timetable photographed in several photos: the page that says the
 * most for him, marked with which page it was and how many there were. One page is returned untouched, so a
 * one-photo board keeps exactly the record it always had.
 *
 * Every page's names are kept on the record as well (`personNames`, de-duplicated), so whoever reads the
 * verdict sees everybody the board names, not only the page that decided it.
 */
export function bestTimetablePageCheck(checks: ReadonlyArray<PhoenixCrmScheduleCheck>): PhoenixCrmScheduleCheck | null {
  if (checks.length === 0) return null;
  if (checks.length === 1) return checks[0];
  let best = 0;
  for (let index = 1; index < checks.length; index += 1) {
    if (rank(checks[index]) < rank(checks[best])) best = index;
  }
  const chosen = checks[best];
  const names = [...new Set(checks.flatMap((check) => check.personNames ?? []))].slice(0, 120);
  return { ...chosen, personNames: names, page: best + 1, pages: checks.length };
}

/** The refusal for an extra page the reader is sure shows no timetable, naming which photo it is. */
export function extraPageRefusal(pageNumber: number, refusal: string): string {
  return `Timetable photo ${pageNumber}: ${refusal}`;
}
