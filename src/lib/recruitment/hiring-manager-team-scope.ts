// Recruitment / ATS — whose candidates a manager may look at besides their own.
//
// The owner asked for this on 2026-08-30: *"I want the National Sales Manager to have the authority
// to filter for one of the district managers reporting to him and see the CVs and candidates in his
// portal ... and can also give a comment on the CV itself."*
//
// WHY THIS MODULE IS SEPARATE, AND PURE. Every other route under
// app/api/recruitment/hiring-manager/** takes its scope from the session and nothing else — in that
// folder's own words, *"there is no id to guess and no way to ask for somebody else's pushes."*
// This feature is the first one that deliberately breaks that: it accepts a manager's HR_ID from the
// caller. So the id has to be PROVEN to sit beneath the viewer before a single candidate row is
// read, and the proof belongs somewhere it can be tested exhaustively without a database.
//
// The measurement that shaped it, taken against production the same morning. 36 CVs have been pushed
// to 9 managers. Two people hold a National Sales Manager seat:
//
//   a-12   Ali Mohamed Ali Elsayed  — 17 pushed to him, and beneath him: b-94 (7), pd-0001 (2),
//                                      pd-0010 (1), plus b-23 and b-154 with none.
//   ai-0008 Magdy El Senosey        —  1 pushed to him, and beneath him: b-12 (4), plus six DSMs
//                                      with none.
//
// Two things in that shape decide the design:
//
//   • pd-0010 is a District Sales Manager reporting to pd-0001, a REGIONAL Sales Manager, who
//     reports to a-12. Reading "district managers reporting to him" as direct reports only would
//     hide that CV from the NSM entirely. So the walk is the full chain — `isWithinManagerHierarchy`,
//     which the Organogram and the Medical Reps Performance views already share.
//   • Most of the DSMs have NO CVs at all. They are still listed, with a zero. A picker that hides
//     the empty ones is a picker an NSM reads as "my other districts are missing", and an empty
//     board reads as a bug rather than as an answer. Listing the zero is the honest shape.
//
// The one rule the whole file exists to keep: A PICKER IS NEVER WIDER THAN ITS VIEWER. The set
// offered on screen and the set the query will accept are computed HERE, once, from the same
// function — because the way this goes wrong in production is a screen offering a name the query
// then refuses, or worse, accepting one it never offered.
//
// PURE — no database, no React.

import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  isWithinManagerHierarchy,
  reportsToManagerSeat,
  type SeatContinuitySubject,
} from "@/lib/workforce/hierarchy-resolver";

/** Everything this module reads off an employee — structural, so a fixture need not be whole. */
export type TeamRosterEntry = SeatContinuitySubject & {
  hrId: string;
  fullName: string | null;
  jobTitle: string | null;
  /** As stored on the employee row. Carried, never filtered on — see the note below. */
  employmentStatus: string | null;
};

/** One manager the viewer is allowed to look at, as the picker shows them. */
export type TeamManager = {
  hrId: string;
  fullName: string | null;
  jobTitle: string | null;
  /** They report to the viewer's own seat, rather than to somebody who does. */
  direct: boolean;
  /**
   * False when this manager has left. They are still LISTED, on purpose.
   *
   * A CV pushed to somebody who then resigned does not move; it keeps their HR_ID. Dropping leavers
   * from the picker would make those CVs invisible to the one person above them who could reassign
   * them, and invisible reads as "there were none" rather than as "these are stranded". The screen
   * says who has left; it does not hide them.
   */
  active: boolean;
};

/**
 * The managers beneath `viewerHrId`, in the order a person would read them.
 *
 * "Manager" is decided STRUCTURALLY — somebody with at least one direct report — never by matching
 * words in a job title. Titles here are free text an importer writes ("District Sales Manager",
 * "District Manager", and 9 of 27 misspelt badly enough to hide a DM from search), so a title match
 * would silently drop real managers and admit people who only sound like one.
 *
 * The viewer is never in their own list: this answers "besides me, who may I look at".
 */
export function managersWithinViewerTeam(input: {
  roster: readonly TeamRosterEntry[];
  viewerHrId: string | null | undefined;
}): TeamManager[] {
  const viewerKey = canonicalHrIdKey(input.viewerHrId);
  if (!viewerKey) return [];

  const byCanonicalHrId = new Map<string, TeamRosterEntry>();
  for (const entry of input.roster) {
    const key = canonicalHrIdKey(entry.hrId);
    if (key) byCanonicalHrId.set(key, entry);
  }

  // Who has anybody reporting to them at all. Built once over the whole roster rather than per
  // candidate manager, so this stays linear on a roster of several hundred.
  const hasReports = new Set<string>();
  for (const entry of input.roster) {
    const managerKey = canonicalHrIdKey(entry.managerHrId);
    if (managerKey) hasReports.add(managerKey);
    // Somebody holding a vacant seat's reports is still managing them, and dropping this would make
    // a manager's team vanish from the picker for exactly as long as the seat below them is open.
    const pendingKey = canonicalHrIdKey(entry.pendingManagerReplacementForHrId);
    if (pendingKey) hasReports.add(pendingKey);
  }

  const managers: TeamManager[] = [];
  for (const entry of input.roster) {
    const key = canonicalHrIdKey(entry.hrId);
    if (!key || key === viewerKey) continue;
    if (!hasReports.has(key)) continue;
    if (
      !isWithinManagerHierarchy({
        byCanonicalHrId,
        canonicalize: canonicalHrIdKey,
        employee: entry,
        viewerCanonicalHrId: viewerKey,
      })
    ) {
      continue;
    }
    managers.push({
      active: String(entry.employmentStatus ?? "").trim().toLowerCase() === "active",
      direct: reportsToManagerSeat({
        canonicalize: canonicalHrIdKey,
        employee: entry,
        viewerCanonicalHrId: viewerKey,
      }),
      fullName: entry.fullName,
      hrId: entry.hrId,
      jobTitle: entry.jobTitle,
    });
  }

  // Direct reports first, then by name. An NSM opening this reads his own districts before the ones
  // that sit under a regional manager, which is the order he thinks about them in.
  return managers.sort((left, right) => {
    if (left.direct !== right.direct) return left.direct ? -1 : 1;
    return String(left.fullName ?? left.hrId).localeCompare(String(right.fullName ?? right.hrId));
  });
}

/**
 * May this viewer look at that manager's candidates?
 *
 * THE GATE. Every read of somebody else's CVs passes through here, and it answers from the same
 * `managersWithinViewerTeam` the picker is built from — one function, so the offered set and the
 * permitted set cannot drift apart. Answering it any other way is how a picker ends up narrower
 * than the query behind it.
 */
export function canViewerSeeManagerCandidates(input: {
  managerHrId: string | null | undefined;
  roster: readonly TeamRosterEntry[];
  viewerHrId: string | null | undefined;
}): boolean {
  const wanted = canonicalHrIdKey(input.managerHrId);
  if (!wanted) return false;
  // Their own CVs are already theirs — the sibling route has served them since 2026-08-15. Saying so
  // here keeps this function a complete answer to "may I read this manager's pushes", so no caller
  // has to remember to special-case itself.
  if (wanted === canonicalHrIdKey(input.viewerHrId)) return true;
  return managersWithinViewerTeam({ roster: input.roster, viewerHrId: input.viewerHrId }).some(
    (manager) => canonicalHrIdKey(manager.hrId) === wanted,
  );
}
