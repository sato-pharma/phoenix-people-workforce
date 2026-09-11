import { canonicalHrIdKey } from "@/lib/hr-id";
import { phoenixRoles, type PhoenixRole } from "@/lib/auth/permissions";

/**
 * The pure half of the distribution-list domain: what a list IS, who it matches, and how its
 * membership differs from what a mail-server alias is recorded as holding.
 *
 * Everything here is a total function over data the caller supplies. The database half lives in
 * ./service.ts. The split is not cosmetic — the test suite runs with PRODUCTION credentials and
 * APP_ENV=production (AGENTS.md §2.1), so the logic that decides who receives mail has to be
 * testable without a client that could reach a real table.
 */

export type DistributionListSpec = {
  listKey: string;
  label: string;
  description: string;
  roles: PhoenixRole[];
  lineIds: number[];
  areaIds: number[];
  departmentIds: number[];
  positionIds: number[];
  regionCodes: string[];
  includedHrIds: string[];
  excludedHrIds: string[];
  externalEmails: string[];
  enabled: boolean;
  /**
   * The ONLY way to address the whole company.
   *
   * A list with no rule resolves to NOBODY (see matchesDistributionRule) precisely so a
   * half-finished list can never quietly mail everyone. That guard would also make a legitimate
   * all-company list impossible, so this flag exists: reaching every employee has to be something
   * somebody TURNED ON, never something a blank form did on its own.
   */
  allEmployees: boolean;
  /**
   * 🔴 THE STORED LIST NAMED ROLES AND NOT ONE OF THEM IS A LIVE ROLE ANY MORE.
   *
   * `sanitizeRoles` drops a role that has been renamed out of `phoenixRoles`, which is right - a
   * string nobody holds must stop matching. But dropping it leaves `roles` EMPTY, and an empty
   * dimension means "no constraint", so the list keeps its line and region rules and quietly stops
   * being role-scoped. Measured against the live directory: retiring "Medical Rep" would widen 23
   * lists by 48 people, every regional reps list silently picking up its District Manager.
   *
   * That is a fail-OPEN in the one module written to fail closed, and the trigger is real - two
   * role names have already been retired in this repo. So the drop is recorded here and the matcher
   * refuses the whole list, which turns a silent widening into a visible empty list with a reason
   * on it. Narrowing wrongly is repairable; widening wrongly has already been sent.
   */
  rolesDropped: boolean;
};

/** Minimal projection of an employee the matcher needs. Kept narrow so a directory shape change
 *  cannot quietly alter who receives mail. */
export type DistributionCandidate = {
  hrId: string;
  displayName: string;
  workEmail: string | null;
  roles: PhoenixRole[];
  lineId: number | null;
  areaId: number | null;
  departmentId: number | null;
  positionId: number | null;
  /**
   * BOTH region fields, because neither alone is populated for everyone. Measured in production
   * 2026-09-11: 13 field employees carry a region_name with NO region_code, and every one of them
   * is a District Manager — so a region rule matched on the code alone silently produced an EMPTY
   * list for every region's DM while the reps' lists looked fine.
   */
  regionCode: string | null;
  regionName: string | null;
};

export type DistributionMember = {
  hrId: string;
  displayName: string;
  email: string;
  /** How this person got on the list — a rule match, or a name added by hand on top of it. */
  via: "rule" | "included";
};

export type ResolvedDistributionList = {
  listKey: string;
  label: string;
  enabled: boolean;
  members: DistributionMember[];
  /** Addresses with no employee behind them. Never filtered by the directory. */
  externalEmails: string[];
  /** Every address the list resolves to, members and externals, deduped and lowercased. */
  emails: string[];
  /** Named on the list but unreachable — no work email, or excluded. Surfaced, never silent:
   *  a recipient who quietly falls out of an audience is the failure nobody sees. */
  skipped: Array<{ hrId: string; displayName: string; reason: "no_work_email" | "excluded" }>;
  /** Set when the list was refused outright rather than resolved. Non-null always means zero
   *  members, and the caller must report it — a refusal and a genuinely empty audience are
   *  different facts that look identical once they are both an empty array. */
  refusedReason: string | null;
};

function normalizeEmail(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function hrKey(value: string | null | undefined): string {
  return canonicalHrIdKey(value) ?? "";
}

function keySet(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const key = hrKey(value);
    if (key) out.add(key);
  }
  return out;
}

