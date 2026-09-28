// Business Review — what counts as a leaver.
//
// A resigned / terminated / exited occupant no longer holds their seat, so the review treats the seat
// as VACANT (owner, 2026-09-28: resigned reps must read vacant and be cleared by "Exclude vacant").
// One authority, deliberately pure and client-safe — imported by the seat builder and the area/DM
// vacancy check on the server AND by the people table in the browser, so the three can never drift.

/** True when an employment status means the person has left the company. */
export function isResignedStatus(status: string | null | undefined): boolean {
  return /resign|terminat|exit/i.test(status ?? "");
}

/**
 * A leaver's name, marked with the day he left — owner's ruling, 2026-09-28.
 *
 * 🔴 WHY THE NAME STAYS. A Jul–Aug review is about Jul–Aug, and this district manager ran Pedia's
 * Upper Egypt through July; dropping him would leave seven areas' sales with nobody who managed
 * them. But the pack printed him exactly as it prints a serving manager, so a document read in
 * September presented a man who resigned on 31 August as the current DM — and the owner read it
 * that way. The period keeps its truth; the page stops implying he is still here.
 *
 * 🔴 THE SCREEN'S RULE IS DIFFERENT AND STAYS DIFFERENT. There a resigned occupant makes the seat
 * read VACANT (#4609), because the screen answers "who holds this territory NOW". The pack answers
 * "who ran these months". Do not unify them.
 */
/**
 * The mark `leaverLabel` appends, so a renderer can colour it — RED, on the owner's instruction
 * (2026-09-28). One authority: the PDF, the deck and the workbook all split a cell the same way,
 * and none of them re-derives the pattern.
 */
const LEAVER_MARK = /^(.*?)(\s\(left(?:\s[^)]*)?\))$/;

/** Split a cell into the name and its "(left …)" mark, or null when it carries no mark. */
export function splitLeaverLabel(text: string): { name: string; mark: string } | null {
  const m = LEAVER_MARK.exec(text);
  return m ? { mark: m[2], name: m[1] } : null;
}

export function leaverLabel(name: string, lastWorkingDate: string | null | undefined): string {
  if (!lastWorkingDate) return `${name} (left)`;
  const when = new Date(`${lastWorkingDate}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) return `${name} (left)`;
  const stamp = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(when);
  return `${name} (left ${stamp})`;
}
