// Recruitment / ATS — which CVs a WhatsApp Applicants pile keeps, and which it hides as DECIDED.
//
// The owner, 2026-09-18: "hide the CVs I already decided from the WhatsApp screening list". He had
// shortlisted or rejected somebody and kept meeting the same CV again, because that pile is built
// from everyone the WhatsApp search found — filed and decided people included, on purpose, since the
// search page lists them too.
//
// Pure, with one import of a pure vocabulary, so the rule can be tested against plain objects and the
// server loader and its tests share it. It must never grow a database import: screening-workspace.ts
// is the only caller and it already holds the rows.

import { isDecidedCandidateStatus } from "@/lib/recruitment/candidate-status";
import type { ScreeningQueueNarrowing } from "@/lib/recruitment/screening-link";

/**
 * Does this pile hide the CVs a person has already decided?
 *
 * Yes by default. Three things say "I want them" and turn it off:
 *
 *   - `decided` in the link — the reader pressed "Show the decided".
 *   - A status picked on the filter bar. Somebody who asked for "Rejected" must get the rejected;
 *     hiding every one of them would make the filter undo itself.
 *   - "Sent to a manager" — the same reason: those CVs ARE decided ones.
 */
export function whatsAppPileHidesDecided(
  narrowing: Pick<ScreeningQueueNarrowing, "decided" | "notified" | "status">,
): boolean {
  return !narrowing.decided && narrowing.status === null && narrowing.notified !== "sent";
}

/**
 * The people a WhatsApp pile shows, and how many of everyone found are decided.
 *
 * `decidedCount` is over EVERYONE the search found, hidden or not, so the button that brings them
 * back can say the same number before and after it is pressed.
 */
export function splitWhatsAppPileByDecision<T extends { status: string | null | undefined }>(
  everyMatch: readonly T[],
  hidesDecided: boolean,
): { shown: T[]; decidedCount: number } {
  const decidedCount = everyMatch.filter((candidate) => isDecidedCandidateStatus(candidate.status)).length;
  const shown = hidesDecided
    ? everyMatch.filter((candidate) => !isDecidedCandidateStatus(candidate.status))
    : [...everyMatch];
  return { decidedCount, shown };
}
