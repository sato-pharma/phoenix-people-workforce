import { normalizeHrIdForAccess } from "@/lib/hr-id";

/**
 * THE MANAGEMENT-CHAIN CUT — nobody sees their own manager, or anyone above them.
 *
 * Owner, 2026-09-04: *"Never an employee sees his direct manager. You see yourself and your scope
 * down — downgrading, not upgrading."* Implemented that day in crm/doctor-coverage-scope.ts and
 * applied there alone, so double-visit analytics kept the pre-rule shape: in production Product
 * Manager B-155 saw his own manager A-8 on the DV manager board while she was correctly hidden from
 * him on every CRM board.
 *
 * 🔴 WHAT THIS MODULE DELIBERATELY DOES NOT CONTAIN.
 *
 * The owner's rule has a second half — a SEAT-RANK ladder that also removes peers (for a Product
 * Manager, every District Sales Manager). `resolveDoctorCoverageScope` implements it and is LOCKED.
 * An earlier attempt put a copy of that ladder here and wired both modules to it; that copy ranked
 * on `positionTitle` first, which moves the answer in the EXPOSURE-INCREASING direction, and it
 * reached the locked module where its own tests could not see the change.
 *
 * The owner was shown what the ladder costs on this screen — a PM's manager board drops from 11
 * rows to 1 — and chose 2026-09-11 to take the CHAIN CUT ONLY here for now. So the ladder is not
 * duplicated: a second copy of a rule like this does not stay in step, and the way to avoid that is
 * not to write one. If the ladder is wanted here later, the honest move is to widen the LOCKED
 * module's own export rather than to re-implement it beside it.
 *
 * WHY IDENTITY AND NOT TITLES. The cut walks `manager_hr_id`, so it still catches a manager whose
 * job title is misspelt, missing, or absent from any ladder. A title-based rule cannot.
 */

/** The fields the cut reads. Narrow on purpose, so a directory change cannot quietly alter it. */
export type DownwardScopePerson = {
  hrId: string;
  managerHrId: string | null;
  pendingManagerReplacementForHrId: string | null;
};

/** Index people by canonical HR id — what the climb walks. */
export function indexByCanonicalHrId<T extends { hrId: string }>(people: readonly T[]): Map<string, T> {
  const byKey = new Map<string, T>();
  for (const person of people) {
    const key = normalizeHrIdForAccess(person.hrId);
    if (key) byKey.set(key, person);
  }
  return byKey;
}

/**
 * Every ancestor of the viewer, canonicalised. A pending seat replacement counts as an ancestor
 * too — the conservative direction, because being wrong there hides a row rather than exposing one.
 *
 * The `chain.has` break is not decoration: self-referencing and mutually-referencing manager pairs
 * exist in this directory, and an unguarded climb spins forever inside a server render.
 *
 * 🔴 BUILD THE MAP FROM EVERY PERSON, INCLUDING INACTIVE ONES. The climb otherwise stops at a
 * manager who has since left, and every ancestor above them is silently missed — which fails in the
 * exposing direction, since a missed ancestor is one this rule then never cuts.
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

/**
 * True when this person is an ancestor of the viewer, so must not appear in his scope.
 *
 * THE VIEWER IS NEVER CUT FROM HIS OWN SCOPE. Load-bearing rather than tidy: a directory where
 * somebody is recorded as their own manager would otherwise erase them from their own board.
 */
export function isAboveViewer(
  person: { hrId: string | null | undefined },
  viewerCanonicalHrId: string,
  chain: ReadonlySet<string>,
): boolean {
  const key = normalizeHrIdForAccess(person.hrId ?? "");
  if (!key || key === viewerCanonicalHrId) return false;
  return chain.has(key);
}
