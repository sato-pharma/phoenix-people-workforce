import { normalizeHrIdForAccess } from "@/lib/hr-id";

/**
 * THE DOWNWARD RULE — one implementation, read by every module that scopes people.
 *
 * Owner, 2026-09-04, stated plainly: *"Never an employee sees his direct manager. You see yourself
 * and your scope down — downgrading, not upgrading."* Asked whether the cut should reach past his
 * own manager: *"remove dsms rsm and peer pms too."*
 *
 * It is stated as a principle about PEOPLE, not about one screen, which is why it lives here rather
 * than inside whichever module first needed it. It was originally implemented inside
 * crm/doctor-coverage-scope.ts and applied there alone; double-visit analytics kept the wide
 * pre-rule shape for another week, and in production that let Product Manager B-155 see his own
 * manager A-8 in the DV module while the same person was correctly hidden on the CRM boards. A
 * second copy of a rule like this does not stay in step — so there is one.
 *
 * TWO INDEPENDENT CUTS, because they catch different things:
 *
 *   1. The viewer's whole MANAGEMENT CHAIN — his manager, his manager's manager, all the way up.
 *      Identity-based and title-BLIND, so it still catches a manager whose job title is misspelt,
 *      missing, or absent from the ladder.
 *   2. The SEAT-RANK LADDER — keep only seats ranked strictly BELOW the viewer's own.
 *
 * WHY A LADDER AND NOT A LIST OF BANNED TITLES. "District Sales Manager" is upward from a Product
 * Manager but DOWNWARD from a National Sales Manager, so a flat blocklist of DSM/RSM/peer-PM would
 * delete an NSM's own reports and hand him an empty board — which reads as a data fault, not a bug.
 * A ladder is relative to the viewer, so one rule serves every seat correctly.
 *
 * AN UNRANKED TITLE IS EXCLUDED, and that is the safe direction. In production 12 head-office seats
 * (the CEO, HR, Finance, QPPV, R&D, even "Buffet") carry a line_id, so "unknown means field force,
 * keep them" would put the CEO inside a Product Manager's scope.
 *
 * THE VIEWER IS NEVER EXCLUDED FROM HIS OWN SCOPE. Load-bearing, not tidy: a National Sales Manager
 * is not strictly below himself, and without the guard the ladder empties his own board.
 */

/**
 * The fields the rule reads. Kept narrow so a directory change cannot quietly alter who is cut.
 *
 * `positionTitle` is optional and, where present, is read FIRST. This repo carries a seat in two
 * columns and they disagree: double-visit analytics resolves a person's role as "positionTitle,
 * then jobTitle" everywhere else (resolveDvRole), and a directory row with a null `job_title` and a
 * populated `position_title` is a real shape. Ranking on `jobTitle` alone would leave such a person
 * UNRANKED, and an unranked seat is excluded — so a medical rep would silently vanish from the
 * board that exists to show him. Callers that carry only one of the two are unaffected.
 */
export type DownwardScopePerson = {
  hrId: string;
  jobTitle: string | null;
  positionTitle?: string | null;
  managerHrId: string | null;
  pendingManagerReplacementForHrId: string | null;
};

/**
 * Rank numbers are ORDER ONLY and carry no meaning of their own. Both spellings of each seat are
 * listed because this repo runs two vocabularies: an app ROLE ("Medical Rep", "District Manager",
 * "Regional Manager") and an employee JOB TITLE ("Medical Representative", "District Sales
 * Manager", "Regional Sales Manager"). A Product Manager sits alongside a District Sales Manager on
 * purpose — that is what makes a peer PM, and every DSM, fall outside a PM's scope while leaving
 * the medical reps inside it.
 */
export const SEAT_RANK: ReadonlyMap<string, number> = new Map<string, number>([
  ["medical rep", 1],
  ["medical representative", 1],
  ["district manager", 2],
  ["district sales manager", 2],
  ["product manager", 2],
  ["regional manager", 3],
  ["regional sales manager", 3],
  ["group product manager", 3],
  ["national sales manager", 4],
]);