/**
 * Did this stored value name roles, none of which survived sanitizing?
 *
 * Asked separately from `sanitizeRoles` because the answer is only visible where the RAW value is
 * still in hand - by the time a caller sees `PhoenixRole[]`, "asked for nothing" and "asked for a
 * role that no longer exists" are the same empty array, and they must not be treated alike.
 */
export function rolesWereDropped(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const named = value.filter((role) => typeof role === "string" && role.trim().length > 0);
  return named.length > 0 && sanitizeRoles(value).length === 0;
}

/** Drop anything that is not a live PhoenixRole. A role renamed out of existence must stop
 *  matching rather than silently persist as a string nobody holds. */
export function sanitizeRoles(value: unknown): PhoenixRole[] {
  if (!Array.isArray(value)) return [];
  const live = new Set<string>(phoenixRoles);
  return Array.from(new Set(value.filter((role): role is PhoenixRole => typeof role === "string" && live.has(role))));
}

/** Whether this list states a rule at all. */
export function hasRuleDimension(spec: DistributionListSpec): boolean {
  return (
    spec.allEmployees ||
    spec.roles.length > 0 ||
    spec.lineIds.length > 0 ||
    spec.areaIds.length > 0 ||
    spec.departmentIds.length > 0 ||
    spec.positionIds.length > 0 ||
    spec.regionCodes.length > 0
  );
}

/** True when the list says nothing at all: no rule, no names, no external addresses. Such a list
 *  can only be a half-finished edit, so it is refused loudly rather than resolved to silence. */
export function isEmptySpec(spec: DistributionListSpec): boolean {
  return !hasRuleDimension(spec) && spec.includedHrIds.length === 0 && spec.externalEmails.length === 0;
}

/**
 * Whether one person satisfies the rule half.
 *
 * AND across dimensions, OR within one: roles={'Medical Rep'} + lineIds=[3] reads "medical reps
 * on line 3", which is how a person describes an audience out loud. An EMPTY dimension is "no
 * constraint", never "matches nobody" — the opposite reading would make every list resolve empty
 * the moment a dimension was left blank, and an empty audience looks like a quiet success.
 *
 * But ALL dimensions empty is not a rule at all, and matches NOBODY rather than everybody. That
 * asymmetry is the safety property: the only way to address every employee is to state a rule
 * that genuinely covers them, never to leave a form blank and have it widen on its own.
 */
export function matchesDistributionRule(candidate: DistributionCandidate, spec: DistributionListSpec): boolean {
  if (!hasRuleDimension(spec)) return false;
  // A list whose every named role has been retired matches NOBODY. Placed above the all-employees
  // branch on purpose: a spec carrying both a dead role and the company-wide flag is incoherent,
  // and resolving that to the whole company is the worst available reading of it.
  if (spec.rolesDropped) return false;
  // Explicitly everyone. Every other dimension is ignored: an all-company list plus a line filter
  // is a contradiction, and widening beats narrowing here only because somebody had to switch it on.
  if (spec.allEmployees) return true;
  if (spec.roles.length > 0 && !candidate.roles.some((role) => spec.roles.includes(role))) return false;
  if (spec.lineIds.length > 0 && (candidate.lineId === null || !spec.lineIds.includes(candidate.lineId))) return false;
  if (spec.areaIds.length > 0 && (candidate.areaId === null || !spec.areaIds.includes(candidate.areaId))) return false;
  if (spec.departmentIds.length > 0 && (candidate.departmentId === null || !spec.departmentIds.includes(candidate.departmentId))) {
    return false;
  }
  if (spec.positionIds.length > 0 && (candidate.positionId === null || !spec.positionIds.includes(candidate.positionId))) {
    return false;
  }
  if (spec.regionCodes.length > 0) {
    // Matched against the CODE or the NAME. Neither field is populated for everyone: 13 District
    // Managers carry a region_name and no region_code, so a code-only match emptied every
    // region-DM list while leaving the reps' lists looking correct.
    const wanted = spec.regionCodes.map((code) => code.trim().toUpperCase()).filter(Boolean);
    const code = String(candidate.regionCode ?? "").trim().toUpperCase();
    const name = String(candidate.regionName ?? "").trim().toUpperCase();
    if (!wanted.includes(code) && !wanted.includes(name)) return false;
  }
  return true;
}

/**
 * Resolve a list against a set of candidates. The caller supplies only ACTIVE employees — a
 * leaver must never be handed to this function, because nothing here can tell one from a person
 * whose row is merely missing.
 *
 * Order is load-bearing: rule matches, then hand-added names on top, then exclusions last.
 * Exclusions win over both, so "everyone on the line except him" cannot be undone by the rule
 * widening later.
 */
