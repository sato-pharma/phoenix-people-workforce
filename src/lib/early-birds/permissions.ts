// Who can see which districts.
//
// This is the security boundary for the module, so it is derived from the real reporting chain in
// the directory rather than from a role label: a Regional Manager sees the districts that actually
// roll up to him, not "all districts because he is an RM". The tab being hidden in the sidebar is
// UX; this is the enforcement.

import type { AccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { isMedicalRepDirectoryEmployee } from "@/lib/employee-portal/service";
import { normalizeHrIdForAccess } from "@/lib/hr-id";

export type EarlyBirdsDistrict = { hrId: string; hrIdKey: string; name: string };

export type EarlyBirdsScope = {
  districts: EarlyBirdsDistrict[];
  /** The viewer's own rep key, so the race panel can pin their row. */
  viewerHrIdKey: string | null;
  /** Company-wide viewers (CEO, SFE, Super Admin) see every district and the national wall. */
  isCompanyWide: boolean;
  scopeLabel: string;
};

const COMPANY_WIDE_ROLES = new Set([
  "Super Admin",
  "CEO",
  "SFE Manager",
  "Marketing Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
]);

/**
 * Every district manager in `viewer`'s reporting subtree, found by walking each DM's manager chain
 * upward. Depth-capped because a directory cycle (a genuine data error) would otherwise hang the
 * request rather than degrade.
 */
function districtsUnder(
  viewerKey: string,
  managerKeyByEmployeeKey: Map<string, string | null>,
  districtKeys: readonly string[],
): Set<string> {
  const owned = new Set<string>();
  for (const districtKey of districtKeys) {
    let cursor: string | null = districtKey;
    for (let depth = 0; depth < 8 && cursor; depth += 1) {
      if (cursor === viewerKey) {
        owned.add(districtKey);
        break;
      }
      cursor = managerKeyByEmployeeKey.get(cursor) ?? null;
    }
  }
  return owned;
}

/** Directory fields the scope rule actually reads. */
export type EarlyBirdsScopeRow = {
  hrId: string;
  displayName: string;
  managerHrId: string | null;
  lineId: number | null;
  jobTitle: string | null;
  positionTitle: string | null;
};

export async function resolveEarlyBirdsScope(access: AccessContext): Promise<EarlyBirdsScope> {
  const rows = await getEmployeeDirectoryRows().catch(() => []);
  return resolveEarlyBirdsScopeFrom(rows, access);
}

/**
 * The scope rule as a pure function of the directory — {@link resolveEarlyBirdsScope} is only the
 * fetch around it. Split out so the branch ordering can be regression-tested: a bug here silently
 * shows one line's reps to another line's manager, which is exactly what happened in production
 * (every NSM was handed the CEO's district).
 */
export function resolveEarlyBirdsScopeFrom(
  rows: readonly EarlyBirdsScopeRow[],
  access: AccessContext,
): EarlyBirdsScope {
  const viewerKey = normalizeHrIdForAccess(access.hrId);

  const managerKeyByEmployeeKey = new Map<string, string | null>();
  const nameByKey = new Map<string, string>();
  const hrIdByKey = new Map<string, string>();
  const lineIdByKey = new Map<string, number | null>();
  const districtKeys = new Set<string>();
  let viewerIsMedicalRep = false;
  let viewerLineId: number | null = null;

  for (const row of rows) {
    const key = normalizeHrIdForAccess(row.hrId);
    if (!key) continue;
    managerKeyByEmployeeKey.set(key, normalizeHrIdForAccess(row.managerHrId));
    nameByKey.set(key, row.displayName);
    hrIdByKey.set(key, row.hrId);
    lineIdByKey.set(key, typeof row.lineId === "number" ? row.lineId : null);
    if (key === viewerKey) {
      viewerIsMedicalRep = isMedicalRepDirectoryEmployee(row);
      viewerLineId = typeof row.lineId === "number" ? row.lineId : null;
    }
    if (isMedicalRepDirectoryEmployee(row)) {
      const managerKey = normalizeHrIdForAccess(row.managerHrId);
      if (managerKey) districtKeys.add(managerKey);
    }
  }

  const toDistrict = (key: string): EarlyBirdsDistrict => ({
    hrId: hrIdByKey.get(key) ?? key,
    hrIdKey: key,
    name: nameByKey.get(key) ?? key,
  });

  const byName = (a: EarlyBirdsDistrict, b: EarlyBirdsDistrict) => a.name.localeCompare(b.name);

  // Super Admin / system scope and the executive audience see everything.
  if (access.scope === "system" || COMPANY_WIDE_ROLES.has(access.role)) {
    return {
      districts: Array.from(districtKeys, toDistrict).sort(byName),
      viewerHrIdKey: viewerKey,
      isCompanyWide: true,
      scopeLabel: "the company",
    };
  }

  if (!viewerKey) {
    return { districts: [], viewerHrIdKey: null, isCompanyWide: false, scopeLabel: "your team" };
  }

  // A National Sales Manager is scoped by LINE, and is checked FIRST because he is never a
  // district himself.
  //
  // Order matters here. Districts are inferred from "who manages a medical rep", and an ACTING DM
  // can still carry the job title "Medical Representative" — B-1 holds SEAT-AIF-ADM-UE-1 while
  // titled a rep. The moment her manager row was repaired to point at the Anti-Infective NSM, the
  // NSM started matching the "viewer is himself a district" test below and saw exactly one
  // district: himself. Checking the line branch first makes that structurally impossible.
  //
  // The deeper fix is to derive districts from au_v_org_tree (the declared source of truth for org
  // structure) instead of from job titles and employees.manager_hr_id. That is a larger change; this
  // ordering closes the hole meanwhile.
  if (viewerLineId !== null && access.role === "National Sales Manager") {
    const onMyLine = new Set(
      Array.from(districtKeys).filter((districtKey) => lineIdByKey.get(districtKey) === viewerLineId),
    );
    onMyLine.delete(viewerKey);
    return {
      districts: Array.from(onMyLine, toDistrict).sort(byName),
      viewerHrIdKey: viewerKey,
      isCompanyWide: false,
      scopeLabel: "your line",
    };
  }

  // A District Manager sees his own district and nothing else.
  if (districtKeys.has(viewerKey)) {
    return {
      districts: [toDistrict(viewerKey)],
      viewerHrIdKey: viewerKey,
      isCompanyWide: false,
      scopeLabel: "your team",
    };
  }

  // A Medical Rep sees the district he competes in — his own manager's.
  //
  // GATED TO ACTUAL MEDICAL REPS. Without that guard this branch fires for anyone whose manager
  // happens to manage reps — and every National Sales Manager reports to the CEO, who directly
  // manages six Anti-Infective reps. All three NSMs were therefore handed the CEO's district
  // instead of their own line, so a CNS NSM was looking at Anti-Infective reps.
  const viewerManagerKey = managerKeyByEmployeeKey.get(viewerKey) ?? null;
  if (viewerIsMedicalRep && viewerManagerKey && districtKeys.has(viewerManagerKey)) {
    return {
      districts: [toDistrict(viewerManagerKey)],
      viewerHrIdKey: viewerKey,
      isCompanyWide: false,
      scopeLabel: "your team",
    };
  }

  // Regional managers: the districts that genuinely roll up to them. Fails CLOSED — an empty
  // subtree shows nothing rather than the whole company.
  const owned = districtsUnder(viewerKey, managerKeyByEmployeeKey, Array.from(districtKeys));
  return {
    districts: Array.from(owned, toDistrict).sort(byName),
    viewerHrIdKey: viewerKey,
    isCompanyWide: false,
    scopeLabel: owned.size > 1 ? "your line" : "your team",
  };
}

/** Guard for a district passed in a URL — a viewer must never read a district outside their scope. */
export function assertDistrictInScope(scope: EarlyBirdsScope, districtHrId: string | null | undefined): EarlyBirdsDistrict | null {
  if (scope.districts.length === 0) return null;
  const requestedKey = normalizeHrIdForAccess(districtHrId);
  if (!requestedKey) return scope.districts[0];
  return scope.districts.find((district) => district.hrIdKey === requestedKey) ?? null;
}
