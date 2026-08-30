/**
 * The HR command centre — the landing dashboard for the two HR seats.
 *
 * COMPOSED FROM THE SAME CATALOGUE THE PERMISSIONS ARE. `HR_ROLE_BUNDLES` says which functions a
 * seat holds; this file says which tiles each FUNCTION contributes. A seat therefore sees exactly
 * the groups for the functions in its bundle, and moving a function between bundles moves its
 * tiles with it — nobody has to remember to edit a second list. That is the whole reason this is
 * keyed on `HrFunctionKey` rather than on the role name: a per-role tile list is a second source
 * of truth, and a second source of truth is how a seat ends up with a tile it cannot open.
 *
 * WHAT IT REFUSES TO DO. It never fetches a source no function in the seat's bundle asked for.
 * That is not only latency: HR Advisory holds no deductions grant, and a dashboard that read the
 * deductions month on her behalf would be doing, under her session, work her job description
 * forbids. `sourcesFor` is asserted in tests/hr-command-center.test.ts.
 *
 * EVERY FIGURE COMES FROM THE PAGE'S OWN SERVICE. Each tile is computed from the same function
 * the linked page calls — `getRecruitmentDashboard` for Recruitment, `getProbationRows` for
 * Probation, and so on — so a tile and the page behind it cannot disagree. Writing a faster
 * bespoke count here would be the same mistake as an export that does not match the screen.
 *
 * EVERY SOURCE DEGRADES ALONE. One failing table must not blank a dashboard that is somebody's
 * home page, so each fetch is wrapped: a failure drops that group and names the source in
 * `unavailableSources`, and every other group still renders. A missing table is a real state here
 * — several of these services return `[]` for one and the rest throw.
 *
 * ZEROES ARE RENDERED, NOT HIDDEN. The owner's rule for this class of page (finance command
 * centre, 2026-08-10): "relevant even if empty, no data now, tomorrow will be populated." Both
 * seats start on 1 September 2026 with every figure at zero, so this matters more here than
 * anywhere — a dashboard that hides its empty tiles would, on day one, render nothing at all. The
 * limit is the other half of that rule: a tile whose source CANNOT fill is a false promise, so
 * every tile below reads a value something in the product actually writes.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import {
  getHrFunction,
  HR_ROLE_BUNDLES,
  type HrBundleName,
  type HrFunctionKey,
} from "@/lib/auth/hr-functions";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";
import { getClearanceDashboardData } from "@/lib/clearance/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { getCompanyMonthSummaryByCategory } from "@/lib/deductions/service";
import {
  getEmployeeDirectory,
  isActiveDirectoryEmployee,
} from "@/lib/employees/employee-directory";
import { hasMissingEmployeeRecordData } from "@/lib/employees/employee-record-health";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { listOffers } from "@/lib/offers/service";
import { getProbationRows, isProbationDecisionOutstanding } from "@/lib/probation/service";
import { getRecruitmentDashboard } from "@/lib/recruitment/dashboard";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { getRetentionDashboardData } from "@/lib/retention/service";
import { listAllSupportRequests } from "@/lib/support-requests/service";

/** Matches the tones the finance command centre's MetricTile accepts, deliberately. */
export type HrCommandTone = "amber" | "emerald" | "rose" | "slate";

export type HrCommandTile = {
  /** Where the figure is actioned. Always an `/hr` address — these seats live in that namespace. */
  href: string;
  key: string;
  label: string;
  /** The unit, rendered under the figure. Never a sentence — this is a 10px uppercase caption. */
  sub: string;
  tone: HrCommandTone;
  value: number;
};

export type HrCommandGroup = {
  functionKey: HrFunctionKey;
  label: string;
  summary: string;
  tiles: HrCommandTile[];
};

export type HrCommandCenterData = {
  groups: HrCommandGroup[];
  seat: HrBundleName;
  /**
   * Sources that threw. Named rather than counted so the page can say WHICH figures are missing:
   * a dashboard silently short a group reads as "nothing to do today", which is the one wrong
   * answer a queue can give.
   */
  unavailableSources: string[];
};