/** `null` means this seat is not on the ladder at all. */
export function seatRank(titleOrRole: string | null | undefined): number | null {
  const key = titleOrRole?.trim().toLowerCase();
  if (!key) return null;
  return SEAT_RANK.get(key) ?? null;
}

/** Index people by canonical HR id — what both cuts walk. */
export function indexByCanonicalHrId<T extends { hrId: string }>(people: readonly T[]): Map<string, T> {
  const byKey = new Map<string, T>();
  for (const person of people) {
    const key = normalizeHrIdForAccess(person.hrId);
    if (key) byKey.set(key, person);
  }
  return byKey;
}

/**
 * Every ancestor of the viewer, canonicalised. Treats a pending seat replacement as an ancestor
 * too — the conservative direction, because being wrong here hides a row rather than exposing one.
 *
 * The `chain.has` break is not decoration: a self-referencing or mutually-referencing manager pair
 * exists in this directory often enough to matter, and an unguarded climb spins forever inside a
 * server render.
 *
 * The map must be built from EVERY person including inactive ones, or the climb breaks at a manager
 * who has since left and every ancestor above them is silently missed.
 */
export function managementChainOf(
  viewerCanonicalHrId: string,
  byCanonicalHrId: ReadonlyMap<string, DownwardScopePerson>,
): ReadonlySet<string> {
  const chain = new Set<string>();
  let node = byCanonicalHrId.get(viewerCanonicalHrId);

  while (node) {
    const pending = normalizeHrIdForAccess(node.pendingManagerReplacementForHrId ?? "");
    if (pending) chain.add(pending);

    const managerKey = normalizeHrIdForAccess(node.managerHrId ?? "");
    if (!managerKey || chain.has(managerKey)) break;
    chain.add(managerKey);
    node = byCanonicalHrId.get(managerKey);
  }

  return chain;
}

/** Cut 1: true when this person is an ancestor of the viewer, so must not appear in his scope. */
export function isAboveViewer(
  person: Pick<DownwardScopePerson, "hrId">,
  viewerCanonicalHrId: string,
  chain: ReadonlySet<string>,
): boolean {
  const key = normalizeHrIdForAccess(person.hrId);
  if (!key || key === viewerCanonicalHrId) return false; // you always see yourself
  return chain.has(key);
}

/**
 * Cut 2: true when this person ranks strictly below the viewer.
 *
 * A `null` viewerRank passes everyone through, so a role added later without a ladder entry
 * degrades to chain-only behaviour rather than to an empty board. Callers that care assert every
 * one of their roles is ranked — an unranked one does not error, it silently restores the wide
 * pre-rule scope.
 */
export function isStrictlyBelowViewer(
  person: Pick<DownwardScopePerson, "hrId" | "jobTitle" | "positionTitle">,
  viewer: { canonicalHrId: string; rank: number | null },
): boolean {
  if (viewer.rank == null) return true;
  if (normalizeHrIdForAccess(person.hrId) === viewer.canonicalHrId) return true; // you always see yourself
  const rank = rankOfSeat(person);
  return rank != null && rank < viewer.rank;
}

/** A person's rank: position title first, job title second — see DownwardScopePerson. */
export function rankOfSeat(person: Pick<DownwardScopePerson, "jobTitle" | "positionTitle">): number | null {
  return seatRank(person.positionTitle) ?? seatRank(person.jobTitle);
}

/**
 * Both cuts as one predicate, for a caller that has no reason to apply them separately.
 *
 * `people` must include INACTIVE rows so the chain stays walkable; filter the output for activity
 * yourself. Returns a predicate rather than a filtered list so a caller can compose it with its own
 * line/team membership test in one pass.
 */
export function downwardOnlyFilter(input: {
  viewerCanonicalHrId: string;
  viewerRank: number | null;
  people: readonly DownwardScopePerson[];
}): (person: DownwardScopePerson) => boolean {
  const chain = managementChainOf(input.viewerCanonicalHrId, indexByCanonicalHrId(input.people));
  return (person) =>
    !isAboveViewer(person, input.viewerCanonicalHrId, chain) &&
    isStrictlyBelowViewer(person, { canonicalHrId: input.viewerCanonicalHrId, rank: input.viewerRank });
}
