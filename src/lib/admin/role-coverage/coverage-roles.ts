import { resolveJobFunctionRole } from "@/lib/employees/job-function";
import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * ROLE COVERAGE — the roles a module's people list is measured against.
 *
 * Owner, 2026-10-20: "many modules all over Phoenix show only reports on reps, and when you filter
 * by manager you find no manager; others only head-office employees and you find no field force …
 * every single role that is applicable to appear in a module — find it, show it, and add it to the
 * Super Admin deep audit." The deep audit is /admin/data-health; the module list is
 * `registry.ts`, and this file is the pure half both it and the tests use.
 *
 * A person's coverage role is their JOB FUNCTION (`resolveJobFunctionRole`, the one title
 * classifier every job-function rule already uses — so a Senior Medical Representative is a Medical
 * Rep and a Senior District Manager is a District Manager here exactly as in attendance, coaching
 * and the portal), and everybody whose function is not a field or line-marketing one is Head Office.
 * The Chief Executive is his own bucket because several modules leave him out ON PURPOSE (he
 * approves, he is not reported on), and folding him into Head Office would make each of those read
 * as a hole in Head Office.
 */
export const COVERAGE_ROLES = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Head Office",
  "CEO",
] as const;

export type CoverageRole = (typeof COVERAGE_ROLES)[number];

/** The four field-force rungs: the rep and the three managers above him. */
export const FIELD_FORCE_COVERAGE_ROLES: readonly CoverageRole[] = [
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
];

/** The three managers above the rep — the rungs a "filter by manager" must be able to find. */
export const FIELD_MANAGER_COVERAGE_ROLES: readonly CoverageRole[] = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
];

/** Everybody who works for the company, every rung. */
export const ALL_COVERAGE_ROLES: readonly CoverageRole[] = COVERAGE_ROLES;

export const COVERAGE_ROLE_LABELS: Record<CoverageRole, string> = {
  "Medical Rep": "Medical Representatives",
  "District Manager": "District Managers",
  "Regional Manager": "Regional Managers",
  "National Sales Manager": "National Sales Managers",
  "Product Manager": "Product Managers",
  "Group Product Manager": "Group Product Managers",
  "Head Office": "Head Office staff",
  CEO: "Chief Executive",
};

const CEO_TITLES = new Set(["ceo", "chief executive officer", "chief executive"]);

export function coverageRoleOf(person: { jobTitle: string | null | undefined }): CoverageRole {
  const title = String(person.jobTitle ?? "").trim().toLowerCase();
  if (CEO_TITLES.has(title)) return "CEO";
  const fn = resolveJobFunctionRole(person.jobTitle);
  switch (fn) {
    case "Medical Rep":
    case "District Manager":
    case "Regional Manager":
    case "National Sales Manager":
    case "Product Manager":
    case "Group Product Manager":
      return fn;
    case "CEO":
      return "CEO";
    default:
      return "Head Office";
  }
}

export type CoveragePerson = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  role: CoverageRole;
  /** The directory's start date (YYYY-MM-DD), when it has one. */
  startDate?: string | null;
};

/**
 * The roster the audit measures against: people who have STARTED by `todayIso` (Cairo). A person whose
 * start date is still ahead holds no team, no plan and no visit yet, so every list built from what
 * people do rightly leaves them out — scoring them would raise a gap that is not one (a District
 * Manager starting in four days read "missing" from five lists on 2026-10-20). They are returned
 * apart, so the page can name them instead of hiding them.
 */
export function splitStartedRoster<T extends Pick<CoveragePerson, "startDate">>(
  people: readonly T[],
  todayIso: string,
): { started: T[]; notStartedYet: T[] } {
  const started: T[] = [];
  const notStartedYet: T[] = [];
  for (const person of people) {
    const start = String(person.startDate ?? "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && start > todayIso) notStartedYet.push(person);
    else started.push(person);
  }
  return { started, notStartedYet };
}

export type RoleCoverageCell = {
  role: CoverageRole;
  /** Active people in this role today. */
  headcount: number;
  /** How many of them the module's own people list offers. */
  present: number;
  /** Those it does not, by name. */
  missing: { hrId: string; name: string; jobTitle: string | null }[];
  /** "applies" — the role must appear; "left-out" — left out on purpose, with the reason. */
  expectation: "applies" | "left-out";
  leftOutReason: string | null;
  /**
   * "absent" — the role applies and nobody in it is offered; "partial" — some are, some are not;
   * "left-out-but-shown" — declared left out, yet the page offers people in it, so the stated rule
   * and the page no longer agree.
   */
  status:"complete" | "partial" | "absent" | "nobody-in-role" | "left-out" | "left-out-but-shown";
};

export type RoleCoverageModuleResult = {
  id: string;
  label: string;
  href: string;
  population: string;
  /** The function the probe called — the same one the page uses. */
  source: string;
  status: "complete" | "gaps" | "probe-failed";
  error: string | null;
  cells: RoleCoverageCell[];
  /** Applicable roles with nobody present although people hold them. */
  absentRoles: CoverageRole[];
  /** Applicable roles with some, not all, present. */
  partialRoles: CoverageRole[];
  durationMs: number;
};

export type RoleCoverageDeclaration = {
  applies: readonly CoverageRole[];
  leftOut?: Partial<Record<CoverageRole, string>>;
};

/**
 * Score one module: for every role it applies to, how many of today's active people in that role
 * its own people list offers, and who is missing. A role it leaves out on purpose is reported as
 * such, never as a gap — and if the module shows people of a left-out role anyway, that is reported
 * too, because the stated rule and the page no longer agree.
 */
export function scoreRoleCoverage(
  roster: readonly CoveragePerson[],
  offeredHrIds: Iterable<string>,
  declaration: RoleCoverageDeclaration,
): { cells: RoleCoverageCell[]; absentRoles: CoverageRole[]; partialRoles: CoverageRole[] } {
  const offered = new Set<string>();
  for (const id of offeredHrIds) {
    const key = canonicalHrIdKey(id);
    if (key) offered.add(key);
  }
  const applies = new Set(declaration.applies);
  const leftOut = declaration.leftOut ?? {};
  const cells: RoleCoverageCell[] = [];
  const absentRoles: CoverageRole[] = [];
  const partialRoles: CoverageRole[] = [];

  for (const role of COVERAGE_ROLES) {
    const isApplicable = applies.has(role);
    const reason = leftOut[role] ?? null;
    if (!isApplicable && !reason) continue;
    const people = roster.filter((person) => person.role === role);
    const presentPeople = people.filter((person) => offered.has(canonicalHrIdKey(person.hrId) ?? ""));
    const missing = people
      .filter((person) => !offered.has(canonicalHrIdKey(person.hrId) ?? ""))
      .map((person) => ({ hrId: person.hrId, name: person.name, jobTitle: person.jobTitle }))
      .sort((a, b) => a.name.localeCompare(b.name));

    let status: RoleCoverageCell["status"];
    if (!isApplicable) {
      status = presentPeople.length > 0 ? "left-out-but-shown" : "left-out";
    } else if (people.length === 0) {
      status = "nobody-in-role";
    } else if (presentPeople.length === 0) {
      status = "absent";
      absentRoles.push(role);
    } else if (missing.length > 0) {
      status = "partial";
      partialRoles.push(role);
    } else {
      status = "complete";
    }

    cells.push({
      role,
      headcount: people.length,
      present: presentPeople.length,
      missing: isApplicable ? missing : [],
      expectation: isApplicable ? "applies" : "left-out",
      leftOutReason: isApplicable ? null : reason,
      status,
    });
  }

  return { cells, absentRoles, partialRoles };
}

