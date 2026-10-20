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
  /**
   * True when the employee directory could not be read at all.
   *
   * Without this flag an outage is indistinguishable from an honest empty scope: both produce zero
   * districts, and the board renders "no district reports to you" at a manager who has six. Callers
   * MUST branch on this before showing any it's-empty copy — a misleading zero is worse than an
   * error, because nobody investigates a number that looks like an answer.
   */
  directoryUnavailable: boolean;
};

const COMPANY_WIDE_ROLES = new Set([
  "Super Admin",
  "CEO",
  "SFE Manager",
  "Marketing Manager",
  "Product Manager",
  "Group Product Manager",
  "Training Manager",
  // The Talent Acquisition seat (2026-10-08). She manages no district, so without this the board
  // would resolve her to an empty scope and print "no district reports to you".
  "HR Resourcing",
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
  /** Names a district whose manager has left: "Vacant — <its reps' region>". */
  regionName?: string | null;
};

/** What the viewer's own district is called on his board — the reps who report straight to him. */
export const DIRECT_REPORTS_DISTRICT_NAME = "Reporting to you directly";

/** The scope when the directory cannot be read. Empty, but for a reason the caller must surface. */
const DIRECTORY_UNAVAILABLE_SCOPE: EarlyBirdsScope = {
  districts: [],
  viewerHrIdKey: null,
  isCompanyWide: false,
  scopeLabel: "your team",
  directoryUnavailable: true,
};

export async function resolveEarlyBirdsScope(access: AccessContext): Promise<EarlyBirdsScope> {
  // This used to be `.catch(() => [])`, which turned a database outage into a board that told a
  // National Sales Manager "no district reports to you". Fail closed on the data, but never fail
  // silent on the reason.
  let rows: readonly EarlyBirdsScopeRow[];
  try {
    rows = await getEmployeeDirectoryRows();
  } catch {
    return DIRECTORY_UNAVAILABLE_SCOPE;
  }
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
  // An employee directory with zero rows is not a state this company can be in — it is what a
  // failed read, or an upstream `.catch(() => [])`, looks like from here. Report it as an outage
  // rather than as "you manage nobody", and keep the rule in the pure function so it is testable
  // without a database.
  if (rows.length === 0) return DIRECTORY_UNAVAILABLE_SCOPE;

  const viewerKey = normalizeHrIdForAccess(access.hrId);

  const managerKeyByEmployeeKey = new Map<string, string | null>();
  const nameByKey = new Map<string, string>();
  const hrIdByKey = new Map<string, string>();
  const lineIdByKey = new Map<string, number | null>();
  const regionByKey = new Map<string, string>();
  const managerHrIdByKey = new Map<string, string>();
  const districtKeys = new Set<string>();
  /** District (manager) key → the medical reps reporting to it. */
  const repKeysByDistrictKey = new Map<string, string[]>();
  let viewerIsMedicalRep = false;
  let viewerLineId: number | null = null;

  for (const row of rows) {
    const key = normalizeHrIdForAccess(row.hrId);
    if (!key) continue;
    managerKeyByEmployeeKey.set(key, normalizeHrIdForAccess(row.managerHrId));
    nameByKey.set(key, row.displayName);
    hrIdByKey.set(key, row.hrId);
    lineIdByKey.set(key, typeof row.lineId === "number" ? row.lineId : null);
    const regionName = typeof row.regionName === "string" ? row.regionName.trim() : "";
    if (regionName) regionByKey.set(key, regionName);
    if (key === viewerKey) {
      viewerIsMedicalRep = isMedicalRepDirectoryEmployee(row);
      viewerLineId = typeof row.lineId === "number" ? row.lineId : null;
    }
    if (isMedicalRepDirectoryEmployee(row)) {
      const managerKey = normalizeHrIdForAccess(row.managerHrId);
      if (managerKey) {
        districtKeys.add(managerKey);
        // The stored spelling, for a district whose manager has no row of his own: the board and
        // the recommendations read match `manager_hr_id` as stored, never the normalised key.
        if (!managerHrIdByKey.has(managerKey) && row.managerHrId) managerHrIdByKey.set(managerKey, row.managerHrId.trim());
        const repKeys = repKeysByDistrictKey.get(managerKey);
        if (repKeys) repKeys.push(key);
        else repKeysByDistrictKey.set(managerKey, [key]);
      }
    }
  }

  // A district whose manager has no active directory row — he left, and his reps still report to
  // his seat — is a VACANT district. It is named by its reps' region, never by the departed
  // manager's HR id (owner, 2026-10-20: every applicable person appears, by name).
  const vacantDistrictName = (key: string): string => {
    const region = (repKeysByDistrictKey.get(key) ?? []).map((repKey) => regionByKey.get(repKey)).find(Boolean);
    return region ? `Vacant — ${region}` : "Vacant district";
  };

  const toDistrict = (key: string): EarlyBirdsDistrict => ({
    hrId: hrIdByKey.get(key) ?? managerHrIdByKey.get(key) ?? key,
    hrIdKey: key,
    name: nameByKey.get(key) ?? vacantDistrictName(key),
  });

  /**
   * Whether the viewer is a district in his own right: at least one medical rep reports straight
   * to him who is NOT herself a district. An acting DM still titled "Medical Representative"
   * (B-1's case, below) does not count — she has her own district — so an NSM whose only direct
   * rep-titled report is that acting DM is still never his own district.
   */
  const managesRepsDirectly = (managerKey: string) =>
    (repKeysByDistrictKey.get(managerKey) ?? []).some((repKey) => !districtKeys.has(repKey));

  /** The viewer's own district reads as "Reporting to you directly", never as his own name. */
  const toScopedDistrict = (key: string): EarlyBirdsDistrict =>
    key === viewerKey ? { ...toDistrict(key), name: DIRECT_REPORTS_DISTRICT_NAME } : toDistrict(key);

  const byName = (a: EarlyBirdsDistrict, b: EarlyBirdsDistrict) => a.name.localeCompare(b.name);

  // Super Admin / system scope and the executive audience see everything.
  if (access.scope === "system" || COMPANY_WIDE_ROLES.has(access.role)) {
    return {
      districts: Array.from(districtKeys, toDistrict).sort(byName),
      viewerHrIdKey: viewerKey,
      isCompanyWide: true,
      scopeLabel: "the company",
      directoryUnavailable: false,
    };
  }

  if (!viewerKey) {
    return {
      districts: [],
      viewerHrIdKey: null,
      isCompanyWide: false,
      scopeLabel: "your team",
      directoryUnavailable: false,
    };
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
  //
  // Owner, 2026-10-20 ("u find no field force"): reps under a VACANT district seat report straight
  // to the NSM in the directory (AI-0029 under the vacant Alex-BHR seat reports to AI-0008), and
  // dropping the NSM's own key unconditionally dropped them from every board he can open. So his own
  // key stays when he directly manages a rep who is not herself a district, and a district whose
  // manager has left counts as on his line when its reps are.
  if (viewerLineId !== null && access.role === "National Sales Manager") {
    const isOnMyLine = (districtKey: string) =>
      hrIdByKey.has(districtKey)
        ? lineIdByKey.get(districtKey) === viewerLineId
        : (repKeysByDistrictKey.get(districtKey) ?? []).some((repKey) => lineIdByKey.get(repKey) === viewerLineId);
    const onMyLine = new Set(Array.from(districtKeys).filter(isOnMyLine));
    if (!managesRepsDirectly(viewerKey)) onMyLine.delete(viewerKey);
    return {
      districts: Array.from(onMyLine, toScopedDistrict).sort(byName),
      viewerHrIdKey: viewerKey,
      isCompanyWide: false,
      scopeLabel: "your line",
      directoryUnavailable: false,
    };
  }

  // A District Manager sees his own district and nothing else. Never a Regional Manager: one with a
  // rep reporting straight to him is a district too, and stopping here would hide every district
  // under him (owner, 2026-10-20) — he falls through to his subtree, which includes his own key.
  if (districtKeys.has(viewerKey) && access.role !== "Regional Manager") {
    return {
      districts: [toDistrict(viewerKey)],
      viewerHrIdKey: viewerKey,
      isCompanyWide: false,
      scopeLabel: "your team",
      directoryUnavailable: false,
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
      directoryUnavailable: false,
    };
  }

  // Regional managers: the districts that genuinely roll up to them. Fails CLOSED — an empty
  // subtree shows nothing rather than the whole company.
  const owned = districtsUnder(viewerKey, managerKeyByEmployeeKey, Array.from(districtKeys));
  // The same rule as the NSM's: his own key only for reps who report straight to him.
  if (!managesRepsDirectly(viewerKey)) owned.delete(viewerKey);
  return {
    districts: Array.from(owned, toScopedDistrict).sort(byName),
    viewerHrIdKey: viewerKey,
    isCompanyWide: false,
    scopeLabel: owned.size > 1 ? "your line" : "your team",
    directoryUnavailable: false,
  };
}

/** Guard for a district passed in a URL — a viewer must never read a district outside their scope. */
export function assertDistrictInScope(scope: EarlyBirdsScope, districtHrId: string | null | undefined): EarlyBirdsDistrict | null {
  if (scope.districts.length === 0) return null;
  const requestedKey = normalizeHrIdForAccess(districtHrId);
  if (!requestedKey) return scope.districts[0];
  return scope.districts.find((district) => district.hrIdKey === requestedKey) ?? null;
}

/** A rep a viewer may open from the board — the roster row, not a directory lookup. */
export type EarlyBirdsRepTarget = { hrId: string; hrIdKey: string; name: string };

/**
 * Guard for the `?rep=` parameter.
 *
 * The district gate above has already decided WHOSE reps this viewer may read; this narrows that
 * to one of them. The roster passed in is the ranking of the district and fortnight actually on
 * screen, so the guard is a membership test against data the viewer is already authorised to see
 * rather than a second permission model that could drift out of step with the first.
 *
 * REFUSES rather than substitutes, exactly like assertDistrictInScope: quietly opening a different
 * rep's record under a name the viewer typed would be a lie about whose start times these are. A
 * `null` return therefore means "not in this roster", and the caller says so instead of guessing.
 *
 * Deliberately NOT a directory read. A manager must not be able to probe for an arbitrary HR id by
 * watching which ones the page recognises: an id outside the roster is indistinguishable from one
 * that does not exist at all.
 */
export function assertRepInRoster(
  roster: readonly EarlyBirdsRepTarget[],
  repHrId: string | null | undefined,
): EarlyBirdsRepTarget | null {
  const requestedKey = normalizeHrIdForAccess(repHrId);
  if (!requestedKey) return null;
  return roster.find((rep) => rep.hrIdKey === requestedKey) ?? null;
}
