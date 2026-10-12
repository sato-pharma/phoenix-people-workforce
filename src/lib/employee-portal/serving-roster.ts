// WHO IS ON A MANAGER'S TEAM TODAY — the roster the daily CRM boards and the head-count keycards read.
//
// 🔴 It is resolved from the ORG TREE and the employee directory, and NEVER from sales history.
//
// That distinction cost a real incident. On 2026-10-12 all nine (line × month) Monthly Closings were
// unpublished to unlock the months for a brick move, and a Pedia Giza district manager reported that
// "everything is showing zero" on his landing page. The sales keycards were correct to withhold
// (owner, 2026-08-13), but THREE things that have nothing to do with a closing went blank with them:
//
//   • Team Size read 0 while the org tree held four occupied rep seats;
//   • the CRM First Visit board read "Reps submitted 0/0" and "No visits submitted yet today";
//   • and because nobody was on the roster, nobody could be missing from it, so the same board
//     also printed its green "Every rep on your team has submitted their first visit."
//
// The cause was one line of plumbing: every one of those rosters was derived from
// `getDsmTeamPerformance` / the national / regional sales services, which are membership-by-sales-
// history and therefore gated on a PUBLISHED closing. "Who do I manage" and "who sold something in
// a published month" are different questions, and only the second one may go quiet when a month is
// unpublished.
//
// The walk itself is NOT reimplemented here: `getManagerScope` (crm/manager-scope.ts) is the audited
// org-tree walk the CRM boards already scope with, and it returns `kind: "none"` rather than an
// empty allow-list, so a viewer whose seat resolves to nobody can be told apart from a manager whose
// reps have filed nothing. A caller that gets `null` back from this module keeps whatever roster it
// already had — degrading to the sales roster is the old behaviour, never to an empty list.

import { getManagerScope } from "@/lib/crm/manager-scope";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { isDistrictManagerEmployee, isMedicalRepDirectoryEmployee } from "@/lib/employee-portal/service";
import { normalizeHrIdForAccess } from "@/lib/hr-id";

export type ServingRosterPerson = { hrId: string; name: string };

export type ServingRoster = {
  /** Active medical reps anywhere in the viewer's subtree. */
  reps: ServingRosterPerson[];
  /** Active district managers in the subtree — empty for a District Manager, who anchors reps only. */
  dsms: ServingRosterPerson[];
};

/** Only the directory fields the split below reads, so the pure core is fixture-testable. */
export type ServingRosterDirectoryRow = Pick<
  EmployeeDirectoryRow,
  "hrId" | "displayName" | "jobTitle" | "positionTitle"
>;

/**
 * Pure core: split one already-authorised allow-list into reps and district managers.
 *
 * `agentHrIds` comes from the org-tree walk, so this function widens nobody's access — it only
 * labels and names the people already in scope. The viewer is removed from her own roster: an
 * acting District Manager also holds a rep seat under herself, and she is not her own team member.
 */
export function pickServingRoster(input: {
  agentHrIds: readonly string[];
  directoryRows: readonly ServingRosterDirectoryRow[];
  viewerHrId?: string | null;
}): ServingRoster {
  const allowed = new Set(
    input.agentHrIds.map((hrId) => normalizeHrIdForAccess(hrId)).filter((key): key is string => Boolean(key)),
  );
  const viewerKey = normalizeHrIdForAccess(input.viewerHrId ?? null);

  const reps: ServingRosterPerson[] = [];
  const dsms: ServingRosterPerson[] = [];
  const seen = new Set<string>();

  for (const row of input.directoryRows) {
    const key = normalizeHrIdForAccess(row.hrId);
    if (!key || !allowed.has(key) || seen.has(key)) continue;
    if (viewerKey && key === viewerKey) continue;
    const person = { hrId: row.hrId, name: row.displayName };
    if (isMedicalRepDirectoryEmployee(row)) {
      seen.add(key);
      reps.push(person);
      continue;
    }
    if (isDistrictManagerEmployee(row)) {
      seen.add(key);
      dsms.push(person);
    }
  }

  return { reps, dsms };
}

/**
 * The live roster for a manager's own seat, or `null` when the org tree cannot resolve one.
 *
 * `null` is deliberately not an empty roster: the caller must fall back to the roster it already
 * holds rather than render a confident "nobody is on your team".
 */
export async function resolveServingRoster(input: {
  viewerHrId: string | null | undefined;
  label?: string;
}): Promise<ServingRoster | null> {
  const viewerHrId = input.viewerHrId ?? null;
  if (!viewerHrId) return null;
  try {
    const scope = await getManagerScope({
      basis: "team",
      label: input.label ?? "your team",
      viewerHrId,
    });
    // "company" never reaches here (the basis is fixed to "team"), and "none" means the seat
    // resolved to nobody — both are a caller-side fallback, not an empty roster.
    if (scope.kind !== "agents") return null;
    const directoryRows = await getEmployeeDirectoryRows();
    const roster = pickServingRoster({ agentHrIds: scope.agentHrIds, directoryRows, viewerHrId });
    return roster.reps.length === 0 && roster.dsms.length === 0 ? null : roster;
  } catch {
    return null;
  }
}