/** The raw fetches. One per underlying service, so two functions wanting the same data share it. */
type SourceKey =
  | "attendanceExceptions"
  | "contracts"
  | "deductions"
  | "directory"
  | "offers"
  | "clearance"
  | "probation"
  | "recruitment"
  | "resignations"
  | "retention"
  | "supportRequests";

/**
 * Which raw fetches each function needs. The union across a seat's bundle is all this module is
 * allowed to load — see the header. `directory` appearing twice is the point: HR Operations holds
 * both `people_records` and (via nothing) no second copy of it, and the fetch still happens once.
 */
const SOURCES_BY_FUNCTION: Record<HrFunctionKey, readonly SourceKey[]> = {
  engagement_retention: ["supportRequests", "retention"],
  // NONE, deliberately. `hr_governance` grants employee_documents:read/export and overview:read
  // and nothing else — neither is a queue, and there is no figure in the product that counts
  // "governance". A tile here could only be invented, and an invented tile is the false promise
  // the owner's rule for this page type forbids. See TILES_BY_FUNCTION.hr_governance.
  hr_governance: [],
  payroll_inputs: ["deductions"],
  // `contracts` belongs HERE and not under hr_governance, which is where it was first written.
  // Contract renewal is a lifecycle event, and more to the point `people_records` is the only
  // function that grants contracts at all — hr_governance is held by BOTH seats, so putting the
  // renewal tiles there offered HR Advisory a figure linking to /hr/contracts, which she has no
  // grant to open. That is the Deductions defect (see system-navigation.ts, hr-payroll) rebuilt
  // one layer down, and tests/hr-command-center.test.ts now fails on it mechanically.
  // `clearance` belongs HERE for the same reason `contracts` does: people_records is the only
  // function that grants it. Putting it under hr_governance - held by BOTH seats - would offer
  // HR Advisory a figure linking to /hr/clearance, which she has no grant to open.
  people_records: ["clearance", "contracts", "directory", "resignations"],
  performance_probation: ["probation"],
  recruiting: ["recruitment", "offers"],
  time_attendance: ["attendanceExceptions"],
  workforce_insight: ["directory"],
};

/** The seat's functions, straight from the permission bundle. Never a second hand-kept list. */
export function hrBundleForRole(role: string): HrBundleName | null {
  return role in HR_ROLE_BUNDLES ? (role as HrBundleName) : null;
}

/** Every raw fetch the seat's bundle justifies, deduplicated. Exported so a test can assert it. */
export function sourcesFor(seat: HrBundleName): SourceKey[] {
  const keys = new Set<SourceKey>();
  for (const functionKey of HR_ROLE_BUNDLES[seat]) {
    for (const source of SOURCES_BY_FUNCTION[functionKey]) keys.add(source);
  }
  return [...keys].sort();
}

/**
 * Everything the fetch step produced. Exported so tests can drive the tile builders with empty but
 * well-formed sources and read the hrefs the REAL builders emit — a test that re-listed the hrefs
 * itself would pass while the page pointed somewhere else.
 */
export type HrCommandSources = Partial<{
  attendanceExceptions: Awaited<ReturnType<typeof getAttendanceExceptions>>;
  clearance: Awaited<ReturnType<typeof getClearanceDashboardData>>;
  contracts: Awaited<ReturnType<typeof getContractRenewalDashboardData>>;
  deductions: Awaited<ReturnType<typeof getCompanyMonthSummaryByCategory>>;
  directory: Awaited<ReturnType<typeof getEmployeeDirectory>>;
  offers: Awaited<ReturnType<typeof listOffers>>;
  probation: Awaited<ReturnType<typeof getProbationRows>>;
  recruitment: Awaited<ReturnType<typeof getRecruitmentDashboard>>;
  resignations: Awaited<ReturnType<typeof getResignationsDashboardData>>;
  retention: Awaited<ReturnType<typeof getRetentionDashboardData>>;
  supportRequests: Awaited<ReturnType<typeof listAllSupportRequests>>;
}>;

