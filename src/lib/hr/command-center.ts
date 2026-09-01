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

import {
  buildPermissionLookup,
  permissionMatrix,
  type AccessContext,
} from "@/lib/auth/permissions";
import {
  getHrFunction,
  HR_ROLE_BUNDLES,
  type HrBundleName,
  type HrFunctionKey,
} from "@/lib/auth/hr-functions";
import { getEmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { getCompanyMonthSummaryByCategory } from "@/lib/deductions/service";
import { deductionsCategories, type DeductionsCategory } from "@/lib/deductions/types";
import {
  getEmployeeDirectory,
  isActiveDirectoryEmployee,
} from "@/lib/employees/employee-directory";
import { hasMissingEmployeeRecordData } from "@/lib/employees/employee-record-health";
import { getExcuseWorkspace } from "@/lib/excuses/service";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import { toHrNamespacePath } from "@/lib/navigation/shell-headers";
import { listOffers } from "@/lib/offers/service";
import { getProbationRows, isProbationDecisionOutstanding } from "@/lib/probation/service";
import { getRecruitmentDashboard } from "@/lib/recruitment/dashboard";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { getRetentionDashboardData } from "@/lib/retention/service";
import { listAllSupportRequests } from "@/lib/support-requests/service";
import { getVacationRequestPageData } from "@/lib/vacation/service";
import { resolvePersonalWorkspaceTabs } from "@/lib/workspace/personal-workspace-nav";
import {
  buildHrTodayTasks,
  openWorkforceSeats,
  splitVacanciesByRequisition,
  type HrTask,
} from "@/lib/hr/today-tasks";

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

/**
 * One plotted series inside an HrCommandChart. `color` is a hex literal rather than a Tailwind
 * class because it is handed to recharts as an SVG fill, and Tailwind cannot build a class name at
 * runtime anyway. The values come from the house palette the analytics dashboards already use.
 */
export type HrCommandChartSeries = {
  color: string;
  key: string;
  name: string;
};

/**
 * A shape, where a tile gives a number.
 *
 * WHY THIS EXISTS. The owner's verdict on this page, 2026-09-01: "there are too many key codes,
 * there are no any chart." He was right on both halves — HR Operations was shown 22 figures and not
 * one shape, and a figure cannot answer the questions this seat actually has. "Attendance
 * Exceptions 14" does not say whether that is a bad Tuesday or a fortnight of drift; "Renewals In
 * Flight 6" does not say whether next month holds six renewals or sixty.
 *
 * DECLARED PER FUNCTION, exactly like the tiles, and for exactly the same reason: CHARTS_BY_FUNCTION
 * is keyed by HrFunctionKey and read by looping `HR_ROLE_BUNDLES[seat]`, so a seat can only ever be
 * shown a chart drawn from a source its own bundle already loads. Move a function between bundles
 * and its chart moves with it. There is no second list to keep in step.
 *
 * EVERY ROW IS COUNTED FROM REAL RECORDS. Nothing here is smoothed, forecast, extrapolated or
 * back-filled — each bar is a `filter().length` over rows already on the page. A dashboard chart
 * that models anything is a chart that can be wrong in a way no reader can check.
 *
 * IT IS PLAIN DATA, deliberately: numbers and strings only, no functions and no JSX. This crosses
 * the server/client boundary as props, and the formatter that renders it lives on the client side
 * (AnalyticsTrendChart) precisely so nothing unserializable has to make the trip.
 *
 * AN EMPTY CHART STILL RENDERS ITS NAME. `emptyLabel` is shown in place of the plot when every bar
 * is zero, because a chart that vanishes when there is nothing in it teaches a new seat that the
 * measure does not exist — the same rule the tasks follow with `clearLabel`.
 */
export type HrCommandChart = {
  /** What the shape MEANS, in a sentence. Never a restatement of the title. */
  caption: string;
  /** Shown instead of a flat plot when every bar is zero. Says what the chart would show. */
  emptyLabel: string;
  href: string;
  hrefLabel: string;
  key: string;
  /**
   * The plotted rows. Each carries `label` (the x axis) plus one numeric field per series key.
   * Deliberately loose in type and strict in construction — every producer below builds it from a
   * literal so a typo in a series key cannot silently plot nothing.
   */
  rows: Record<string, number | string>[];
  series: HrCommandChartSeries[];
  title: string;
};

export type HrCommandGroup = {
  /**
   * The function's charts, drawn above its tiles. Empty for a function whose sources cannot
   * honestly support one — never a placeholder, and never a chart of a single number.
   */
  charts: HrCommandChart[];
  functionKey: HrFunctionKey;
  label: string;
  summary: string;
  tiles: HrCommandTile[];
};

/**
 * The viewer's OWN employment record, merged onto this page on 2026-09-01 at the owner's
 * instruction: "make the overview dashboard merged between HR overview and my workspace into one
 * landing overview page."
 *
 * It used to be a second landing page at /workspace, one sidebar row below this one. Two overview
 * pages for one seat is one too many — she signs in, lands here, and the four facts about her own
 * employment (leave, excuses, attendance) were a click away on a page that repeated this one's
 * furniture. They are the same fields the /workspace dashboard renders, from the same three
 * services, so the merged section and the pages behind it cannot disagree.
 *
 * NO PAYROLL FIGURE APPEARS IN IT, and none may be added: the owner's standing rule is that no
 * overview or landing page shows a payslip for any role — not the amount and not the month label.
 * Payslips stay one click away, in `pages`.
 *
 * EVERY FIELD IS NULLABLE AND MEANS "this source did not answer", never zero. A zero here would
 * read as "you have no leave left" or "you were never at work this month".
 */
export type HrPersonalRecord = {
  /** This month's fingerprint record. Null when the attendance source did not answer. */
  attendance: { exceptions: number; monthLabel: string; recordedDays: number } | null;
  /** This month's excuse allowance. Null when the excuse source did not answer. */
  excuses: { allowance: number; pending: number; remaining: number; used: number } | null;
  /** Annual leave, recomputed live (never a stored snapshot). Null when it did not answer. */
  leave: { balanceDays: number; entitlementDays: number; usedDays: number } | null;
  /**
   * Her own personal pages, already in the /hr namespace. Resolved with the SAME function the
   * workspace tab strip uses, which mirrors each page's own guard verbatim — so this list can
   * never offer a page the guard would then bounce her off.
   */
  pages: { href: string; label: string }[];
  /** Her own excuse requests, newest first. Null when the source did not answer. */
  requests:
    | { date: string; durationHours: number; id: string; status: string; type: string }[]
    | null;
};

export type HrCommandCenterData = {
  groups: HrCommandGroup[];
  /** The viewer's own record — the merged half of this page. Never another employee's. */
  personal: HrPersonalRecord;
  seat: HrBundleName;
  /**
   * The seat's actual work, as named rows. The tiles below answer "how many"; this answers "which"
   * — see src/lib/hr/today-tasks.ts for why a landing page needs the second question answered.
   */
  tasks: HrTask[];
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
  people_records: ["contracts", "directory", "resignations"],
  performance_probation: ["probation"],
  // `directory` is a REAL recruiting dependency, declared here rather than left to luck. The
  // recruiting tiles and tasks compare open requisitions against open organogram SEATS, and until
  // 2026-09-01 that comparison worked only because the one seat holding `recruiting` also holds
  // `workforce_insight`, which loads the directory for its own reasons. Move recruiting into a
  // bundle without it and the comparison would silently stop happening — no error, just the
  // "Open Vacancies 3" answer coming back.
  recruiting: ["directory", "recruitment", "offers"],
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
    // "Open Vacancies" until 2026-09-01, when the owner asked how it could possibly read 3. It
    // was counting ATS REQUISITIONS, which is a true number and the wrong word: production held
    // exactly 5 requisitions ever, and all 3 in an open status pointed at seats already FILLED,
    // while 45 seats stood genuinely empty in the organogram with no requisition against any of
    // them. So the label now says what it counts, and the tile beside it carries the number the
    // word "vacancy" made anyone expect. Both come from one helper (`splitVacanciesByRequisition`)
    // that the task list also calls, so the two cannot drift apart again.
    const tiles = [
      tile("open-requisitions", "Open Requisitions", dashboard.summary.openRequisitions, "raised in the ATS", "/hr/recruitment", dashboard.summary.openRequisitions > 0 ? "amber" : "slate"),
      tile("in-screening", "In Screening", screening, "awaiting your review", "/hr/recruitment", screening > 0 ? "amber" : "slate"),
      tile("interviewing", "Interviewing", interviewing, "scheduled or in progress", "/hr/recruitment"),
      tile("active-applications", "Active Candidates", dashboard.summary.activeApplications, "still in the pipeline", "/hr/cv-database"),
      tile("hired", "Hired", dashboard.summary.hires, "converted to employees", "/hr/recruitment", dashboard.summary.hires > 0 ? "emerald" : "slate"),
    ];
    // The seat side of the same question. Absent rather than zero when the directory did not
    // load: printing 0 there would say "every empty seat is being recruited", which is the exact
    // false all-clear this pair of tiles exists to stop.
    if (loaded.directory) {
      const { staleRequisitions, unrecruitedSeats } = splitVacanciesByRequisition(
        dashboard.requisitions,
        openWorkforceSeats(loaded.directory),
      );
      tiles.splice(
        1,
        0,
        tile("seats-unrecruited", "Seats Not Recruited", unrecruitedSeats.length, "no requisition raised", "/hr/reports/vacancies", unrecruitedSeats.length > 0 ? "rose" : "emerald"),
        tile("requisitions-stale", "On A Filled Seat", staleRequisitions.length, "requisition still open", "/hr/recruitment", staleRequisitions.length > 0 ? "amber" : "emerald"),
      );
    }

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
    // TWO separate inflations had to come out of this one tile, both measured 2026-09-01.
    //
    // First: `workforceVacancies` is EVERY open seat while `medicalRepVacancies` is the
    // medical-rep SUBSET of that same list (vacancy-closer.ts: one calls getOpenVacancies(), the
    // other filters it). Adding them counted all 43 medical-rep seats twice and printed 88.
    //
    // Second: the raw list is one row per vacancy EVENT, not per seat, so even a single read of
    // it prints 45 where the Organogram, the Vacancy Report, the CEO landing and the Admin Data
    // Health card all print 33 — this tile LINKS to /hr/reports/vacancies, so the two numbers sit
    // one click apart. `listUnoccupiedWorkforceSeats` is the one place that dedup rule lives.
    // Only ACTIVE employees may mark a seat filled: a resigned person's seat is still vacant.
    const openSeats = openWorkforceSeats(directory).length;
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
      // /hr/employee-360, NOT /hr/organogram — this figure is about employee RECORDS. A missing
      // manager here is a field to fill in on a personnel file, not a seat to move on the chart,
      // and the fix is made on the 360 screen. The second half of this note used to be that no
      // function in her bundle granted `organogram` at all; that stopped being true on 2026-08-30,
      // when people_records gained organogram:read on the owner's instruction. The destination is
      // unchanged and the reason is now the only reason: she can open the chart, and it is still
      // not where this number gets fixed.
      tile("no-manager", "No Manager Set", directory.summary.employeesWithoutManagers, "records to complete", "/hr/employee-360", directory.summary.employeesWithoutManagers > 0 ? "amber" : "emerald"),
    ];
    if (loaded.resignations) {
      const summary = loaded.resignations.summary;
      tiles.push(
        tile("resignations-open", "Resignations In Flight", summary.pending + summary.approved, "not yet completed", "/hr/resignations", summary.pending > 0 ? "amber" : "slate"),
      );
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
 * The house chart palette, as the analytics dashboards already use it. Orange is the accent this
 * whole admin shell is built on; slate is the settled/decided counterpart; rose and emerald are the
 * same alarm and all-clear the tiles and tasks use, so a red bar and a red tile mean one thing.
 */
const CHART_COLORS = {
  decided: "#CBD5E1",
  good: "#10B981",
  overdue: "#F43F5E",
  primary: "#F97316",
  secondary: "#0F172A",
} as const;

/**
 * Axis labels for the deduction categories, in the owner's vocabulary rather than the column's.
 *
 * A `Record<DeductionsCategory, string>` so adding a category to `deductionsCategories` is a type
 * error here rather than a blank axis label. That type check is NOT the guard, though — this repo
 * builds with `ignoreBuildErrors`, so a missing key would compile, build and deploy. The real guard
 * is a runtime assertion over `deductionsCategories` in tests/hr-command-center.test.ts.
 */
export const DEDUCTION_CATEGORY_LABELS: Record<DeductionsCategory, string> = {
  crm: "CRM",
  fingerprint: "Fingerprint",
  insufficient_balance_vacation: "Insufficient balance",
  loan: "Loan",
  no_records_activity: "No records activity",
  other: "Other",
  unpaid_vacation: "Unpaid vacation",
};

// "Is there anything to plot?" is deliberately NOT decided here. It is a rendering question — plot
// versus `emptyLabel` — and it is answered in hr-command-charts.tsx. It cannot be a shared helper
// in this file either way: this module imports the Supabase services, so a client component may
// only ever `import type` from it, never a value.

/**
 * The last `count` days, oldest first, as `{ iso, label }`.
 *
 * Anchored on the Cairo calendar date rather than on `new Date()` so the axis a Cairo reader sees
 * ends on the day she is actually having. Stepped in UTC from a midnight-anchored instant, which is
 * the arithmetic that cannot drift: adding 86.4e6 ms to a `T00:00:00Z` date is exact, where adding
 * a day to a local-time instant is not across a DST boundary.
 */
function recentCairoDays(count: number): { iso: string; label: string }[] {
  const today = Date.parse(`${currentCairoDateOnlyIso()}T00:00:00Z`);
  const format = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
  const days: { iso: string; label: string }[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const at = new Date(today - back * 86_400_000);
    days.push({ iso: at.toISOString().slice(0, 10), label: format.format(at) });
  }
  return days;
}

/**
 * `count` months starting at the Cairo current month and running FORWARD, as `{ key, label }`
 * where `key` is `YYYY-MM`. Used by the forward-looking workload charts (renewals, probation).
 */
function upcomingCairoMonths(count: number): { key: string; label: string }[] {
  const { month, year } = currentCairoDateParts();
  const format = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC", year: "2-digit" });
  const months: { key: string; label: string }[] = [];
  for (let ahead = 0; ahead < count; ahead += 1) {
    // Month is 1-based here and 0-based in Date; the +ahead rolls the year over on its own.
    const at = new Date(Date.UTC(year, month - 1 + ahead, 1));
    months.push({ key: at.toISOString().slice(0, 7), label: format.format(at) });
  }
  return months;
}

/** The same, running BACKWARD and ending on the current month. Used by the movement charts. */
function recentCairoMonths(count: number): { key: string; label: string }[] {
  const { month, year } = currentCairoDateParts();
  const format = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC", year: "2-digit" });
  const months: { key: string; label: string }[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const at = new Date(Date.UTC(year, month - 1 - back, 1));
    months.push({ key: at.toISOString().slice(0, 7), label: format.format(at) });
  }
  return months;
}

/**
 * The charts each function contributes. Same contract as TILES_BY_FUNCTION: keyed by function,
 * read through the seat's own bundle, and returning an empty array when the source did not load.
 *
 * FOUR OF THE EIGHT FUNCTIONS RETURN NOTHING, and each is a decision rather than a gap:
 *
 *   `hr_governance`     — no source at all (SOURCES_BY_FUNCTION.hr_governance is empty).
 *   `engagement_retention` — its two sources are small queues, not populations. A bar chart over
 *                         four support requests is a tile with extra ink.
 *   `workforce_insight` — its one source is the directory, and `people_records` already plots the
 *                         directory's only honest shape (joiners and leavers). A seat holding both
 *                         would be shown the same chart twice under two headings.
 *   `recruiting`        — the pipeline-by-stage chart belongs here and is the one gap worth
 *                         filling next; it is left out today rather than guessed at, because the
 *                         stage vocabulary lives in applicationStageLabels and deserves its own
 *                         pass rather than a five-minute mapping.
 *
 * Do not "complete the set" by inventing one. A chart of a single number, or of a population of
 * four, is the ambitious-but-empty dashboard the owner rejected in the first place.
 */
const CHARTS_BY_FUNCTION: Record<
  HrFunctionKey,
  (loaded: HrCommandSources) => HrCommandChart[]
> = {
  engagement_retention: () => [],
  hr_governance: () => [],

  /**
   * This month's detections, by category, split into what a publish would actually take and what
   * is still awaiting a decision.
   *
   * This is the one chart that earns its place by making a NUMBER READABLE rather than by showing
   * a trend: the two tiles beside it collapse seven categories into two totals, and "Awaiting
   * Decision 31" says nothing about whether that is thirty-one fingerprint days or thirty-one
   * unpaid vacations — which are different conversations with different managers. Seven categories
   * is also exactly the count at which a row of tiles stops being readable and a chart starts.
   *
   * COUNTS, NEVER AMOUNTS. The buckets carry `totalAmount` and it is deliberately not plotted: no
   * overview or landing page in this app shows a payroll figure, for any role (owner's standing
   * rule), and money on the landing page is money in a screenshot.
   */
  payroll_inputs: (loaded) => {
    const summary = loaded.deductions;
    if (!summary) return [];
    const series: HrCommandChartSeries[] = [
      { color: CHART_COLORS.primary, key: "pending", name: "Awaiting decision" },
      { color: CHART_COLORS.secondary, key: "ready", name: "Ready to publish" },
    ];
    // Only the categories that actually detected something this month. `no_records_activity` is
    // retired — its connector has no population left (see connectors/no-records-activity.ts) — so
    // plotting the full vocabulary would put a permanently empty column on her landing page every
    // month, which is the dead ink this chart exists to remove. Nothing carrying data is ever
    // dropped, and when NO category has any the chart says so through `emptyLabel` rather than
    // drawing an empty axis.
    const rows = deductionsCategories
      .map((category) => ({
        label: DEDUCTION_CATEGORY_LABELS[category],
        pending: summary.pending[category]?.candidateCount ?? 0,
        ready: summary.willPublish[category]?.candidateCount ?? 0,
      }))
      .filter((row) => row.pending > 0 || row.ready > 0);
    return [
      {
        caption:
          "Detections this month, by category. The dark half is what pressing Publish would take; the orange half is still waiting on somebody's decision and will not be deducted.",
        emptyLabel: "Nothing has been detected this month in any category.",
        href: "/hr/admin/payroll-management",
        hrefLabel: "Open Payroll Management",
        key: "deductions-by-category",
        rows,
        series,
        title: "Deductions this month, by category",
      },
    ];
  },

  /**
   * Two charts, because `people_records` is the function that carries the most tiles by far (ten)
   * and the two questions behind them are different: how the headcount is MOVING, and what is
   * COMING.
   */
  people_records: (loaded) => {
    const charts: HrCommandChart[] = [];

    if (loaded.directory) {
      const months = recentCairoMonths(6);
      const series: HrCommandChartSeries[] = [
        { color: CHART_COLORS.good, key: "joiners", name: "Joined" },
        { color: CHART_COLORS.overdue, key: "leavers", name: "Left" },
      ];
      // `slice(0, 7)` on a date-only column is the month key. Deliberately NOT parsed into a Date
      // first: these are calendar days with no instant, and re-projecting one through a timezone
      // is how a 1 September hire lands in August.
      const rows = months.map((month) => ({
        joiners: loaded.directory!.employees.filter(
          (employee) => (employee.hireDate ?? "").slice(0, 7) === month.key,
        ).length,
        label: month.label,
        leavers: loaded.directory!.employees.filter(
          (employee) => (employee.lastWorkingDate ?? "").slice(0, 7) === month.key,
        ).length,
      }));
      charts.push({
        caption:
          "Everyone whose hire date or last working day falls in each month, counted from the employee records themselves. The current month is still running.",
        emptyLabel: "No hire or leaving date falls in the last six months.",
        href: "/hr/employee-360",
        hrefLabel: "Open Employee 360",
        key: "headcount-movement",
        rows,
        series,
        title: "Joiners and leavers, last 6 months",
      });
    }

    if (loaded.contracts) {
      const months = upcomingCairoMonths(6);
      const series: HrCommandChartSeries[] = [
        { color: CHART_COLORS.primary, key: "due", name: "Renewal due" },
        { color: CHART_COLORS.decided, key: "inFlight", name: "Already in flight" },
      ];
      // A renewal already carrying a live workflow is counted in the SECOND series, not both —
      // otherwise the month's bar would double-count the work that is already under way, which is
      // the opposite of what a workload chart is for.
      const rows = months.map((month) => {
        const inMonth = loaded.contracts!.rows.filter(
          (row) => (row.contract_renewal_date ?? "").slice(0, 7) === month.key,
        );
        const inFlight = inMonth.filter(
          (row) =>
            row.workflow !== null &&
            row.workflow.status !== "renewed" &&
            row.workflow.status !== "not_renewed" &&
            row.workflow.status !== "cancelled",
        ).length;
        return { due: inMonth.length - inFlight, inFlight, label: month.label };
      });
      charts.push({
        caption:
          "What is coming, from each contract's own renewal date. The grey half already has a renewal request moving; the orange half has nobody on it yet.",
        emptyLabel: "No contract comes up for renewal in the next six months.",
        href: "/hr/contracts",
        hrefLabel: "Open Contracts",
        key: "contract-renewals-ahead",
        rows,
        series,
        title: "Contract renewals due, next 6 months",
      });
    }

    return charts;
  },

  /**
   * When the probation windows in flight actually close.
   *
   * The two tiles beside this say how many cases exist and how many need a verdict. Neither says
   * WHEN, and when is the only thing that matters about a probation window: a decision not taken
   * before the end date confirms the employee by default, silently. A seat looking at "Awaiting
   * Decision 7" cannot tell whether that is a comfortable month or four verdicts due this week.
   */
  performance_probation: (loaded) => {
    const rows = loaded.probation;
    if (!rows) return [];
    const series: HrCommandChartSeries[] = [
      { color: CHART_COLORS.overdue, key: "outstanding", name: "Still needs a verdict" },
      { color: CHART_COLORS.decided, key: "decided", name: "Already decided" },
    ];
    // Buckets rather than a day axis: a probation window is weeks long, so a per-day plot would be
    // ninety mostly-empty columns. "Already past" leads because it is the one bucket that is a
    // problem rather than a plan.
    const buckets: { label: string; match: (days: number) => boolean }[] = [
      { label: "Already past", match: (days) => days < 0 },
      { label: "This week", match: (days) => days >= 0 && days <= 7 },
      { label: "Next week", match: (days) => days > 7 && days <= 14 },
      { label: "2-4 weeks", match: (days) => days > 14 && days <= 28 },
      { label: "1-2 months", match: (days) => days > 28 && days <= 60 },
      { label: "Later", match: (days) => days > 60 },
    ];
    const plotted = buckets.map((bucket) => {
      const inBucket = rows.filter((row) => bucket.match(row.days_remaining));
      const outstanding = inBucket.filter((row) => isProbationDecisionOutstanding(row)).length;
      return { decided: inBucket.length - outstanding, label: bucket.label, outstanding };
    });
    return [
      {
        caption:
          "Every probation window in flight, by when it closes. A window that closes with no verdict recorded confirms the employee by default — the red columns are the ones that can still be decided.",
        emptyLabel: "No probation window is open.",
        href: "/hr/probation",
        hrefLabel: "Open Probation",
        key: "probation-windows",
        rows: plotted,
        series,
        title: "Probation windows, by when they close",
      },
    ];
  },

  recruiting: () => [],

  /**
   * The exception queue as a fortnight rather than a number.
   *
   * "Attendance Exceptions 14" cannot distinguish a bad Tuesday from two weeks of steady drift, and
   * those are different problems with different fixes. Plotted by the day the exception was RAISED
   * rather than the day it covers, because this chart is about the arrival rate of her own workload;
   * the day it covers is on the row itself, in "Your day".
   */
  time_attendance: (loaded) => {
    const exceptions = loaded.attendanceExceptions;
    if (!exceptions) return [];
    const series: HrCommandChartSeries[] = [
      { color: CHART_COLORS.primary, key: "pending", name: "Still pending" },
      { color: CHART_COLORS.decided, key: "decided", name: "Decided" },
    ];
    const rows = recentCairoDays(14).map((day) => {
      const raised = exceptions.filter((row) => (row.createdAt ?? "").slice(0, 10) === day.iso);
      const pending = raised.filter((row) => row.status === "pending").length;
      return { decided: raised.length - pending, label: day.label, pending };
    });
    return [
      {
        caption:
          "Exceptions by the day they were raised. Orange is what is still on your desk; grey has been decided. A tall orange run is a rule that needs looking at, not a busy morning.",
        emptyLabel: "No attendance exception has been raised in the last fortnight.",
        href: "/hr/attendance",
        hrefLabel: "Open Attendance",
        key: "attendance-exception-flow",
        rows,
        series,
        title: "Attendance exceptions raised, last 14 days",
      },
    ];
  },

  workforce_insight: () => [],
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

/**
 * The viewer's own employment record.
 *
 * Loaded UNCONDITIONALLY, unlike everything above it, and that asymmetry is the point. The tile
 * sources are gated on the seat's function bundle because reading them is doing HR work — reading
 * the deductions month under a seat whose job description forbids it would be wrong even though
 * the query would succeed. These three sources are about the person holding the seat, and every
 * employee holds one of these regardless of which functions they were granted. `SourceKey` and
 * `sourcesFor` are therefore deliberately untouched, and `tests/hr-command-center.test.ts` still
 * asserts exactly what it did about them.
 *
 * Each source fails alone and independently of the tiles: a dead attendance table costs the two
 * attendance fields and nothing else on the page.
 */
async function loadPersonalRecord(access: AccessContext): Promise<HrPersonalRecord> {
  const { year, month } = currentCairoDateParts();
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${monthStart}T00:00:00Z`));

  const [excuses, leave, attendance] = await Promise.all([
    getExcuseWorkspace(access).catch(() => null),
    getVacationRequestPageData(access)
      .then((data) => data.balance)
      .catch(() => null),
    access.hrId
      ? getEmployeeAttendanceData(access.hrId, monthStart, currentCairoDateOnlyIso()).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);

  // Her personal pages, minus the one she is already on. `/workspace` used to be a second landing
  // page in its own right; this page IS that page now, so linking to it would send her in a
  // circle. `toHrNamespacePath` because these seats live at /hr/… — a bare /workspace address
  // redirects them straight back here, which would read as a broken link.
  const pages = resolvePersonalWorkspaceTabs(
    access,
    buildPermissionLookup(permissionMatrix, access.role),
  )
    .filter((tab) => tab.href !== "/workspace")
    .map((tab) => ({ href: toHrNamespacePath(tab.href), label: tab.label }));

  return {
    attendance: attendance
      ? {
          exceptions: attendance.rows.filter((row) => row.hasException).length,
          monthLabel,
          recordedDays: attendance.rows.length,
        }
      : null,
    excuses: excuses
      ? {
          allowance: excuses.monthly.allowance,
          pending: excuses.monthly.pending,
          remaining: excuses.monthly.remaining,
          used: excuses.monthly.used,
        }
      : null,
    leave: leave
      ? {
          balanceDays: leave.balanceAfterDays,
          entitlementDays: leave.entitlementDays,
          usedDays: leave.usedPaidDays,
        }
      : null,
    pages,
    requests: excuses
      ? [...excuses.requests]
          .sort((a, b) => b.excuseDate.localeCompare(a.excuseDate))
          .slice(0, 5)
          .map((request) => ({
            date: request.excuseDate,
            durationHours: request.durationHours,
            id: request.id,
            status: request.status,
            type: request.excuseType,
          }))
      : null,
  };
}

export async function getHrCommandCenterData(
  access: AccessContext,
): Promise<HrCommandCenterData | null> {
  const seat = hrBundleForRole(access.role);
  if (!seat) return null;

  const needed = new Set(sourcesFor(seat));
  const failures: SourceKey[] = [];
  const loaded: HrCommandSources = {};

  // Her own record starts loading HERE, beside the tile sources rather than after them, so the
  // merged page costs the same wall-clock as the two separate pages did — the slowest source, not
  // the sum. It is awaited below.
  const personalPromise = loadPersonalRecord(access);

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
    personal: await personalPromise,
    seat,
    tasks: buildHrTodayTasks(loaded),
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
 *
 * THE TILE BUILDER STILL GOVERNS WHETHER THE GROUP EXISTS, and charts ride along inside it. That
 * asymmetry is deliberate: a chart is a second reading of a source the tiles already report, so a
 * function that contributes no tiles has nothing for a chart to be a second reading OF. Letting a
 * chart resurrect a group whose tiles were dropped would put a plot on the page for a source the
 * builder just decided it could not read — the misleading-zero trap, drawn rather than printed.
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
      charts: CHARTS_BY_FUNCTION[functionKey](loaded),
      functionKey,
      label: definition.label,
      summary: definition.summary,
      tiles,
    });
  }
  return groups;
}
