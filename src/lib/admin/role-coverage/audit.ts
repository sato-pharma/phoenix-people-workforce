import { unstable_cache } from "next/cache.js";

import { getEmployeeDirectory, isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";

import {
  COVERAGE_ROLES,
  coverageRoleOf,
  scoreRoleCoverage,
  splitStartedRoster,
  type CoveragePerson,
  type CoverageRole,
  type RoleCoverageModuleResult,
} from "./coverage-roles";
import { ROLE_COVERAGE_MODULES, roleCoverageAccessContext, type RoleCoverageModule } from "./registry";

/**
 * The Role Coverage audit on /admin/data-health. For every module in the registry it calls the
 * SAME function the module's page calls to build its people list or its person filter, and
 * measures, role by role, how many of today's active people that list offers. It reads the real
 * population — never a declaration of what the module "should" contain — so a module that drops a
 * rung shows up the day it drops it.
 */

export type RoleCoverageAudit = {
  measuredAt: string;
  roster: { role: CoverageRole; headcount: number }[];
  activeEmployees: number;
  /** Active people whose start date is still ahead: named on the page, never scored (splitStartedRoster). */
  notStartedYet: { name: string; role: CoverageRole; startDate: string }[];
  modules: RoleCoverageModuleResult[];
  totals: {
    modules: number;
    complete: number;
    withGaps: number;
    probeFailed: number;
  };
};

const PROBE_TIMEOUT_MS = 25_000;
const PROBE_CONCURRENCY = 4;
const ROLE_COVERAGE_CACHE_TTL_SECONDS = 300;

function cairoTodayIso() {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());
}

async function loadCoverageRoster(): Promise<{ started: CoveragePerson[]; notStartedYet: CoveragePerson[] }> {
  const directory = await getEmployeeDirectory();
  const people = directory.employees.filter(isActiveDirectoryEmployee).map((employee) => ({
    hrId: employee.hrId,
    name: employee.displayName || employee.fullName,
    jobTitle: employee.jobTitle,
    role: coverageRoleOf(employee),
    startDate: employee.hireDate,
  }));
  return splitStartedRoster(people, cairoTodayIso());
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)} s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runProbe(module: RoleCoverageModule, roster: CoveragePerson[]): Promise<RoleCoverageModuleResult> {
  const started = Date.now();
  try {
    const offered = await withTimeout(
      module.probe({ roster, access: roleCoverageAccessContext }),
      PROBE_TIMEOUT_MS,
      module.label,
    );
    const scored = scoreRoleCoverage(roster, offered, module);
    return {
      id: module.id,
      label: module.label,
      href: module.href,
      population: module.population,
      source: module.source,
      status: scored.absentRoles.length > 0 || scored.partialRoles.length > 0 ? "gaps" : "complete",
      error: null,
      cells: scored.cells,
      absentRoles: scored.absentRoles,
      partialRoles: scored.partialRoles,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      id: module.id,
      label: module.label,
      href: module.href,
      population: module.population,
      source: module.source,
      status: "probe-failed",
      error: error instanceof Error ? error.message : String(error),
      cells: [],
      absentRoles: [],
      partialRoles: [],
      durationMs: Date.now() - started,
    };
  }
}

async function getRoleCoverageAuditUncached(): Promise<RoleCoverageAudit> {
  const { started: roster, notStartedYet } = await loadCoverageRoster();
  const results: RoleCoverageModuleResult[] = new Array(ROLE_COVERAGE_MODULES.length);
  let next = 0;
  async function worker() {
    while (next < ROLE_COVERAGE_MODULES.length) {
      const index = next;
      next += 1;
      results[index] = await runProbe(ROLE_COVERAGE_MODULES[index], roster);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, ROLE_COVERAGE_MODULES.length) }, worker));

  return {
    measuredAt: new Date().toISOString(),
    roster: COVERAGE_ROLES.map((role) => ({
      role,
      headcount: roster.filter((person) => person.role === role).length,
    })),
    activeEmployees: roster.length,
    notStartedYet: notStartedYet.map((person) => ({
      name: person.name,
      role: person.role,
      startDate: String(person.startDate ?? "").slice(0, 10),
    })),
    modules: results,
    totals: {
      modules: results.length,
      complete: results.filter((result) => result.status === "complete").length,
      withGaps: results.filter((result) => result.status === "gaps").length,
      probeFailed: results.filter((result) => result.status === "probe-failed").length,
    },
  };
}

export const getRoleCoverageAudit = unstable_cache(getRoleCoverageAuditUncached, ["role-coverage-audit"], {
  revalidate: ROLE_COVERAGE_CACHE_TTL_SECONDS,
});