/** `YYYY-MM` for the running month in Cairo — the owner reports every time in Cairo, never UTC. */
function currentCairoMonthKey(): string {
  const { year, month } = currentCairoDateParts();
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Whole days between an ISO timestamp and now, floored at 0. Null input means "no age". */
function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/** Amber once anything is waiting, rose once the oldest has been waiting a working week. */
function queueTone(count: number, oldestDays: number): HrCommandTone {
  if (count === 0) return "emerald";
  return oldestDays >= 5 ? "rose" : "amber";
}

function tile(
  key: string,
  label: string,
  value: number,
  sub: string,
  href: string,
  tone: HrCommandTone = "slate",
): HrCommandTile {
  return { href, key, label, sub, tone, value };
}

/**
 * The tiles each function contributes, given whatever loaded. Returns null when the function's
 * source is unavailable, which drops the group rather than rendering a row of zeroes that would
 * read as "all clear".
 */
const TILES_BY_FUNCTION: Record<
  HrFunctionKey,
  (loaded: HrCommandSources) => HrCommandTile[] | null
> = {
  recruiting: (loaded) => {
    const dashboard = loaded.recruitment;
    if (!dashboard) return null;
    const stage = dashboard.summary.stageCounts;
    const screening =
      (stage.cv_screening ?? 0) + (stage.phone_screening ?? 0) + (stage.application_received ?? 0);
    const interviewing =
      (stage.interview_scheduling ?? 0) +
      (stage.hr_interview ?? 0) +
      (stage.hiring_manager_interview ?? 0);
    const tiles = [
      tile("open-requisitions", "Open Vacancies", dashboard.summary.openRequisitions, "approved & live", "/hr/recruitment", dashboard.summary.openRequisitions > 0 ? "amber" : "slate"),
      tile("in-screening", "In Screening", screening, "awaiting your review", "/hr/recruitment", screening > 0 ? "amber" : "slate"),
      tile("interviewing", "Interviewing", interviewing, "scheduled or in progress", "/hr/recruitment"),
      tile("active-applications", "Active Candidates", dashboard.summary.activeApplications, "still in the pipeline", "/hr/cv-database"),
      tile("hired", "Hired", dashboard.summary.hires, "converted to employees", "/hr/recruitment", dashboard.summary.hires > 0 ? "emerald" : "slate"),
    ];
    // Offers load separately, so a failure there costs this one tile rather than the whole group.
    if (loaded.offers) {
      const awaiting = loaded.offers.filter((offer) => offer.status === "sent").length;
      tiles.push(tile("offers-sent", "Offers Out", awaiting, "awaiting a reply", "/hr/offers", awaiting > 0 ? "amber" : "slate"));
    }
    return tiles;
  },

  engagement_retention: (loaded) => {
    const rows = loaded.supportRequests;
    if (!rows) return null;
    const open = rows.filter((row) => row.status === "Pending" || row.status === "In Progress");
    const untouched = rows.filter((row) => row.status === "Pending");
    const oldest = untouched.reduce((max, row) => Math.max(max, daysSince(row.createdAt)), 0);
    const tiles = [
      tile("support-open", "Open Requests", open.length, "employees waiting", "/hr/admin/support-requests", queueTone(open.length, oldest)),
      tile("support-untouched", "Not Yet Started", untouched.length, "still unanswered", "/hr/admin/support-requests", queueTone(untouched.length, oldest)),
      tile("support-oldest", "Longest Wait", oldest, oldest === 1 ? "day" : "days", "/hr/admin/support-requests", oldest >= 5 ? "rose" : oldest > 0 ? "amber" : "emerald"),
    ];
    if (loaded.retention) {
      const stats = loaded.retention.stats;
      tiles.push(
        tile("retention-stay", "Stay Discussions", stats.stayCount, "last 12 months", "/hr/retention", stats.stayCount > 0 ? "emerald" : "amber"),
        tile("retention-risk", "High Retention Risk", stats.highRisk, "flagged in a discussion", "/hr/retention", stats.highRisk > 0 ? "rose" : "emerald"),
        // Follow-ups, not exit coverage. Coverage is a PERCENTAGE that is legitimately null when
        // nobody has left, and a tile value is a number - rendering that null as 0 would say
        // "0% of leavers interviewed" on a month with no leavers, which is the misleading zero
        // AGENTS.md §7 forbids. The page shows coverage properly, with a dash for the null case.
        tile("retention-followups", "Overdue Follow-ups", stats.overdueFollowUps, "promised, not done", "/hr/retention", stats.overdueFollowUps > 0 ? "rose" : "emerald"),
      );
    }
    return tiles;
  },

  performance_probation: (loaded) => {
    const rows = loaded.probation;
    if (!rows) return null;
    const outstanding = rows.filter((row) => isProbationDecisionOutstanding(row));
    return [
      tile("probation-open", "Probation Cases", rows.length, "in the window", "/hr/probation"),
      tile("probation-decisions", "Awaiting Decision", outstanding.length, "need a verdict", "/hr/probation", outstanding.length > 0 ? "amber" : "emerald"),
    ];
  },

  workforce_insight: (loaded) => {
    const directory = loaded.directory;
    if (!directory) return null;
    const openSeats =
      directory.lookups.medicalRepVacancies.length + directory.lookups.workforceVacancies.length;
    return [
      tile("headcount", "Active Headcount", directory.summary.activeEmployees, "on the payroll", "/hr/employee-360", "emerald"),
      tile("open-seats", "Vacant Seats", openSeats, "in the organogram", "/hr/reports/vacancies", openSeats > 0 ? "amber" : "slate"),
      tile("no-manager", "No Manager Set", directory.summary.employeesWithoutManagers, "unreported lines", "/hr/organogram", directory.summary.employeesWithoutManagers > 0 ? "amber" : "emerald"),
      tile("lines", "Lines Covered", directory.summary.uniqueLines, "business lines", "/hr/organogram"),
    ];
  },

  people_records: (loaded) => {
    const directory = loaded.directory;
    if (!directory) return null;
    const incomplete = directory.employees.filter(
      (employee) => isActiveDirectoryEmployee(employee) && hasMissingEmployeeRecordData(employee),
    ).length;
    const tiles = [
      tile("headcount", "Active Headcount", directory.summary.activeEmployees, "on the payroll", "/hr/employee-360", "emerald"),
      tile("incomplete-records", "Incomplete Records", incomplete, "missing required data", "/hr/employee-360", incomplete > 0 ? "amber" : "emerald"),
      // /hr/employee-360, NOT /hr/organogram — this figure is about employee RECORDS, and no
      // function in the HR Operations bundle grants `organogram` at all. The organogram spelling
      // was written here first and would have rendered a tile she cannot open.
      tile("no-manager", "No Manager Set", directory.summary.employeesWithoutManagers, "records to complete", "/hr/employee-360", directory.summary.employeesWithoutManagers > 0 ? "amber" : "emerald"),
    ];
    if (loaded.resignations) {
      const summary = loaded.resignations.summary;
      tiles.push(
        tile("resignations-open", "Resignations In Flight", summary.pending + summary.approved, "not yet completed", "/hr/resignations", summary.pending > 0 ? "amber" : "slate"),
      );
    }
    if (loaded.clearance) {
      const stats = loaded.clearance.stats;
      tiles.push(
        tile("clearance-open", "Clearances Open", stats.open, "stations to chase", "/hr/clearance", stats.open > 0 ? "amber" : "emerald"),
        tile("clearance-ready", "Ready To Release", stats.ready, "your step", "/hr/clearance", stats.ready > 0 ? "amber" : "emerald"),
        tile("clearance-overdue", "Past Last Day", stats.overdue, "still unreleased", "/hr/clearance", stats.overdue > 0 ? "rose" : "emerald"),
      );
      // Without this tile the three above all read 0 on the day this shipped — "nothing waiting on
      // you" — while 54 recorded departures had no checklist at all, because the auto-open trigger
      // only fires on resignations recorded after it. A count of zero that means "not started" is
      // the misleading-zero trap, and this is the landing page it would have appeared on.
      if (loaded.clearance.awaiting.length > 0) {
        tiles.push(
          tile("clearance-awaiting", "No Clearance Opened", loaded.clearance.awaiting.length, "departures to start", "/hr/clearance", "rose"),
        );
      }
    }
    if (loaded.contracts) {
      const summary = loaded.contracts.summary;
      tiles.push(
        tile("contracts-active", "Renewals In Flight", summary.activeRequests, "open requests", "/hr/contracts", summary.activeRequests > 0 ? "amber" : "slate"),
        tile("contracts-hr", "At HR Review", summary.hrReview, "your step", "/hr/contracts", summary.hrReview > 0 ? "amber" : "emerald"),
      );
    }
    return tiles;
  },

  time_attendance: (loaded) => {
    const exceptions = loaded.attendanceExceptions;
    if (!exceptions) return null;
    const pending = exceptions.filter((row) => row.status === "pending");
    const oldest = pending.reduce((max, row) => Math.max(max, daysSince(row.createdAt)), 0);
    return [
      tile("attendance-pending", "Attendance Exceptions", pending.length, "awaiting review", "/hr/attendance", queueTone(pending.length, oldest)),
      tile("attendance-oldest", "Longest Wait", oldest, oldest === 1 ? "day" : "days", "/hr/attendance", oldest >= 5 ? "rose" : oldest > 0 ? "amber" : "emerald"),
      tile("attendance-reviewed", "Reviewed", exceptions.length - pending.length, "decided so far", "/hr/attendance"),
    ];
  },

  payroll_inputs: (loaded) => {
    const summary = loaded.deductions;
    if (!summary) return null;
    // READ-ONLY for this seat, deliberately: `payroll_inputs` grants deductions:read and nothing
    // more, because approving a disciplinary penalty is a JD boundary (HR_ROLE_BOUNDARIES). These
    // tiles report the month; the decisions behind them are not hers to take. The two deduction tiles
    // drill down to Payroll Management (a page this seat can open), NOT to a deductions-review page:
    // the retired Deductions Governance page was her only such screen, and its unified replacement
    // (/admin/deductions) is gated to Super Admin / CEO. So as of the C6 cutover (2026-08-30, owner
    // decision) the count stays visible here and Payroll Management is where she reconciles it. The
    // counts themselves come from the unified module (getCompanyMonthSummaryByCategory) and are unchanged.
    const pendingCandidates = Object.values(summary.pending).reduce((total, bucket) => total + bucket.candidateCount, 0);
    const willPublishCandidates = Object.values(summary.willPublish).reduce((total, bucket) => total + bucket.candidateCount, 0);
    return [
      tile("deductions-pending", "Awaiting Decision", pendingCandidates, "this month", "/hr/admin/payroll-management", pendingCandidates > 0 ? "amber" : "emerald"),
      tile("deductions-ready", "Ready To Publish", willPublishCandidates, "this month", "/hr/admin/payroll-management"),
      tile("payroll-month", "Payroll Month", Number(currentCairoMonthKey().slice(5)), "running period", "/hr/admin/payroll-management"),
    ];
  },

  /**
   * NO TILES, deliberately — and this empty array is a decision, not an omission.
   *
   * `hr_governance` is the one function BOTH seats hold, which makes it the most tempting place to
   * put a shared figure and the most dangerous. Its grants are employee_documents:read/export and
   * overview:read: a document library and a landing permission. Neither is a queue, so any tile
   * here would be a number invented to fill the space — and the owner's rule for this page type
   * ends with the limit that matters: show an empty stage that CAN fill, delete one that cannot.
   *
   * The contract-renewal tiles lived here in the first draft and have moved to `people_records`,
   * which is the function that actually grants `contracts`. Read the note there before moving
   * anything back: a tile under a shared function is offered to a seat that may not hold the
   * grant its link needs.
   */
  hr_governance: () => [],
};

/**
 * Runs `load`, and on any failure records the source name and returns null instead of throwing.
 *
 * Deliberately catches everything. The callers are real services that throw on a missing table, an
 * absent env var, a Supabase abort at 15s — and the correct response to every one of them is the
 * same: this dashboard shows the groups it could read and says which it could not.
 */
async function safe<T>(
  key: SourceKey,
  load: () => Promise<T>,
  failures: SourceKey[],
): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    failures.push(key);
    return undefined;
  }
}

