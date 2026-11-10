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
import { countHiresInWindow, countStartingAfter } from "@/lib/employees/hires-in-window";
import { getExcuseWorkspace } from "@/lib/excuses/service";
import { loadHrOpsReportsQueue } from "@/lib/hr-ops-reports/queue";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import { hrefOutsideSeatFence } from "@/lib/auth/seat-page-fences";
import { toHrNamespacePath } from "@/lib/navigation/shell-headers";
import { listOffers } from "@/lib/offers/service";
import { fenceHrDashboardSources } from "@/lib/recruitment/workspace/fence";
import { HR_WORKSPACE_BASE_PATH, workspaceHref } from "@/lib/recruitment/workspace/links";
import type { OfferStatus } from "@/lib/offers/types";
import { getProbationOutcomesAnalytics } from "@/lib/probation/intelligence/outcomes-analytics";
import {
  canViewProbationAnalytics,
  getProbationRows,
  isProbationDecisionOutstanding,
} from "@/lib/probation/service";
import {
  getRecruitmentDashboard,
  resolveHiredWindow,
  type HiredWindow,
} from "@/lib/recruitment/dashboard";
import type { CandidateStatus } from "@/lib/recruitment/candidate-status";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { getRetentionDashboardData } from "@/lib/retention/service";
import { listAllSupportRequests } from "@/lib/support-requests/service";
import { availableBalanceAfterPending } from "@/lib/vacation/calculations";
import { listOnVacationToday, type OnVacationTodayRow } from "@/lib/vacation/on-vacation-today";
import { getVacationRequestPageData } from "@/lib/vacation/service";
import { resolvePersonalWorkspaceTabs } from "@/lib/workspace/personal-workspace-nav";
import {
  buildHrTodayTasks,
  ITEM_PREVIEW_LIMIT,
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
  /**
   * Rendered in the figure's place when the fact is NOT a count.
   *
   * Exactly one tile needs this and it needs it badly: "Payroll Month" printed
   * `Number(monthKey.slice(5))`, so HR Operations' board carried a tile reading **9** in the same
   * 30px black type as a queue depth. Nine what? It is September — a name written as a code, on a
   * page whose every other figure is a countable thing, and the owner's standing rule is that a
   * screen shows human-readable names and never raw codes.
   *
   * `value` is still populated, so anything that sorts or sums tiles keeps working; this only
   * changes what is DRAWN. Reach for it when a tile's fact has no unit — never to dress a real
   * count up as prose.
   */
  valueLabel?: string;
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
  /**
   * Who is on an approved vacation TODAY, as named people (owner, 2026-09-29: "make on her landing
   * page appear on a vacation today").
   *
   * `null`, NEVER an empty array, when the seat did not load the source — either because its bundle
   * does not justify it (HR Advisory holds no `time_attendance`) or because the read failed, in
   * which case `unavailableSources` names it. An empty ARRAY means the source answered and nobody is
   * off, which the panel says in words. The two must stay distinguishable: `[]` standing in for a
   * failed read is the misleading zero this page's rules forbid — it would read as "everybody is at
   * work today" on a morning when the query was broken.
   */
  onVacationToday: OnVacationTodayRow[] | null;
  /**
   * The window the Hired tile was counted over — the running Cairo month unless the viewer picked
   * a range. Carried on the data rather than re-derived in the component, so the picker's boxes,
   * the tile's caption and the figure itself can never name three different periods.
   */
  hiredWindow: HiredWindow;
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

/**
 * The raw fetches. One per underlying service, so two functions wanting the same data share it.
 *
 * Exported since 2026-10-13 because the Talent Acquisition seat's own landing page
 * (src/lib/hr/talent-acquisition-overview.ts) loads its sources through `sourcesFor` rather than
 * through a second hand-kept list — which is the whole guarantee at the top of this file, and the
 * one thing a bespoke page must not quietly opt out of.
 */
export type SourceKey =
  | "attendanceExceptions"
  | "contracts"
  | "deductions"
  | "directory"
  | "hrOpsReports"
  | "offers"
  | "probation"
  | "probationOutcomes"
  | "recruitment"
  | "resignations"
  | "retention"
  | "supportRequests"
  | "vacationsToday";

/**
 * Which raw fetches each function needs. The union across a seat's bundle is all this module is
 * allowed to load — see the header. `directory` appearing twice is the point: HR Operations holds
 * both `people_records` and (via nothing) no second copy of it, and the fetch still happens once.
 */
const SOURCES_BY_FUNCTION: Record<HrFunctionKey, readonly SourceKey[]> = {
  // NONE, deliberately, and this one is a PRIVACY decision rather than a "nothing to count" one.
  // `cv_lookup` (owner, 2026-09-30) grants a search box over the CV database and nothing else: the
  // seat holding it may reach a candidate she searched FOR, and may not have the pool. A tile
  // saying "1,260 CVs on file", or any figure at all derived from candidates, would hand her the
  // size and shape of the thing the grant exists to withhold — on her landing page, before she has
  // searched for anybody. `recruitment` is deliberately absent from this list for that reason.
  cv_lookup: [],
  engagement_retention: ["supportRequests", "retention"],
  // NONE, deliberately. `hr_governance` grants employee_documents:read/export and overview:read
  // and nothing else — neither is a queue, and there is no figure in the product that counts
  // "governance". A tile here could only be invented, and an invented tile is the false promise
  // the owner's rule for this page type forbids. See TILES_BY_FUNCTION.hr_governance.
  // NONE. hr_communication is a CAPABILITY - compose and send HR mail by hand - not a data
  // source, so it contributes no tile and no chart. The dashboard reports work waiting; a send
  // path has no backlog to show.
  hr_communication: [],
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
  // `vacationsToday` belongs HERE and nowhere else. The "on a vacation today" panel names the
  // people an absence has taken out of today's work, and attendance and leave administration is
  // this function's own JD line — it is the same grant (`leave`) the Vacation Report the panel
  // links to opens on. Declaring it on the function rather than on the seat is what stops a seat
  // without that grant being shown the company's absences: HR Advisory holds no `time_attendance`,
  // so `sourcesFor` never asks for it on her behalf and the panel never renders for her.
  //
  // Her seat name is deliberately NOT written as a string literal above. Rule 10 of
  // `tests/hr-function-governance.test.ts` pins every file that contains one, because such a string
  // is usually a gate the permission matrix cannot see — and this file's gate is the function bundle
  // itself, so listing it there would dilute a tripwire whose whole value is that each entry is a
  // real by-name grant.
  time_attendance: ["attendanceExceptions", "vacationsToday"],
  workforce_insight: ["directory"],
  // The Talent Acquisition seat's three non-recruiting functions (2026-10-08). The support desk is
  // the one queue among them; documents and context reading have no backlog to show.
  hiring_paperwork: [],
  hiring_desk: [],
  // Names who is off today on her page; the row carries a leave type and dates, never an amount.
  hr_calendars: ["vacationsToday"],
  // Who to add or remove is on the module's own page; this dashboard counts no queue for it.
  medical_insurance_members: [],
  employee_requests: ["supportRequests"],
  /**
   * TWO sources since 2026-10-13, and both are for the Talent Acquisition seat's OWN overview page
   * (src/lib/hr/talent-acquisition-overview.ts) — the one the owner asked to be rebuilt from
   * scratch that morning. This function still contributes no tile and no chart to the generic page
   * below, and that stays a decision rather than an omission (see TILES_BY_FUNCTION).
   *
   *   `probationOutcomes` — her handbook's "probation retention" KPI. The function grants
   *       `probation: READ_ONLY`, and `canReadAllProbation` names her seat by name, so both the
   *       Decision Dashboard and the Outcomes analytics are hers to open; this is the aggregate
   *       those pages already show, not a second calculation.
   *   `vacationsToday`    — the "on a vacation today" panel the owner put on the HR landing page on
   *       2026-09-29. Reading the company's calendars and boards is this function's own JD line.
   *
   * Declared on the FUNCTION and not on the page, for the reason in this file's header: a page that
   * fetched a source no function in the seat's bundle asked for would be doing work, under her
   * session, that the permission catalogue never granted. No other seat holds `workforce_context`,
   * so nothing else anywhere moves.
   */
  workforce_context: ["probationOutcomes", "vacationsToday"],
  // Recognition is two pages to open and print from, not a queue: it loads nothing.
  recognition: [],
  // HR Reminders is the team's own notes page, not a backlog: it loads nothing here.
  team_reminders: [],
  // The HR Operations Specialist seat's two functions (2026-10-20).
  //
  // `attendance_review` reads her Daily & Weekly Reports queue: report titles and row COUNTS, never
  // a row and never a day total, so nothing on her landing page is a figure about money.
  //
  // `people_master` reads the same three sources `people_records` does — it is the same personnel
  // work with every salary withheld — and only for COUNTS: the directory rows hold a base salary on
  // the server, and no tile, chart or task below lets one out (each carries a count, a name, a job
  // title or an area). Every link it draws goes to a page her seat opens and that is itself
  // salary-blind for her — the Employee Directory, Contract Renewal, Resignations — never Employee
  // 360, which shows pay and is fenced off her seat (src/lib/auth/seat-page-fences.ts).
  attendance_review: ["hrOpsReports"],
  people_master: ["contracts", "directory", "resignations"],
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
  hrOpsReports: Awaited<ReturnType<typeof loadHrOpsReportsQueue>>;
  offers: Awaited<ReturnType<typeof listOffers>>;
  probation: Awaited<ReturnType<typeof getProbationRows>>;
  probationOutcomes: Awaited<ReturnType<typeof getProbationOutcomesAnalytics>>;
  recruitment: Awaited<ReturnType<typeof getRecruitmentDashboard>>;
  resignations: Awaited<ReturnType<typeof getResignationsDashboardData>>;
  retention: Awaited<ReturnType<typeof getRetentionDashboardData>>;
  supportRequests: Awaited<ReturnType<typeof listAllSupportRequests>>;
  vacationsToday: Awaited<ReturnType<typeof listOnVacationToday>>;
}>;

/**
 * The Hired tile's caption — the WINDOW, named.
 *
 * `HrCommandTile.sub` is a 10px uppercase caption and never a sentence, so this stays as short as
 * it can while still being unambiguous: a window that is exactly one calendar month reads
 * "hired in September", anything else reads "hired 11 Sep – 22 Sep". The point is that the figure
 * can never be mistaken for a lifetime total again, which is what "converted to employees" left
 * it open to.
 */
function hiredWindowCaption(window: HiredWindow): string {
  return `hired ${describeWindow(window)}`;
}

/** The window as a phrase that follows a verb: "in October" for a whole month, else "11 Sep – 22 Sep". */
export function describeWindow(window: HiredWindow): string {
  const day = (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(`${iso}T00:00:00Z`),
    );

  const [fromYear, fromMonth, fromDay] = window.fromIso.split("-");
  const [toYear, toMonth] = window.toIso.split("-");
  const lastDayOfFromMonth = new Date(Date.UTC(Number(fromYear), Number(fromMonth), 0)).getUTCDate();
  const isWholeMonth =
    fromYear === toYear &&
    fromMonth === toMonth &&
    fromDay === "01" &&
    window.toIso.endsWith(String(lastDayOfFromMonth).padStart(2, "0"));

  if (isWholeMonth) {
    const name = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(
      new Date(`${window.fromIso}T00:00:00Z`),
    );
    return `in ${name}`;
  }
  return `${day(window.fromIso)} – ${day(window.toIso)}`;
}

/**
 * The Hired tile, as a list of zero or one: people the Employee Master says were hired inside the
 * window. Zero when the directory did not load (the page already names it as unavailable) — a
 * missing source is never drawn as "0 hired".
 *
 * Someone hired in the window who has not started yet is still a hire, and the caption says how many
 * start later, because "hired in October 20" read on the 14th otherwise claims 20 people at work.
 */
function hiredTile(loaded: HrCommandSources, window: HiredWindow): HrCommandTile[] {
  if (!loaded.directory) return [];
  const { hired, startLater } = countHiresInWindow(
    loaded.directory.employees,
    window,
    currentCairoDateOnlyIso(),
  );
  const caption = `${hiredWindowCaption(window)}${startLater > 0 ? ` · ${startLater} start later` : ""}`;
  return [tile("hired", "Hired", hired, caption, "/hr/recruitment", hired > 0 ? "emerald" : "slate")];
}

/** `YYYY-MM` for the running month in Cairo — the owner reports every time in Cairo, never UTC. */
function currentCairoMonthKey(): string {
  const { year, month } = currentCairoDateParts();
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** "September" for the running Cairo month. See `HrCommandTile.valueLabel` for why. */
function currentCairoMonthLabel(): string {
  const { year, month } = currentCairoDateParts();
  return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(
    new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00Z`),
  );
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


/** The offer statuses in the order an offer moves through them, in the owner's words. */
const OFFER_STATUS_ORDER: ReadonlyArray<{ label: string; status: OfferStatus }> = [
  { label: "Draft", status: "draft" },
  { label: "Awaiting HR Manager approval", status: "pending_approval" },
  { label: "Sent, awaiting reply", status: "sent" },
  { label: "Accepted", status: "accepted" },
  { label: "Declined", status: "declined" },
  { label: "Withdrawn", status: "withdrawn" },
];

/**
 * Every job offer on record, by where it stands — the end of the pipeline the chart beside it
 * stops short of. Added 2026-10-08 with the Talent Acquisition seat, whose job includes building
 * offers; it belongs to the recruiting function, so the seat that holds recruiting sees it.
 */
/**
 * The key `offersByStatusChart` emits.
 *
 * Named because the Talent Acquisition seat's overview page moves this ONE chart out of the
 * recruiting band and up beside the offer-conversion KPIs it explains, and it has to find it in the
 * list the recruiting builder returns. Matching on the key rather than on the title is the point: a
 * reworded title would silently leave the chart drawn twice, or not at all.
 */
export const OFFERS_BY_STATUS_CHART_KEY = "offers-by-status";

export function offersByStatusChart(offers: NonNullable<HrCommandSources["offers"]>): HrCommandChart {
  return {
    caption:
      "Every offer letter on record, by where it stands — letters, not people, so a letter re-issued to the same person counts again. A letter still awaiting a reply is a candidate still deciding; a long Declined column is a package worth looking at.",
    emptyLabel: "No job offer has been drafted yet.",
    href: "/hr/offers",
    hrefLabel: "Open Job Offers",
    key: OFFERS_BY_STATUS_CHART_KEY,
    rows: OFFER_STATUS_ORDER.map(({ label, status }) => ({
      label,
      offers: offers.filter((offer) => offer.status === status).length,
    })),
    series: [{ color: CHART_COLORS.primary, key: "offers", name: "Offers" }],
    title: "Job offers, by status",
  };
}

/** The HR support desk's queue, shared by the two functions that work it. Null when it did not load. */
function supportRequestTiles(loaded: HrCommandSources): HrCommandTile[] | null {
  const rows = loaded.supportRequests;
  if (!rows) return null;
  const open = rows.filter((row) => row.status === "Pending" || row.status === "In Progress");
  const untouched = rows.filter((row) => row.status === "Pending");
  const oldest = untouched.reduce((max, row) => Math.max(max, daysSince(row.createdAt)), 0);
  return [
    tile("support-open", "Open Requests", open.length, "employees waiting", "/hr/admin/support-requests", queueTone(open.length, oldest)),
    tile("support-untouched", "Not Yet Started", untouched.length, "still unanswered", "/hr/admin/support-requests", queueTone(untouched.length, oldest)),
    tile("support-oldest", "Longest Wait", oldest, oldest === 1 ? "day" : "days", "/hr/admin/support-requests", oldest >= 5 ? "rose" : oldest > 0 ? "amber" : "emerald"),
  ];
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
    // 🔴 THE CANDIDATE TILES COUNT THE CANDIDATE POOL, NOT THE APPLICATIONS (owner, 2026-10-14:
    // "extremely wrong data"). The pool is where recruiters work — 1,417 candidates on 2026-10-14,
    // 898 of them live — while the applications half held 38 rows, every one of them also in the
    // pool. "Active Candidates" read 30 against a pipeline of 898.
    const pool = dashboard.summary.candidatePool;
    const live = pool.new + pool.shortlisted + pool.backup + pool.sent_to_manager;
    // "Open Vacancies" until 2026-09-01, when the owner asked how it could possibly read 3. It
    // was counting ATS REQUISITIONS, which is a true number and the wrong word: production held
    // exactly 5 requisitions ever, and all 3 in an open status pointed at seats already FILLED,
    // while 45 seats stood genuinely empty in the organogram with no requisition against any of
    // them. So the label now says what it counts, and the tile beside it carries the number the
    // word "vacancy" made anyone expect. Both come from one helper (`splitVacanciesByRequisition`)
    // that the task list also calls, so the two cannot drift apart again.
    const tiles = [
      tile("open-requisitions", "Open Requisitions", dashboard.summary.openRequisitions, "raised in the ATS", "/hr/recruitment", dashboard.summary.openRequisitions > 0 ? "amber" : "slate"),
      // Each candidate tile opens the workspace on the pile it counts (the requisition tiles keep the
      // workspace root: requisitions have no tab there).
      tile("awaiting-review", "Awaiting Review", pool.new, "CVs with no decision yet", workspaceHref({ statuses: ["new"] }, { basePath: HR_WORKSPACE_BASE_PATH }), pool.new > 0 ? "amber" : "slate"),
      tile("with-managers", "With Hiring Managers", pool.sent_to_manager, "CVs a manager is reviewing", workspaceHref({ statuses: ["sent_to_manager"] }, { basePath: HR_WORKSPACE_BASE_PATH })),
      tile("active-candidates", "Active Candidates", live, "still in the pipeline", "/hr/cv-database"),
      // A PERIOD, not a lifetime. A lifetime hired total printed beside "Awaiting Review", "With
      // Hiring Managers" and "Active Candidates" — all counts of the pipeline as it stands — reads
      // as "we hired this many recently". It would still read 47 when the last hire was two years ago. The caption names
      // the window so the figure cannot be read as anything else, and the picker above the group
      // changes it. Default is the running Cairo month (owner, 2026-09-22).
      //
      // 🔴 COUNTED ON THE EMPLOYEE MASTER, NOT ON THE APPLICATIONS (owner, 2026-10-14: "extremely wrong
      // data"). `summary.hiresInWindow` counts applications that reached the hired stage, and that
      // half of the ATS is nearly unused — it read 0 for October while 20 people had been hired. A
      // hire becomes a fact when an employee row carries a hire date, so that is what is counted;
      // `summary.hiresInWindow` stays on the dashboard for the funnel that wants the pipeline's
      // own number. With no directory the tile is ABSENT, never a pipeline figure standing in for it.
      ...hiredTile(loaded, dashboard.summary.hiredWindow),
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
    const tiles = supportRequestTiles(loaded);
    if (!tiles) return null;
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
    // tiles report the month; the decisions behind them are not hers to take. The counts come from
    // the unified module (getCompanyMonthSummaryByCategory).
    //
    // All three drill down to Payroll Management, a module page this seat can open — measured
    // 2026-09-05, it renders three cards for her. That was a CONSTRAINT until 2026-09-03 and is a
    // CHOICE now, which is worth writing down because the old wording read as the former: it said
    // the unified /admin/deductions was "gated to Super Admin / CEO", true at the C6 cutover
    // (2026-08-30) and reversed three days later when the owner said "yes give HR access to the
    // deductions screen". The page names HR Operations, and since 2026-09-05 Deductions is a row on
    // her own rail. So these three could point straight at the screen holding their figure; leaving
    // them one hop away is now a decision about her dashboard, not something the permissions force.
    const pendingCandidates = Object.values(summary.pending).reduce((total, bucket) => total + bucket.candidateCount, 0);
    const willPublishCandidates = Object.values(summary.willPublish).reduce((total, bucket) => total + bucket.candidateCount, 0);
    return [
      tile("deductions-pending", "Awaiting Decision", pendingCandidates, "this month", "/hr/admin/payroll-management", pendingCandidates > 0 ? "amber" : "emerald"),
      tile("deductions-ready", "Ready To Publish", willPublishCandidates, "this month", "/hr/admin/payroll-management"),
      // The month is the one fact on this page with no unit, so it is the one tile that draws a
      // NAME. `value` still holds the month number for anything that reads tiles numerically.
      {
        ...tile("payroll-month", "Payroll Month", Number(currentCairoMonthKey().slice(5)), "running period", "/hr/admin/payroll-management"),
        valueLabel: currentCairoMonthLabel(),
      },
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
  hr_communication: () => [],
  hr_governance: () => [],
  // The Talent Acquisition seat's support desk: the same three tiles engagement_retention opens
  // with, without the retention half she was not given. No seat holds both functions, so the tiles
  // never print twice.
  employee_requests: (loaded) => supportRequestTiles(loaded),
  // NONE, for the reason hr_governance has none: documents and a login switch are not a queue.
  hiring_paperwork: () => [],
  hiring_desk: () => [],
  hr_calendars: () => [],
  medical_insurance_members: () => [],
  // NONE. Reading the chart, the calendars and the boards is context for her recruiting, not a
  // backlog — a tile here could only be invented.
  workforce_context: () => [],
  // NONE. Spotlight and Milestones are sheets she prints, not a backlog.
  recognition: () => [],
  // NONE. The reminders page is the team's own notes, not a queue this dashboard counts.
  team_reminders: () => [],
  // The HR Operations Specialist's review queue (2026-10-20). Counts of reports and rows, all on
  // her own Daily & Weekly Reports page; the days a row carries are never summed here.
  attendance_review: (loaded) => {
    const queue = loaded.hrOpsReports;
    if (!queue) return null;
    const { inReview, rowsToAnswer, submitted } = queue.summary;
    return [
      tile("hr-reports-to-review", "Reports To Review", inReview, "still with you", "/hr/hr-reports", inReview > 0 ? "amber" : "emerald"),
      tile("hr-reports-rows", "Rows To Answer", rowsToAnswer, "flagged, no answer yet", "/hr/hr-reports", rowsToAnswer > 0 ? "amber" : "emerald"),
      tile("hr-reports-submitted", "With The HR Manager", submitted, "waiting on the HR Manager's decision", "/hr/hr-reports"),
    ];
  },
  // The people_records tiles with every link pointed at a page this seat opens (SOURCES_BY_FUNCTION).
  people_master: (loaded) => {
    const directory = loaded.directory;
    if (!directory) return null;
    const incomplete = directory.employees.filter(
      (employee) => isActiveDirectoryEmployee(employee) && hasMissingEmployeeRecordData(employee),
    ).length;
    const tiles = [
      tile("headcount", "Active Headcount", directory.summary.activeEmployees, "active employees", "/hr/employees", "emerald"),
      tile("incomplete-records", "Incomplete Records", incomplete, "missing required data", "/hr/employees", incomplete > 0 ? "amber" : "emerald"),
      tile("no-manager", "No Manager Set", directory.summary.employeesWithoutManagers, "records to complete", "/hr/employees", directory.summary.employeesWithoutManagers > 0 ? "amber" : "emerald"),
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
  // NONE, and for `cv_lookup` this is the privacy decision recorded in SOURCES_BY_FUNCTION rather
  // than "nothing to count": any figure counting candidates would put the size of the pool on the
  // landing page of the one seat the pool is withheld from. Returning an empty array drops the group
  // entirely (buildGroups skips a function with no tiles), which is the honest outcome — the module
  // is a search box, and a search box has no backlog.
  cv_lookup: () => [],
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
  crm_half_day: "Half day (CRM)",
  field_review: "Field day (reviewed)",
  fingerprint: "Fingerprint",
  insufficient_balance_vacation: "Insufficient balance",
  loan: "Loan",
  no_records_activity: "No records activity",
  no_weekly_plan: "No weekly plan",
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
 * The live candidate pipeline, one bar per pile of the candidate pool, in the order a CV moves through
 * them — the chart "Live candidates, by pipeline stage" and the "Active Candidates" tile beside it
 * both count THESE piles, so the columns add up to the tile.
 *
 * WHY THE CANDIDATE POOL AND NOT THE APPLICATIONS (owner, 2026-10-14: "extremely wrong data"). The
 * applications half of the ATS holds a few dozen rows, every one of which is also in the pool; the
 * pool is where recruiters decide, and it held 898 live candidates against 30 live applications. The
 * chart used to plot the 30.
 *
 * REJECTED AND HIRED ARE ABSENT BY DESIGN: they are finished, and a funnel that counted them would
 * measure history rather than workload. EXHAUSTIVE, AND CHECKED AT RUNTIME — every status in
 * `candidateStatuses` appears here or in `CANDIDATE_FUNNEL_FINISHED`, asserted in
 * tests/hr-command-center.test.ts, because `ignoreBuildErrors` is on in next.config and a status added
 * to the vocabulary and put nowhere would compile, build and DEPLOY with its candidates invisible.
 */
export const CANDIDATE_FUNNEL_BARS: readonly { label: string; status: CandidateStatus }[] = [
  { label: "Awaiting review", status: "new" },
  { label: "Shortlisted", status: "shortlisted" },
  { label: "Backup", status: "backup" },
  { label: "With a manager", status: "sent_to_manager" },
];

/** The piles a candidate leaves the funnel for. */
export const CANDIDATE_FUNNEL_FINISHED: readonly CandidateStatus[] = ["rejected", "hired"];

/**
 * The charts each function contributes. Same contract as TILES_BY_FUNCTION: keyed by function,
 * read through the seat's own bundle, and returning an empty array when the source did not load.
 *
 * TWO OF THE EIGHT FUNCTIONS RETURN NOTHING, and both are decisions rather than gaps:
 *
 *   `hr_governance`     — no source at all (SOURCES_BY_FUNCTION.hr_governance is empty). There is
 *                         nothing to plot, so a chart here could only be invented.
 *   `engagement_retention` — its two sources are EMPTY IN PRODUCTION and have never held a row.
 *                         Measured 2026-09-01 against ozucdzovmcqvepbozvqf:
 *                         `employee_support_requests` 0 rows ever, `hr_retention_conversations`
 *                         0 rows ever. A chart here would print its `emptyLabel` on her landing
 *                         page every day until somebody starts using two modules that shipped but
 *                         were never adopted — which is a tile's job, and the three retention
 *                         tiles already do it. Re-measure before adding one: the argument is the
 *                         POPULATION, not the module.
 *
 * `recruiting` and `workforce_insight` stood empty here too until 2026-09-01, and are now filled at
 * the owner's instruction ("add the missing charts"). The note that occupied `workforce_insight`'s
 * place — that `people_records` already plots the directory, so a seat holding both would see one
 * chart twice — was wrong on its own terms: NO SEAT HOLDS BOTH. `people_records` is HR Operations'
 * and `workforce_insight` is HR Advisory's, so what that note actually described was HR Advisory
 * being shown no directory chart at all. She carried exactly one chart before this change.
 *
 * Do not "complete the set" by inventing one. A chart of a single number, or of a population that
 * does not exist, is the ambitious-but-empty dashboard the owner rejected in the first place.
 */
const CHARTS_BY_FUNCTION: Record<
  HrFunctionKey,
  (loaded: HrCommandSources) => HrCommandChart[]
> = {
  // No chart. `cv_lookup` loads no source at all, and the reason is privacy rather than absence —
  // see SOURCES_BY_FUNCTION.cv_lookup. Plotting anything here would mean plotting candidates.
  cv_lookup: () => [],
  engagement_retention: () => [],
  // No chart. A send path has no population to plot - see the note above about not completing the
  // set with a chart of a number that means nothing.
  hr_communication: () => [],
  hr_governance: () => [],
  // No chart for three of the Talent Acquisition seat's functions: none has a population to plot,
  // and none contributes a tile, so none has a group for a chart to sit in.
  hiring_paperwork: () => [],
  hiring_desk: () => [],
  hr_calendars: () => [],
  medical_insurance_members: () => [],
  workforce_context: () => [],
  recognition: () => [],
  team_reminders: () => [],
  /**
   * Her review queue as a shape: the newest reports, oldest first, each split into the flagged rows
   * still waiting for her answer and the rows she has answered. A run of orange is a backlog
   * building; a report that is all grey is one she has finished.
   */
  attendance_review: (loaded) => {
    const queue = loaded.hrOpsReports;
    if (!queue) return [];
    const series: HrCommandChartSeries[] = [
      { color: CHART_COLORS.primary, key: "waiting", name: "Waiting for your answer" },
      { color: CHART_COLORS.decided, key: "answered", name: "Answered" },
    ];
    const rows = [...queue.reports]
      .reverse()
      .map((report) => ({ answered: report.progress.reviewed, label: report.shortLabel, waiting: report.progress.toReview }));
    return [
      {
        caption:
          "Every recent report, oldest first. Orange is a flagged row still waiting for your answer; grey is a row you have answered. The HR Manager decides each one after you submit.",
        emptyLabel: "No report has a flagged row yet. The first report appears the morning after a working day.",
        href: "/hr/hr-reports",
        hrefLabel: "Open Daily & Weekly Reports",
        key: "hr-reports-review",
        rows,
        series,
        title: "Flagged rows in recent reports",
      },
    ];
  },
  /**
   * The people_records charts (joiners and leavers, renewals ahead), linking to the pages this seat
   * opens. Same builder, so the two seats' shapes cannot be counted two ways — only re-pointed.
   */
  people_master: (loaded) =>
    CHARTS_BY_FUNCTION.people_records(loaded).map((chart) =>
      chart.key === "headcount-movement"
        ? { ...chart, href: "/hr/employees", hrefLabel: "Open Employee Directory" }
        : chart,
    ),

  /**
   * The HR support desk as a fortnight rather than three totals — the Talent Acquisition seat's
   * desk (2026-10-08). The tiles beside it say how much is open and how old the oldest is; neither
   * can say whether requests arrive in a steady trickle or in bursts, which is the question staffing
   * the desk turns on. Plotted by the day the request was RAISED, exactly like the attendance
   * exception flow, and from the same loaded rows the tiles count.
   */
  employee_requests: (loaded) => {
    const rows = loaded.supportRequests;
    if (!rows) return [];
    const series: HrCommandChartSeries[] = [
      { color: CHART_COLORS.primary, key: "open", name: "Still open" },
      { color: CHART_COLORS.decided, key: "closed", name: "Resolved or closed" },
    ];
    const chartRows = recentCairoDays(14).map((day) => {
      const raised = rows.filter((row) => (row.createdAt ?? "").slice(0, 10) === day.iso);
      const open = raised.filter((row) => row.status === "Pending" || row.status === "In Progress").length;
      return { closed: raised.length - open, label: day.label, open };
    });
    return [
      {
        caption:
          "Requests by the day an employee raised them. Orange is still waiting on the desk; grey has been answered. A tall orange run means the desk fell behind that week.",
        emptyLabel: "No employee has raised an HR support request in the last fortnight.",
        href: "/hr/admin/support-requests",
        hrefLabel: "Open HR Support Requests",
        key: "support-requests-flow",
        rows: chartRows,
        series,
        title: "HR support requests raised, last 14 days",
      },
    ];
  },

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

  /**
   * Where the live candidates actually are.
   *
   * THE GAP THIS CLOSES. HR Advisory's recruiting tiles say how many requisitions are open, how
   * many candidates are active, how many offers are out and how many seats nobody has raised a
   * requisition for. Not one of them says WHERE the live ones are sitting, and that is the only
   * question a pipeline asks. Production on 1 September 2026: eleven candidates in the pool, two
   * in CV screening, one at HR interview. That is a pool nobody is working, and through the tile
   * "Active Candidates 14" it reads exactly like a healthy funnel.
   *
   * ONE BAR PER PILE OF THE CANDIDATE POOL, IN THE ORDER A CV MOVES — see CANDIDATE_FUNNEL_BARS for
   * why the pool and not the applications, and why rejected and hired are absent.
   *
   * THE LAST BAR IS THE HAND-OFF, AND IT IS NOT A CANDIDATE PILE. "Hired, not started" counts people
   * the Employee Master already holds whose first working day is still ahead — the stretch between
   * an accepted offer and a person at work, which the pool cannot see because its piles stop at
   * "hired". It is drawn only when the directory loaded (absent, never zero, otherwise) and the
   * caption says so, so the first four bars still add up to the Active Candidates tile.
   *
   * A SINGLE SERIES, deliberately. The obvious second one is "how long they have been there", and
   * the pool counts carry no age at all — deriving one from a candidate's created date would measure
   * the CANDIDATE's age rather than the pile's, so somebody who moved forward yesterday would plot
   * as three weeks stale. That is a worse answer than no answer.
   */
  recruiting: (loaded) => {
    const dashboard = loaded.recruitment;
    if (!dashboard) return [];
    const series: HrCommandChartSeries[] = [
      { color: CHART_COLORS.primary, key: "candidates", name: "Live candidates" },
    ];
    const pool = dashboard.summary.candidatePool;
    const rows = [
      ...CANDIDATE_FUNNEL_BARS.map((bar) => ({ candidates: pool[bar.status] ?? 0, label: bar.label })),
      ...(loaded.directory
        ? [
            {
              candidates: countStartingAfter(loaded.directory.employees, currentCairoDateOnlyIso()),
              label: "Hired, not started",
            },
          ]
        : []),
    ];
    return [
      {
        caption:
          "Every candidate still being worked, by how far along: CVs awaiting a decision, shortlisted, held as backup, with a hiring manager. The last bar is people already hired whose first day is still ahead. Rejected and hired are history, not counted in the first four.",
        emptyLabel: "No candidate is live at any stage of the pipeline.",
        href: "/hr/recruitment",
        hrefLabel: "Open Recruitment",
        key: "recruiting-pipeline",
        rows,
        series,
        title: "Live candidates, by pipeline stage",
      },
      // Offers load separately (see the recruiting tiles), so a failure there costs this one chart.
      ...(loaded.offers ? [offersByStatusChart(loaded.offers)] : []),
    ];
  },

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

  /**
   * The structure split the way the four tiles beside it cannot: filled against vacant, per line.
   *
   * WHY IT EARNS ITS PLACE. Those tiles are "Active Headcount", "Vacant Seats", "No Manager Set"
   * and "Lines Covered" — four company totals. "Vacant Seats 33" says nothing about whether the
   * hole is spread evenly or concentrated, and in production on 1 September 2026 it is heavily
   * concentrated: Pedia stands at 27 active people against 20 open vacancy rows, while Head Office
   * has 13 people and none. Those are two different conversations with two different managers, and
   * a single total hides both of them.
   *
   * THE SEAT COUNT COMES FROM `openWorkforceSeats`, never from the raw vacancy list — the same
   * deduplication the "Vacant Seats" tile above it uses. Counting `lookups.workforceVacancies`
   * directly would plot columns summing to 45 under a tile reading 33, one click apart.
   *
   * NOT A DUPLICATE OF `people_records`' joiners-and-leavers chart. That one is the directory over
   * TIME; this is the directory over STRUCTURE. And no seat holds both functions in any case —
   * `people_records` belongs to HR Operations, `workforce_insight` to HR Advisory.
   */
  workforce_insight: (loaded) => {
    const directory = loaded.directory;
    if (!directory) return [];
    const series: HrCommandChartSeries[] = [
      { color: CHART_COLORS.secondary, key: "filled", name: "Filled" },
      { color: CHART_COLORS.overdue, key: "vacant", name: "Vacant" },
    ];
    // Keyed on the line NAME, not the id. An employee row and a vacancy row reach this builder
    // through two different services and only the name is carried by both; the name is also what
    // every other line-shaped surface in this app labels with (owner's standing rule: human names,
    // never raw codes). A row with no line is kept and SAID so rather than dropped — production
    // holds two active people and nineteen records with no line at all, and silently discarding
    // them would make the columns disagree with the "Active Headcount" tile.
    const totals = new Map<string, { filled: number; vacant: number }>();
    const bucketFor = (lineName: string | null | undefined) => {
      const label = lineName?.trim() || "No line set";
      const existing = totals.get(label);
      if (existing) return existing;
      const created = { filled: 0, vacant: 0 };
      totals.set(label, created);
      return created;
    };
    // Only ACTIVE employees fill a seat, matching openWorkforceSeats on the other side of the
    // chart: a resigned person still holding a directory row would otherwise be counted as filling
    // the very seat the red column is reporting as empty.
    for (const employee of directory.employees) {
      if (!isActiveDirectoryEmployee(employee)) continue;
      bucketFor(employee.lineName).filled += 1;
    }
    for (const seat of openWorkforceSeats(directory)) {
      bucketFor(seat.lineName).vacant += 1;
    }
    const rows = [...totals.entries()]
      .map(([label, counts]) => ({ filled: counts.filled, label, vacant: counts.vacant }))
      .sort((left, right) => right.filled + right.vacant - (left.filled + left.vacant));
    return [
      {
        caption:
          "Everyone active, and every seat still empty, counted per business line. A line whose red column rivals its dark one cannot deliver, however healthy the company total looks.",
        emptyLabel: "No active employee and no open seat is on record.",
        href: "/hr/reports/vacancies",
        hrefLabel: "Open Vacancy Report",
        key: "structure-by-line",
        rows,
        series,
        title: "Filled and vacant seats, by business line",
      },
    ];
  },
};

/**
 * The recruiting function's tiles and charts, reachable BY NAME rather than only through the seat's
 * bundle loop.
 *
 * WHY. The Talent Acquisition seat's own overview page
 * (src/lib/hr/talent-acquisition-overview.ts) builds its "Filling the field" band from these — the
 * SAME two builders this page uses, never a second copy of them. It is this file's founding rule
 * one layer out: two pages showing one seat's recruiting figures must not be able to print two
 * different answers, and the way that is guaranteed is that there is one builder.
 *
 * Delegating rather than lifting the bodies out keeps `TILES_BY_FUNCTION` / `CHARTS_BY_FUNCTION` the
 * single declaration site, so the bundle loop and these two callers can never fall out of step.
 */
export function buildRecruitingTiles(loaded: HrCommandSources): HrCommandTile[] | null {
  return TILES_BY_FUNCTION.recruiting(loaded);
}

export function buildRecruitingCharts(loaded: HrCommandSources): HrCommandChart[] {
  return CHARTS_BY_FUNCTION.recruiting(loaded);
}

/**
 * Runs `load`, and on any failure records the source name and returns null instead of throwing.
 *
 * Deliberately catches everything. The callers are real services that throw on a missing table, an
 * absent env var, a Supabase abort at 15s — and the correct response to every one of them is the
 * same: this dashboard shows the groups it could read and says which it could not.
 */
export async function safe<T>(
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
export const SOURCE_LABELS: Record<SourceKey, string> = {
  attendanceExceptions: "Attendance exceptions",
  contracts: "Contract renewals",
  deductions: "Deductions month",
  directory: "Employee directory",
  hrOpsReports: "Daily & Weekly Reports",
  offers: "Job offers",
  probation: "Probation cases",
  probationOutcomes: "Probation outcomes",
  recruitment: "Recruitment pipeline",
  resignations: "Resignations",
  retention: "Retention register",
  supportRequests: "HR support requests",
  vacationsToday: "On a vacation today",
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
export async function loadPersonalRecord(access: AccessContext): Promise<HrPersonalRecord> {
  const { year, month } = currentCairoDateParts();
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${monthStart}T00:00:00Z`));

  const [excuses, leave, attendance] = await Promise.all([
    getExcuseWorkspace(access).catch(() => null),
    // Same number the Vacation Request screen shows: the approved-only balance less the days
    // already requested and awaiting a decision. balanceAfterDays === balanceBeforeDays here (this
    // call passes durationDays 0), and both call sites below only display it.
    getVacationRequestPageData(access)
      .then((data) => (data.balance
        ? { ...data.balance, balanceAfterDays: availableBalanceAfterPending(data.balance.balanceBeforeDays, data.pendingPaidDaysByType?.annual ?? 0) }
        : null))
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
  options: { hiredWindow?: { from?: string | null; to?: string | null } } = {},
): Promise<HrCommandCenterData | null> {
  const seat = hrBundleForRole(access.role);
  if (!seat) return null;

  // Resolved ONCE, here, and carried on the returned data. The tile, its caption and the picker
  // that drives it then all read the same window — a second resolve somewhere else is how a
  // caption ends up naming a month the figure was not counted over.
  const hiredWindow = resolveHiredWindow(options.hiredWindow ?? {});

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
      ? safe(
          "recruitment",
          () => getRecruitmentDashboard(access, { awaitingReviewLimit: ITEM_PREVIEW_LIMIT, hiredWindow }),
          failures,
        ).then((value) => {
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
    // The aggregate over DECIDED cases, for the probation-retention KPI — gated on the same
    // predicate the Outcomes analytics page is gated on, because `getProbationOutcomesAnalytics`
    // takes no AccessContext and asserts nothing of its own. A seat that may not open that page
    // gets no figure rather than a figure it is not entitled to, and `canViewProbationAnalytics`
    // naming the seat is the one check, not a second opinion on it.
    needed.has("probationOutcomes")
      ? safe(
          "probationOutcomes",
          async () =>
            canViewProbationAnalytics(access) ? await getProbationOutcomesAnalytics() : undefined,
          failures,
        ).then((value) => {
          loaded.probationOutcomes = value;
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
    needed.has("vacationsToday")
      ? safe("vacationsToday", () => listOnVacationToday(), failures).then((value) => {
          loaded.vacationsToday = value;
        })
      : null,
    needed.has("hrOpsReports")
      ? safe("hrOpsReports", () => loadHrOpsReportsQueue(), failures).then((value) => {
          loaded.hrOpsReports = value;
        })
      : null,
  ]);

  // The Talent Acquisition fence (owner, 2026-10-20), before any task or tile names a person. A fence
  // that cannot read takes the named sources away (listed as unavailable), never hands them over
  // unfenced. Free for every other seat.
  await fenceHrDashboardSources(access, loaded).catch(() => {
    if (loaded.recruitment) failures.push("recruitment");
    if (loaded.offers) failures.push("offers");
    loaded.recruitment = undefined;
    loaded.offers = undefined;
  });

  return {
    groups: buildHrCommandGroups(seat, loaded),
    hiredWindow,
    // `?? null` and not `?? []` — see the note on the field. A failed read must not render as
    // "nobody is off today".
    onVacationToday: loaded.vacationsToday ?? null,
    personal: await personalPromise,
    seat,
    tasks: tasksWithinSeatFence(seat, buildHrTodayTasks(loaded, seat)),
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
  return withinSeatFence(seat, groups);
}

/**
 * Re-point every tile link at a page the seat can actually open. A seat with page fences
 * (src/lib/auth/seat-page-fences.ts) holds the key behind a tile's destination but was not given
 * the page — the Talent Acquisition seat's "Active Candidates" figure links to the CV Database,
 * which the owner left out of her seat. The figure stays; it opens the sibling page that shows the
 * same people, and a tile whose page has no sibling loses the tile rather than offering a bounce.
 */
function withinSeatFence(seat: HrBundleName, groups: HrCommandGroup[]): HrCommandGroup[] {
  return groups
    .map((group) => ({
      ...group,
      charts: group.charts.flatMap((chart) => {
        const href = hrefOutsideSeatFence(seat, chart.href);
        return href ? [{ ...chart, href }] : [];
      }),
      tiles: group.tiles.flatMap((entry) => {
        const href = hrefOutsideSeatFence(seat, entry.href);
        return href ? [{ ...entry, href }] : [];
      }),
    }))
    // The tile builder governs whether a group exists (see buildHrCommandGroups) — so a group whose
    // every tile was fenced away goes, charts and all.
    .filter((group) => group.tiles.length > 0);
}

/** The same rule for the task list, which links to the same pages. */
function tasksWithinSeatFence(seat: HrBundleName, tasks: HrTask[]): HrTask[] {
  return tasks.flatMap((entry) => {
    const href = hrefOutsideSeatFence(seat, entry.href);
    if (!href) return [];
    return [
      {
        ...entry,
        href,
        items: entry.items.map((item) => ({ ...item, href: hrefOutsideSeatFence(seat, item.href) ?? href })),
      },
    ];
  });
}