export function resolveDistributionList(
  spec: DistributionListSpec,
  candidates: readonly DistributionCandidate[],
): ResolvedDistributionList {
  const refuse = (refusedReason: string): ResolvedDistributionList => ({
    emails: [],
    enabled: spec.enabled,
    externalEmails: [],
    label: spec.label,
    listKey: spec.listKey,
    members: [],
    refusedReason,
    skipped: [],
  });

  // Both refusals live HERE rather than in the caller. A guard one layer up protects only the
  // call sites that remember it, and what it guards is who receives company mail.
  if (!spec.enabled) return refuse(`Distribution list "${spec.listKey}" is switched off.`);
  if (isEmptySpec(spec)) {
    return refuse(`Distribution list "${spec.listKey}" states no rule, no names and no addresses. Refused.`);
  }
  if (spec.rolesDropped) {
    return refuse(
      `Distribution list "${spec.listKey}" names a role that no longer exists. Refused rather than resolved without the role filter, which would have widened it.`,
    );
  }

  const excluded = keySet(spec.excludedHrIds);
  const included = keySet(spec.includedHrIds);
  const skipped: ResolvedDistributionList["skipped"] = [];
  const byKey = new Map<string, DistributionMember>();

  for (const candidate of candidates) {
    const key = hrKey(candidate.hrId);
    if (!key) continue;

    const isIncluded = included.has(key);
    if (!isIncluded && !matchesDistributionRule(candidate, spec)) continue;

    if (excluded.has(key)) {
      skipped.push({ displayName: candidate.displayName, hrId: candidate.hrId, reason: "excluded" });
      continue;
    }

    const email = normalizeEmail(candidate.workEmail);
    if (!email) {
      skipped.push({ displayName: candidate.displayName, hrId: candidate.hrId, reason: "no_work_email" });
      continue;
    }

    // A person holding two auth accounts appears twice. Keep the first — the caller already
    // collapsed accounts to one entry per person, so a repeat here is a directory duplicate.
    if (!byKey.has(key)) {
      byKey.set(key, { displayName: candidate.displayName, email, hrId: candidate.hrId, via: isIncluded ? "included" : "rule" });
    }
  }

  const members = Array.from(byKey.values()).sort((left, right) => left.displayName.localeCompare(right.displayName));
  const externalEmails = Array.from(new Set(spec.externalEmails.map(normalizeEmail).filter(Boolean)));
  const emails = Array.from(new Set([...members.map((member) => member.email), ...externalEmails]));

  return {
    emails,
    enabled: spec.enabled,
    externalEmails,
    label: spec.label,
    listKey: spec.listKey,
    members,
    refusedReason: null,
    skipped,
  };
}

// ── Mail-server alias drift ──────────────────────────────────────────────────────────────────

export type AliasDriftEntry = {
  email: string;
  /** left_company is the one that matters: the person is gone but company mail still reaches
   *  them. not_on_list is a routine membership change. */
  reason: "left_company" | "not_on_list";
};

export type AliasDrift = {
  toAdd: string[];
  toRemove: AliasDriftEntry[];
  inSync: boolean;
};

/**
 * What to change by hand in the Turbify control panel so an alias matches its Phoenix list.
 *
 * `recordedEmails` is an attestation — what somebody last saw in that panel — so this compares
 * two claims, not a claim against reality. It cannot detect an alias edited since it was last
 * recorded; only re-recording can. The caller shows the age of the attestation for that reason.
 *
 * `activeEmails` is every address belonging to somebody still employed. An address recorded on
 * the alias, absent from the list AND absent from that set, is someone who has left.
 */
export function computeAliasDrift(input: {
  expectedEmails: readonly string[];
  recordedEmails: readonly string[];
  activeEmails: readonly string[];
}): AliasDrift {
  const expected = new Set(input.expectedEmails.map(normalizeEmail).filter(Boolean));
  const recorded = new Set(input.recordedEmails.map(normalizeEmail).filter(Boolean));
  const active = new Set(input.activeEmails.map(normalizeEmail).filter(Boolean));

  const toAdd = Array.from(expected).filter((email) => !recorded.has(email)).sort();
  const toRemove = Array.from(recorded)
    .filter((email) => !expected.has(email))
    .map<AliasDriftEntry>((email) => ({ email, reason: active.has(email) ? "not_on_list" : "left_company" }))
    .sort((left, right) => left.email.localeCompare(right.email));

  return { inSync: toAdd.length === 0 && toRemove.length === 0, toAdd, toRemove };
}