/** Human wording for the unavailable notice. A source key means nothing to the person reading it. */
const SOURCE_LABELS: Record<SourceKey, string> = {
  attendanceExceptions: "Attendance exceptions",
  clearance: "Clearance checklists",
  contracts: "Contract renewals",
  deductions: "Deductions month",
  directory: "Employee directory",
  offers: "Job offers",
  probation: "Probation cases",
  recruitment: "Recruitment pipeline",
  resignations: "Resignations",
  retention: "Retention register",
  supportRequests: "HR support requests",
};

export async function getHrCommandCenterData(
  access: AccessContext,
): Promise<HrCommandCenterData | null> {
  const seat = hrBundleForRole(access.role);
  if (!seat) return null;

  const needed = new Set(sourcesFor(seat));
  const failures: SourceKey[] = [];
  const loaded: HrCommandSources = {};

  // Only the sources the bundle justifies, all at once. A seat's dashboard is as slow as its
  // slowest source, not the sum of them.
  await Promise.all([
    needed.has("recruitment")
      ? safe("recruitment", () => getRecruitmentDashboard(access), failures).then((value) => {
          loaded.recruitment = value;
        })
      : null,
    needed.has("offers")
      ? safe("offers", () => listOffers(), failures).then((value) => {
          loaded.offers = value;
        })
      : null,
    needed.has("supportRequests")
      ? safe("supportRequests", () => listAllSupportRequests(access, { limit: 200 }), failures).then((value) => {
          loaded.supportRequests = value;
        })
      : null,
    needed.has("probation")
      ? safe("probation", () => getProbationRows(access), failures).then((value) => {
          loaded.probation = value;
        })
      : null,
    needed.has("directory")
      ? safe("directory", () => getEmployeeDirectory(), failures).then((value) => {
          loaded.directory = value;
        })
      : null,
    needed.has("contracts")
      ? safe("contracts", () => getContractRenewalDashboardData(access), failures).then((value) => {
          loaded.contracts = value;
        })
      : null,
    needed.has("resignations")
      ? safe("resignations", () => getResignationsDashboardData(access), failures).then((value) => {
          loaded.resignations = value;
        })
      : null,
    needed.has("attendanceExceptions")
      ? safe("attendanceExceptions", () => getAttendanceExceptions({ status: "all" }), failures).then((value) => {
          loaded.attendanceExceptions = value;
        })
      : null,
    needed.has("clearance")
      ? safe("clearance", () => getClearanceDashboardData(access), failures).then((value) => {
          loaded.clearance = value;
        })
      : null,
    needed.has("retention")
      ? safe("retention", () => getRetentionDashboardData(access), failures).then((value) => {
          loaded.retention = value;
        })
      : null,
    needed.has("deductions")
      ? safe("deductions", () => getCompanyMonthSummaryByCategory({ monthKey: currentCairoMonthKey() }), failures).then((value) => {
          loaded.deductions = value;
        })
      : null,
  ]);

  return {
    groups: buildHrCommandGroups(seat, loaded),
    seat,
    unavailableSources: failures.map((key) => SOURCE_LABELS[key]).sort(),
  };
}

/**
 * The composition step, with the fetching taken out — pure, so a test can drive it with empty but
 * well-formed sources and read the hrefs the real builders emit.
 *
 * Order follows `HR_ROLE_BUNDLES[seat]`, so the dashboard reads down the seat's functions in the
 * order its permissions are declared in. A group is skipped when its builder returns null (the
 * source failed) or an empty array (the function contributes no tiles by design, which today is
 * `hr_governance` alone) — the two are different reasons and both correctly render nothing.
 */
export function buildHrCommandGroups(
  seat: HrBundleName,
  loaded: HrCommandSources,
): HrCommandGroup[] {
  const groups: HrCommandGroup[] = [];
  for (const functionKey of HR_ROLE_BUNDLES[seat]) {
    const tiles = TILES_BY_FUNCTION[functionKey](loaded);
    if (!tiles || tiles.length === 0) continue;
    const definition = getHrFunction(functionKey);
    groups.push({
      functionKey,
      label: definition.label,
      summary: definition.summary,
      tiles,
    });
  }
  return groups;
}
