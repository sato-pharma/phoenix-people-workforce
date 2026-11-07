import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { adminNavigationSections, peopleManagementPageItems } from "../src/config/system-navigation.ts";
import {
  assertCompanyActivityReportReadAccess,
  canReadCompanyActivityReport,
  phoenixRoles,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { buildCompanyActivityChannels } from "../src/lib/company-activity-report/channels.ts";
import {
  ALL_COMPANY_ACTIVITY_DAY_OUTCOMES,
  OUTCOME_FILL,
  OUTCOME_LABEL,
} from "../src/lib/company-activity-report/export.ts";
import {
  companyActivityFilterParams,
  countActiveCompanyActivityFilters,
  describeCompanyActivityFilterList,
  filterCompanyActivityEmployees,
  NO_COMPANY_ACTIVITY_REPORT_FILTERS,
  parseCompanyActivityFilters,
} from "../src/lib/company-activity-report/filters.ts";
import {
  COMPANY_ACTIVITY_REPORT_EARLIEST_DATE,
  isIsoDateOnly,
  resolveCompanyActivityReportRange,
} from "../src/lib/company-activity-report/range.ts";
import { reconcileCompanyActivityDay, type CompanyActivityDayInputs } from "../src/lib/company-activity-report/reconcile.ts";
import { summarizeCompanyActivityEmployee } from "../src/lib/company-activity-report/summary.ts";
import type {
  CompanyActivityDayRow,
  CompanyActivityFilters,
  CompanyActivityLeaveDetail,
  CompanyActivityVisitDetail,
} from "../src/lib/company-activity-report/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { buildOrgIndex, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Company Activity Report (owner request, 2026-08-28): a day-by-day account of what every employee
 * actually did — CRM visits, office attendance, leave, gaps — over a freely chosen date range, for
 * Super Admin and SFE Manager only. Explicitly NOT a payroll report: leave shows its real status,
 * and a day with both presence AND leave evidence is a surfaced Conflict, never auto-resolved.
 *
 * The center of gravity here is reconcileCompanyActivityDay's precedence chain — the one place that
 * decides, for a single employee-day, which of ten possible outcomes is "what actually happened".
 * Getting that ordering wrong silently misreports real leave as something else, which is precisely
 * the failure mode this report exists to prevent.
 */

const PAGE_SOURCE = readFileSync(
  new URL("../app/(admin)/admin/company-activity-report/page.tsx", import.meta.url),
  "utf8",
);
const DRILLDOWN_PAGE_SOURCE = readFileSync(
  new URL("../app/(admin)/admin/company-activity-report/[hrId]/page.tsx", import.meta.url),
  "utf8",
);
const EXPORT_ROUTE_SOURCE = readFileSync(
  new URL("../app/api/company-activity-report/export/route.ts", import.meta.url),
  "utf8",
);
const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function seat(seatId: string, tier: string, occupantHrId: string | null, path: string[]): OrgSeat {
  return { seatId, parentSeatId: path.at(-2) ?? null, tier, path, occupantHrId, lineCode: "CNS", lineName: "CNS", areaName: null, regionName: null, seatLabel: null };
}

/** scope "company" is what every real non-Super-Admin session carries; "system" is only ever paired
 * with role "Super Admin" (see auth/server.ts's systemAccessContext). */
function context(role: PhoenixRole) {
  return { role, scope: "company" as const };
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── reconcileCompanyActivityDay fixtures ────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const WORKING_CLASSIFICATION = {
  dateIso: "2026-08-04",
  holidayName: null,
  isExpectedWorkingDay: true,
  isFuture: false,
  isHoliday: false,
  isWeeklyOff: false,
};

function visit(overrides: Partial<CompanyActivityVisitDetail> = {}): CompanyActivityVisitDetail {
  return {
    attributionUncertain: false,
    bucket: "regular",
    comment: null,
    contactName: null,
    customerName: "Test Pharmacy",
    isCampaign: false,
    label: "Regular Visit",
    partner2Name: null,
    phoenix: null,
    session: "AM",
    visitType: 0,
    ...overrides,
  };
}

function leave(overrides: Partial<CompanyActivityLeaveDetail> = {}): CompanyActivityLeaveDetail {
  return {
    covered: true,
    dayPart: "full_day",
    id: "leave-1",
    managerDecision: "approved",
    notes: null,
    status: "approved",
    vacationType: "annual",
    ...overrides,
  };
}

function dayInputs(overrides: Partial<CompanyActivityDayInputs> = {}): CompanyActivityDayInputs {
  return {
    classification: WORKING_CLASSIFICATION,
    crmDay: undefined,
    dateIso: "2026-08-04",
    employeeHrId: "A-1",
    hasAttendanceChannel: true,
    hasCrmChannel: true,
    hasOutage: false,
    isAfterExit: false,
    leave: undefined,
    punches: undefined,
    ...overrides,
  };
}

function dayRow(overrides: Partial<CompanyActivityDayRow> = {}): CompanyActivityDayRow {
  return {
    conflict: false,
    crmCampaignVisitCount: 0,
    crmVisitCount: 0,
    crmVisits: [],
    dateIso: "2026-08-04",
    dayType: "working",
    employeeHrId: "A-1",
    firstPunchMinutes: null,
    hasNoSignal: false,
    hasOfficePunch: false,
    lastPunchMinutes: null,
    leave: null,
    outcome: "no_entry",
    reason: "No activity recorded.",
    weekday: "Tuesday",
    ...overrides,
  };
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Test entry point ─────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export function runCompanyActivityReportTests() {
  // ── (1) reconcileCompanyActivityDay — day-type short-circuits, checked before anything else ──
  const future = reconcileCompanyActivityDay(dayInputs({
    classification: { ...WORKING_CLASSIFICATION, isFuture: true },
    punches: { firstPunchMinutes: 480, lastPunchMinutes: 1020, visiblePunchCount: 2 },
  }));
  assert.equal(future.outcome, "future", "a future date is 'future' even with punch data present");
  assert.equal(future.dayType, "future");
  assert.equal(future.conflict, false, "a non-working day can never be a conflict");

  const weeklyOff = reconcileCompanyActivityDay(dayInputs({ classification: { ...WORKING_CLASSIFICATION, isWeeklyOff: true } }));
  assert.equal(weeklyOff.outcome, "weekly_off");
  assert.equal(weeklyOff.dayType, "weekly_off");

  const namedHoliday = reconcileCompanyActivityDay(dayInputs({
    classification: { ...WORKING_CLASSIFICATION, isHoliday: true, holidayName: "Eid al-Fitr" },
  }));
  assert.equal(namedHoliday.outcome, "holiday");
  assert.equal(namedHoliday.reason, "Holiday: Eid al-Fitr.", "a named holiday states its name in the reason");

  const unnamedHoliday = reconcileCompanyActivityDay(dayInputs({ classification: { ...WORKING_CLASSIFICATION, isHoliday: true } }));
  assert.equal(unnamedHoliday.reason, "Holiday.", "an unnamed holiday falls back to a generic reason, not 'Holiday: null.'");

  // ── (2) Working-day precedence: presence beats everything ──
  const officePresent = reconcileCompanyActivityDay(dayInputs({
    crmDay: { isFieldVisitDay: true, isLeaveDay: false, visits: [visit()] },
    leave: leave(),
    punches: { firstPunchMinutes: 480, lastPunchMinutes: 1020, visiblePunchCount: 2 },
  }));
  assert.equal(officePresent.outcome, "office_present", "an office punch wins even when CRM and leave both also say something happened that day");

  const crmFieldVisit = reconcileCompanyActivityDay(dayInputs({
    crmDay: { isFieldVisitDay: true, isLeaveDay: false, visits: [visit()] },
    leave: leave(),
  }));
  assert.equal(crmFieldVisit.outcome, "crm_field_visit", "no punch, but a real CRM field visit -> crm_field_visit, still ahead of the leave record");

  // ── (3) REGRESSION: a device outage must NEVER outrank an independently-sourced leave signal.
  //    An outage explains a missing PUNCH; it explains nothing about a leave request, which never
  //    depended on punch data in the first place. (Caught and fixed while writing this test — the
  //    first draft of reconcile.ts checked hasOutage before the three leave branches, which meant
  //    an approved leave day with a same-day company-wide outage silently reported as "Device
  //    Outage" and vanished from leaveApprovedDays.) ──
  const crmLeaveOverOutage = reconcileCompanyActivityDay(dayInputs({
    crmDay: { isFieldVisitDay: false, isLeaveDay: true, visits: [] },
    hasOutage: true,
  }));
  assert.equal(crmLeaveOverOutage.outcome, "crm_leave", "CRM-reported Annual Vacation must win over a same-day device outage");

  const leaveApprovedOverOutage = reconcileCompanyActivityDay(dayInputs({ hasOutage: true, leave: leave({ covered: true }) }));
  assert.equal(leaveApprovedOverOutage.outcome, "leave_approved", "an approved Phoenix leave request must win over a same-day device outage");

  const leavePendingOverOutage = reconcileCompanyActivityDay(dayInputs({
    hasOutage: true,
    leave: leave({ covered: false, managerDecision: null, status: "pending_manager" }),
  }));
  assert.equal(leavePendingOverOutage.outcome, "leave_pending", "a pending Phoenix leave request must also win over a same-day device outage");
  assert.equal(leavePendingOverOutage.reason, "Leave pending — status: pending_manager.");

  // Outage is the true fallback ONLY once every independent signal is genuinely absent.
  const genuineOutage = reconcileCompanyActivityDay(dayInputs({ hasOutage: true }));
  assert.equal(genuineOutage.outcome, "device_outage", "with no punch, no CRM signal and no leave at all, the outage is the honest explanation");

  // ── (4) no_signal vs no_entry — a distinct state, never silently merged ──
  const noSignal = reconcileCompanyActivityDay(dayInputs({ hasAttendanceChannel: false, hasCrmChannel: false }));
  assert.equal(noSignal.outcome, "no_signal");
  assert.equal(noSignal.hasNoSignal, true);
  assert.equal(
    noSignal.reason,
    "No attendance device or Phoenix CRM seat on record for this employee.",
    "the CRM channel is a Phoenix CRM seat now (owner, 2026-11-07) — the reason must say so, never 'CRM identity'",
  );

  // ── (4b) THE CRM CHANNEL IS A PHOENIX CRM SEAT (owner, 2026-11-07: "ANY SINGLE SOURCE OF FIELD WORK
  // IS NOW THE PHOENIX CRM"). It used to be an iReports360 username on the employee row, so 23 reps and
  // 3 district managers hired straight into Phoenix CRM read "No Signal" on every silent day.
  const org = buildOrgIndex([
    seat("CEO-1", "CEO", "B-1", ["CEO-1"]),
    seat("NSM-1", "NSM", "B-20", ["CEO-1", "NSM-1"]),
    seat("RSM-1", "RSM", "B-30", ["CEO-1", "NSM-1", "RSM-1"]),
    seat("DM-1", "DM", "B-40", ["CEO-1", "NSM-1", "RSM-1", "DM-1"]),
    seat("ADM-1", "ACTING_DM", "B-45", ["CEO-1", "NSM-1", "RSM-1", "ADM-1"]),
    seat("REP-1", "REP", "B-201", ["CEO-1", "NSM-1", "RSM-1", "DM-1", "REP-1"]),
    seat("REP-2", "REP", null, ["CEO-1", "NSM-1", "RSM-1", "DM-1", "REP-2"]),
    // A handover seat: the rep serving notice and the new hire both sit on it.
    seat("REP-3", "REP", "B-202", ["CEO-1", "NSM-1", "RSM-1", "DM-1", "REP-3"]),
    seat("REP-3", "REP", "B-203", ["CEO-1", "NSM-1", "RSM-1", "DM-1", "REP-3"]),
  ]);
  const channels = buildCompanyActivityChannels(["b-900"], org);
  assert.equal(channels.hasCrmChannel("B-201"), true, "a rep on a territory seat is observable through Phoenix CRM");
  assert.equal(channels.hasCrmChannel("b-201"), true, "in any casing");
  assert.equal(channels.hasCrmChannel("B-202"), true, "a handover seat's first occupant keeps his channel");
  assert.equal(channels.hasCrmChannel("B-203"), true, "and the new hire on the same seat has one too");
  for (const manager of ["B-20", "B-30", "B-40", "B-45"]) {
    assert.equal(channels.hasCrmChannel(manager), true, `${manager}: a national, regional, district or acting district manager seat is a CRM channel`);
  }
  assert.equal(channels.hasCrmChannel("B-1"), false, "the CEO seat is not a CRM channel — scope.ts never treats it as a district");
  assert.equal(channels.hasCrmChannel("B-900"), false, "no seat, no CRM channel — whatever iReports360 username the employee row still carries");
  assert.equal(channels.hasCrmChannel(""), false, "an empty id holds nothing");
  assert.equal(channels.hasAttendanceChannel("B-900"), true, "the attendance channel is still the active device mapping, matched in any casing");
  assert.equal(channels.hasAttendanceChannel("B-201"), false, "a seat is never an attendance device");
  const CHANNELS_SOURCE = readSource("src/lib/company-activity-report/channels.ts");
  assert.match(CHANNELS_SOURCE, /loadPhoenixCrmOrg()/, "the seats come from the one organogram reader every Phoenix CRM scope decision uses");
  assert.doesNotMatch(CHANNELS_SOURCE, /loadCrmIdentityMaps|crmUsername|crm_username/, "the CRM channel never reads the iReports360 identity again");

  // ── (4c) Every label the reader sees names a Phoenix CRM seat, and none names iReports360. ──
  const LABEL_SOURCES = {
    export: readSource("src/lib/company-activity-report/export.ts"),
    table: readSource("src/components/company-activity-report/company-activity-report-table.tsx"),
    dayDetail: readSource("src/components/company-activity-report/employee-day-detail-view.tsx"),
  };
  for (const [name, source] of Object.entries(LABEL_SOURCES)) {
    assert.doesNotMatch(source, /iReports360/, `${name}: no label names iReports360 — field work is Phoenix CRM's now`);
    assert.doesNotMatch(source, /no CRM id|CRM identity/, `${name}: the missing channel is a Phoenix CRM seat, never a "CRM id"`);
    assert.match(source, /Phoenix CRM seat/, `${name}: says "Phoenix CRM seat" where the channel is missing`);
  }

  const noEntry = reconcileCompanyActivityDay(dayInputs());
  assert.equal(noEntry.outcome, "no_entry", "a fully-visible employee with nothing recorded is a genuine gap, not no_signal");
  assert.equal(noEntry.hasNoSignal, false);

  // ── (5) Conflict — surfaced independently of which outcome won, never auto-resolved ──
  const conflictViaPunchAndLeave = reconcileCompanyActivityDay(dayInputs({
    leave: leave(),
    punches: { firstPunchMinutes: 480, lastPunchMinutes: 720, visiblePunchCount: 1 },
  }));
  assert.equal(conflictViaPunchAndLeave.outcome, "office_present", "the primary outcome is still the presence signal");
  assert.equal(conflictViaPunchAndLeave.conflict, true, "office presence AND an approved leave on the same day is a conflict, regardless of which outcome wins");

  const noConflictLeaveAlone = reconcileCompanyActivityDay(dayInputs({ leave: leave() }));
  assert.equal(noConflictLeaveAlone.conflict, false, "leave with no presence evidence at all is not a conflict");

  const noConflictPresenceAlone = reconcileCompanyActivityDay(dayInputs({
    punches: { firstPunchMinutes: 480, lastPunchMinutes: 720, visiblePunchCount: 1 },
  }));
  assert.equal(noConflictPresenceAlone.conflict, false, "presence with no leave signal at all is not a conflict");

  // ── (6) Visit counting — total vs campaign-only, straight off the visits array ──
  const twoVisitsOneCampaign = reconcileCompanyActivityDay(dayInputs({
    crmDay: {
      isFieldVisitDay: true,
      isLeaveDay: false,
      visits: [visit({ isCampaign: true, label: "Campaign/Prospection" }), visit({ isCampaign: false })],
    },
  }));
  assert.equal(twoVisitsOneCampaign.crmVisitCount, 2);
  assert.equal(twoVisitsOneCampaign.crmCampaignVisitCount, 1, "only the visit actually flagged isCampaign counts toward the campaign tally");

  // ── (7) summarizeCompanyActivityEmployee — pure aggregation over an already-built day list ──
  const employee: EmployeeDirectoryRow = {
    areaName: "Giza",
    displayName: "Test Employee",
    fullName: "Test Employee Full",
    hrId: "A-1",
    jobTitle: "Medical Representative",
    lineName: "CNS",
    regionName: "Greater Cairo",
    teamName: "Team A",
  } as EmployeeDirectoryRow;

  const summary = summarizeCompanyActivityEmployee(employee, [
    dayRow({ dateIso: "2026-08-01", hasOfficePunch: true, outcome: "office_present" }),
    dayRow({ dateIso: "2026-08-02", outcome: "crm_field_visit", crmVisitCount: 3, crmCampaignVisitCount: 1, crmVisits: [visit(), visit(), visit({ isCampaign: true })] }),
    dayRow({ dateIso: "2026-08-03", outcome: "crm_leave", leave: null }),
    dayRow({ dateIso: "2026-08-04", outcome: "leave_approved", leave: leave() }),
    dayRow({ dateIso: "2026-08-05", outcome: "leave_pending", leave: leave({ covered: false, status: "pending_manager" }) }),
    dayRow({ dateIso: "2026-08-06", outcome: "no_entry" }),
    dayRow({ dateIso: "2026-08-07", outcome: "no_signal", hasNoSignal: true }),
    dayRow({ dateIso: "2026-08-08", outcome: "device_outage" }),
    dayRow({ dateIso: "2026-08-09", dayType: "weekly_off", outcome: "weekly_off" }),
    dayRow({ dateIso: "2026-08-10", dayType: "holiday", outcome: "holiday" }),
    // Presence + leave together -> conflict, counted regardless of which outcome the day carries.
    dayRow({ dateIso: "2026-08-11", outcome: "office_present", hasOfficePunch: true, leave: leave(), conflict: true }),
    // A second campaign day, with TWO campaign visits on it — proves campaignVisitDays counts
    // distinct days, not visits: 1 (from 08-02) + 2 here = 3 total visits, but only 2 days.
    dayRow({ dateIso: "2026-08-12", outcome: "crm_field_visit", crmVisitCount: 2, crmCampaignVisitCount: 2, crmVisits: [visit({ isCampaign: true }), visit({ isCampaign: true })] }),
  ], { hasAttendanceChannel: true, hasCrmChannel: true });

  assert.equal(summary.employeeHrId, "A-1");
  assert.equal(summary.employeeName, "Test Employee", "employeeName prefers the nickname-aware displayName over fullName");
  assert.equal(summary.workingDays, 10, "working days excludes weekly_off and holiday (12 rows - 2)");
  assert.equal(summary.officePresentDays, 2);
  assert.equal(summary.crmFieldVisitDays, 2);
  assert.equal(summary.totalCrmVisits, 5, "visit totals accumulate from every day, not just crm_field_visit-outcome days");
  assert.equal(summary.campaignVisits, 3, "sums every campaign visit: 1 on 08-02 + 2 on 08-12");
  assert.equal(summary.campaignVisitDays, 2, "counts DISTINCT days with >=1 campaign visit, not the visit total — 08-12's two visits still count as one day");
  assert.equal(summary.leaveApprovedDays, 2, "crm_leave and leave_approved fold into the SAME tally — both are at-least-as-certain leave signals");
  assert.equal(summary.leavePendingDays, 1);
  assert.equal(summary.noEntryDays, 1);
  assert.equal(summary.noSignalDays, 1);
  assert.equal(summary.conflictDays, 1);

  // ── (8) filterCompanyActivityEmployees — roster narrowing, AND semantics across active filters ──
  const roster: EmployeeDirectoryRow[] = [
    { ...employee, hrId: "A-1", displayName: "Amira Hassan", jobTitle: "Medical Representative", lineName: "CNS", teamName: "Team A" } as EmployeeDirectoryRow,
    { ...employee, hrId: "A-2", displayName: "Bassem Nabil", jobTitle: "District Manager", lineName: "CNS", teamName: "Team B" } as EmployeeDirectoryRow,
    { ...employee, hrId: "A-3", displayName: "Cherine Adel", jobTitle: "Medical Representative", lineName: "Anti Infective", teamName: "Team A" } as EmployeeDirectoryRow,
  ];

  assert.equal(filterCompanyActivityEmployees(roster, NO_COMPANY_ACTIVITY_REPORT_FILTERS).length, 3, "no active filters returns the whole roster");

  const includeLine = filterCompanyActivityEmployees(roster, { ...NO_COMPANY_ACTIVITY_REPORT_FILTERS, lineNames: ["CNS"] });
  assert.deepEqual(includeLine.map((row) => row.hrId).sort(), ["A-1", "A-2"], "include mode keeps only the matching line");

  const excludeLine = filterCompanyActivityEmployees(roster, { ...NO_COMPANY_ACTIVITY_REPORT_FILTERS, lineNames: ["CNS"], lineMode: "exclude" });
  assert.deepEqual(excludeLine.map((row) => row.hrId), ["A-3"], "exclude mode drops the matching line and keeps everyone else");

  const lineAndTeam = filterCompanyActivityEmployees(roster, { ...NO_COMPANY_ACTIVITY_REPORT_FILTERS, lineNames: ["CNS"], teamNames: ["Team A"] });
  assert.deepEqual(lineAndTeam.map((row) => row.hrId), ["A-1"], "multiple active filters combine with AND, not OR");

  const byJobTitle = filterCompanyActivityEmployees(roster, { ...NO_COMPANY_ACTIVITY_REPORT_FILTERS, jobTitle: "District Manager" });
  assert.deepEqual(byJobTitle.map((row) => row.hrId), ["A-2"]);

  const byQuery = filterCompanyActivityEmployees(roster, { ...NO_COMPANY_ACTIVITY_REPORT_FILTERS, query: "cherine" });
  assert.deepEqual(byQuery.map((row) => row.hrId), ["A-3"], "search is case-insensitive against the display name");

  // ── (9) Filter chips / active-count / URL round-trip ──
  assert.equal(countActiveCompanyActivityFilters(NO_COMPANY_ACTIVITY_REPORT_FILTERS), 0);
  const busyFilters: CompanyActivityFilters = {
    ...NO_COMPANY_ACTIVITY_REPORT_FILTERS,
    areaNames: ["Giza"],
    areaMode: "exclude",
    jobTitle: "Medical Representative",
    lineNames: ["CNS", "Anti Infective"],
    query: "amira",
  };
  assert.equal(countActiveCompanyActivityFilters(busyFilters), 4);
  const chips = describeCompanyActivityFilterList(busyFilters);
  assert.equal(chips.length, 4);
  assert.ok(chips.some((chip) => chip.label === "Area: Giza (excluded)"), "an exclude-mode chip states the mode in its own label");
  assert.ok(chips.some((chip) => chip.label === "Line: CNS, Anti Infective"), "an include-mode chip states no suffix at all");

  // The URL a filter panel writes must parse back to the exact same filters — the export link and
  // the summary page both depend on this being lossless.
  const roundTripped = parseCompanyActivityFilters(companyActivityFilterParams(busyFilters));
  assert.deepEqual(roundTripped, busyFilters, "filters must round-trip through the URL unchanged");

  // ── (10) resolveCompanyActivityReportRange — free-range resolution, never throws ──
  const defaulted = resolveCompanyActivityReportRange({ endDate: null, startDate: null }, "2026-08-15");
  assert.deepEqual(defaulted, { endDate: "2026-08-15", startDate: "2026-08-01" }, "no input resolves to month-to-date, not year-to-date (this scan is heavier than the vacation report's)");

  const reversed = resolveCompanyActivityReportRange({ endDate: "2026-01-01", startDate: "2026-06-01" }, "2026-08-15");
  assert.deepEqual(reversed, { endDate: "2026-06-01", startDate: "2026-01-01" }, "a reversed pair is swapped, never collapsed to an empty range");

  const tooEarly = resolveCompanyActivityReportRange({ endDate: "2026-08-15", startDate: "1999-01-01" }, "2026-08-15");
  assert.equal(tooEarly.startDate, COMPANY_ACTIVITY_REPORT_EARLIEST_DATE, "a start before the floor is clamped, not passed through to the database");

  const malformed = resolveCompanyActivityReportRange({ endDate: "not-a-date", startDate: "2026-08-01" }, "2026-08-15");
  assert.equal(malformed.endDate, "2026-08-15", "an unparseable end date falls back to today rather than throwing");

  assert.equal(isIsoDateOnly("2026-02-31"), false, "shape-valid but calendar-invalid (Feb 31) must still be rejected");
  assert.equal(isIsoDateOnly("2026-13-01"), false, "month 13 must be rejected despite matching the YYYY-MM-DD shape");
  assert.equal(isIsoDateOnly("2026-02-28"), true);

  // ── (11) OUTCOME_LABEL / OUTCOME_FILL exhaustiveness — a Record missing a key still compiles and
  //    ships here (next.config sets ignoreBuildErrors), so this is the only thing that actually
  //    catches it. Iterated off the hand-written union array, per AGENTS.md's "an exhaustive Record
  //    does not gate the build" rule. ──
  for (const outcome of ALL_COMPANY_ACTIVITY_DAY_OUTCOMES) {
    assert.ok(OUTCOME_LABEL[outcome] && OUTCOME_LABEL[outcome].length > 0, `OUTCOME_LABEL is missing a real label for "${outcome}"`);
    assert.match(OUTCOME_FILL[outcome] ?? "", /^FF[0-9A-Fa-f]{6}$/, `OUTCOME_FILL for "${outcome}" must be a real ARGB hex color, not blank`);
  }
  assert.equal(Object.keys(OUTCOME_LABEL).length, ALL_COMPANY_ACTIVITY_DAY_OUTCOMES.length, "OUTCOME_LABEL must carry no keys beyond the declared union");
  assert.equal(Object.keys(OUTCOME_FILL).length, ALL_COMPANY_ACTIVITY_DAY_OUTCOMES.length, "OUTCOME_FILL must carry no keys beyond the declared union");

  // ── (12) Role gate — exactly three roles, named exhaustively so a new role is never admitted by
  //    default; the server-side assert is the boundary, so both pages and the export route must
  //    actually call it, not merely hide a link.
  //
  //    HR Operations joined 2026-08-29 on the owner's company-scope ruling — a widening that was
  //    asked for, and the only reason this list moved. This is the report behind her job
  //    description's "identify unexplained absences, missing punches or inconsistent records", and
  //    it has no write path, so read access is the whole of it. She is admitted by membership of
  //    companyActivityReportReaderRoles, not by her scope: the predicate short-circuits on
  //    scope === "system" alone, and hers is "company". ──
  assert.equal(canReadCompanyActivityReport(context("Super Admin")), true);
  assert.equal(canReadCompanyActivityReport(context("SFE Manager")), true);
  assert.equal(canReadCompanyActivityReport(context("HR Operations")), true);
  const readers = phoenixRoles.filter((role) => canReadCompanyActivityReport(context(role)));
  assert.deepEqual([...readers].sort(), ["HR Operations", "SFE Manager", "Super Admin"], "exactly three roles may read the company activity report — a fourth arriving here is an unrequested widening");

  assert.throws(
    () => assertCompanyActivityReportReadAccess(context("Regional Manager")),
    /Forbidden/,
    "a denied role must throw, not resolve to an empty report",
  );
  assert.doesNotThrow(() => assertCompanyActivityReportReadAccess(context("Super Admin")));

  assert.ok(
    PAGE_SOURCE.includes("canReadCompanyActivityReport(access)"),
    "the summary page must gate on canReadCompanyActivityReport, or an unlisted role reaches it by omission",
  );
  assert.ok(
    DRILLDOWN_PAGE_SOURCE.includes("canReadCompanyActivityReport(access)"),
    "the per-employee drilldown is its own route with its own gate — a page the summary hides is still reachable by a guessed/forwarded URL if this is missing",
  );
  assert.ok(
    EXPORT_ROUTE_SOURCE.includes("assertCompanyActivityReportReadAccess(access"),
    "the export route must assert the read gate itself — a hidden Export button is not a boundary",
  );

  // ── (13) Navigation — the two entries this report actually needs, with the split the owner asked
  //    for (SFE Manager gets a standalone section; Super Admin already reaches it via the hub) ──
  const sfeSection = adminNavigationSections.find((section) => section.id === "company-activity-report");
  assert.ok(sfeSection, "the standalone SFE Manager nav section must exist");
  const sfeItem = sfeSection?.items.find((item) => item.href === "/admin/company-activity-report");
  assert.ok(sfeItem, "the nav section must actually link to the report");
  assert.deepEqual(sfeItem?.roles, ["SFE Manager"]);
  assert.deepEqual(sfeItem?.excludedRoles, ["Super Admin", "CEO"], "excludedRoles keeps Super Admin from seeing the page twice — his sidebar already reaches it via the hub card");

  // The SFE Manager is the ONLY role this row renders for, and he is also the only role on the
  // FLAT sidebar (flatSidebarRoles), so getSections blanks every section label for him — the
  // section heading "Company Activity Report" never reaches his screen. Without this override the
  // only words he sees are "Activity Report", 14th of 24 headingless buttons, which is why he
  // reported the page missing on 2026-09-03 while every gate above it measured green.
  // Owner instruction that day: rename it to "Company Activity Report" for him.
  //
  // labelByRole rather than renaming the canonical label: defaultModuleId() embeds that label and
  // moduleIds are persisted in sidebar_module_assignments, so a plain rename changes the id and
  // can silently unfile the row. resolveItemLabel applies this override at display time only.
  assert.equal(
    sfeItem?.labelByRole?.["SFE Manager"],
    "Company Activity Report",
    "his flat sidebar renders no section heading, so the row itself must carry the full name",
  );
  assert.equal(sfeItem?.label, "Activity Report", "the canonical label must NOT change — defaultModuleId embeds it");

  const hubCard = peopleManagementPageItems.find((item) => item.href === "/admin/company-activity-report");
  assert.ok(hubCard, "the Super Admin hub card must exist");
  // HR Operations joined this card 2026-08-29 with the owner's ruling, and it is NOT cosmetic even
  // though she is offered no People Management hub row and so never renders it. This list is the
  // admin closure tests/hr-url-namespace.test.ts derives per seat, and it requires every /hr row to
  // point INSIDE that closure — the HR namespace may narrow the matrix, never widen it. Her
  // /hr/admin/company-activity-report row is that mirror, so taking her off this card turns the row
  // into a page "neither seat's permissions admit" and the namespace test goes red. Reverting this
  // to ["Super Admin"] alone was tried on 2026-08-29 and produced exactly that failure.
  assert.deepEqual(hubCard?.roles, ["Super Admin", "HR Operations"]);
}
