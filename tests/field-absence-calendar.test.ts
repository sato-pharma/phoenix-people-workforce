import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import type { CrmDayVisitRow } from "../src/lib/attendance/crm-day-maps.ts";
import { isRolePermissionWithinHardBoundary, permissionMatrix, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { canReadFieldAbsence, resolveFieldAbsenceScope, scopeAdmitsLine } from "../src/lib/field-absence/access.ts";
import {
  buildFieldAbsenceCalendar,
  fieldAbsenceNeverStarted,
  resolveFieldAbsencePeriod,
  WHOLE_PERIOD_MIN_DAYS,
  type FieldAbsenceEvidence,
  type FieldAbsencePerson,
  type FieldAbsenceSeatSpan,
  type FieldAbsenceTier,
} from "../src/lib/field-absence/rules.ts";
import { resolvePortalTwin } from "../src/lib/navigation/portal-twins.ts";
import { crmDayLabel, departedAgentCrmDays } from "../src/lib/field-absence/server/evidence.ts";
import { FILED_VACATION_STATUSES } from "../src/lib/vacation/approved-leave-days.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Field Absence Calendar (owner, 2026-10-18): every working day lists the field people the system
// did not see AT ALL — no CRM visit, no double visit, no vacation filed, no business trip, no
// fingerprint punch. These pin the rule, the reach and the wiring.
//
// The window below is 10–20 October 2026 with "today" Sunday the 18th:
//   Sat 10 · Sun 11 · Mon 12 · Tue 13 (a holiday here) · Wed 14 · Thu 15 · Fri 16 · Sat 17 ·
//   Sun 18 (today) · Mon 19 and Tue 20 (still to come).
// ─────────────────────────────────────────────────────────────────────────────

const TODAY = "2026-10-18";

function span(tier: FieldAbsenceTier, lineName: string, from: string, to: string | null = null): FieldAbsenceSeatSpan {
  return {
    areaName: `${lineName} area`,
    from,
    lineCode: lineName.toUpperCase(),
    lineName,
    managerName: "Manager Name",
    regionName: "Region",
    seatId: `${tier}-${lineName}-${from}`,
    tier,
    to,
  };
}

function person(key: string, spans: FieldAbsenceSeatSpan[], extra: Partial<FieldAbsencePerson> = {}): FieldAbsencePerson {
  return { employmentActive: true, hireDate: null, key, lastWorkingDate: null, name: `Person ${key}`, spans, ...extra };
}

function evidence(seen: Record<string, string[]>, extra: Partial<FieldAbsenceEvidence> = {}): FieldAbsenceEvidence {
  const map = new Map<string, Map<string, string>>();
  for (const [key, days] of Object.entries(seen)) map.set(key, new Map(days.map((day) => [day, "CRM visit"])));
  return { holidays: new Set(["2026-10-13"]), holidaysComplete: true, seen: map, unreadable: [], ...extra };
}

const PEOPLE: FieldAbsencePerson[] = [
  // A rep on one seat all along, seen on three days.
  person("REP-A", [span("REP", "CNS", "2026-01-01")]),
  // A Regional Sales Manager nobody ever recorded — Saturday is his day off.
  person("RSM-B", [span("RSM", "CNS", "2026-01-01")]),
  // A joiner on the 14th: never judged before it.
  person("REP-C", [span("REP", "CNS", "2026-10-14")], { hireDate: "2026-10-14" }),
  // A leaver whose last working day was the 12th: never judged after it.
  person("REP-D", [span("REP", "CNS", "2026-01-01")], { lastWorkingDate: "2026-10-12" }),
  // A transfer: CNS until the 14th (half-open — the 14th is NOT a CNS day), Pedia from the 14th.
  person("REP-E", [span("REP", "CNS", "2026-09-01", "2026-10-14"), span("REP", "Pedia", "2026-10-14")]),
  // A National Sales Manager, seen through his punches on every working day but the 12th.
  person("NSM-F", [span("NSM", "CNS", "2026-01-01")]),
];

const SEEN = {
  "NSM-F": ["2026-10-11", "2026-10-14", "2026-10-15", "2026-10-18"],
  "REP-A": ["2026-10-11", "2026-10-12", "2026-10-14"],
  "REP-E": ["2026-10-11", "2026-10-18"],
};

function build(extra: Partial<FieldAbsenceEvidence> = {}, window: { start?: string; end?: string; today?: string } = {}) {
  return buildFieldAbsenceCalendar({
    end: window.end ?? "2026-10-20",
    evidence: evidence(SEEN, extra),
    people: PEOPLE,
    start: window.start ?? "2026-10-10",
    today: window.today ?? TODAY,
  });
}

function keysOn(calendar: ReturnType<typeof build>, date: string): string[] {
  const day = calendar.days.find((row) => row.date === date);
  assert.ok(day, `the calendar must carry ${date}`);
  return day.notSeen.map((entry) => entry.key).sort();
}

function runDayRules() {
  const calendar = build();
  const day = (date: string) => calendar.days.find((row) => row.date === date)!;

  assert.equal(calendar.judged, true);
  assert.equal(day("2026-10-16").kind, "weekly-off", "Friday is off for every field title");
  assert.equal(day("2026-10-16").notSeen.length, 0);
  assert.equal(day("2026-10-13").kind, "holiday", "a national holiday lists nobody");
  assert.equal(day("2026-10-13").expected, 0);
  assert.equal(day("2026-10-19").kind, "future", "a day still to come is never judged");
  assert.equal(day("2026-10-19").notSeen.length, 0);
  assert.equal(day("2026-10-15").halfDay, true, "Thursday is listed, tagged as a half day");
  assert.equal(day("2026-10-18").provisional, true, "today is shown as so far");
  assert.equal(day("2026-10-17").provisional, false);

  // Saturday: the reps on a seat that day are expected; the RSM and the NSM are off.
  assert.deepEqual(keysOn(calendar, "2026-10-10"), ["REP-A", "REP-D", "REP-E"]);
  assert.equal(day("2026-10-10").expected, 3, "Saturday's count is the reps alone — RSM-B and NSM-F are off, REP-C not yet hired");
  assert.deepEqual(keysOn(calendar, "2026-10-17"), ["REP-A", "REP-C", "REP-E"], "the leaver is gone by the 17th, the joiner is in");

  // Monday the 12th: REP-A was seen; the NSM missed his punch, so he is listed like anyone else.
  assert.deepEqual(keysOn(calendar, "2026-10-12"), ["REP-D", "REP-E", "RSM-B", "NSM-F"].sort());

  // The joiner and the leaver are judged only on the days they really held the seat.
  assert.equal(keysOn(calendar, "2026-10-12").includes("REP-C"), false, "a joiner is not listed before his hire date");
  assert.equal(keysOn(calendar, "2026-10-14").includes("REP-D"), false, "a leaver is not listed after his last working day");

  // The transfer: a CNS day on the 12th, a Pedia day on the 14th, because the CNS stretch ENDS on the 14th.
  const onTwelfth = day("2026-10-12").notSeen.find((entry) => entry.key === "REP-E")!;
  const onFourteenth = day("2026-10-14").notSeen.find((entry) => entry.key === "REP-E")!;
  assert.equal(onTwelfth.lineName, "CNS");
  assert.equal(onFourteenth.lineName, "Pedia", "the seat is dated half-open: the day a stretch ends belongs to the next one");
}

function runPersonSummaries() {
  const calendar = build();
  const of = (key: string) => calendar.people.find((row) => row.key === key)!;

  const rep = of("REP-A");
  // Today (the 18th) has not ended: it stays in its own day box as "so far", but it is never a
  // judged day, so the month tiles and the Detail rows count finished days only (2026-10-26).
  assert.deepEqual(rep.judgedDates, ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-14", "2026-10-15", "2026-10-17"]);
  assert.deepEqual(rep.notSeenDates, ["2026-10-10", "2026-10-15", "2026-10-17"]);
  assert.equal(rep.expectedDays, 6, "today is not one of his judged working days");
  assert.equal(rep.expectedToday, true);
  assert.equal(rep.notSeenToday, true, "nothing recorded so far today is carried apart from the finished days");
  assert.equal(calendar.days.find((row) => row.date === "2026-10-18")!.notSeen.some((entry) => entry.key === "REP-A"), true, "today's box still lists him so far");
  assert.equal(rep.longestRun, 2, "the 15th and the 17th run together (the Friday between is off); today is not finished, so it never lengthens a run");
  assert.equal(rep.lastSeen, "2026-10-14");
  assert.equal(rep.lastSeenLabel, "CRM visit");
  assert.equal(rep.wholePeriod, false);

  const rsm = of("RSM-B");
  assert.deepEqual(rsm.judgedDates, ["2026-10-11", "2026-10-12", "2026-10-14", "2026-10-15"], "an RSM is never judged on a Saturday, and today is not judged");
  assert.equal(rsm.wholePeriod, true, "four finished working days and nothing recorded");
  assert.equal(rsm.longestRun, 4);
  assert.equal(rsm.lastSeen, null);

  // The most days not seen come first.
  const counts = calendar.people.map((row) => row.notSeenDates.length);
  assert.deepEqual(counts, [...counts].sort((left, right) => right - left));
  assert.equal(counts[0], 5, "REP-E: the 10th, 12th, 14th, 15th and 17th — today is never counted");
  assert.equal(calendar.people[0].key, "REP-E");

  // On the second working day of a window, "not seen on any day" would rest on too little.
  const early = build({}, { end: "2026-10-12", start: "2026-10-11", today: "2026-10-12" });
  const earlyRsm = early.people.find((row) => row.key === "RSM-B")!;
  assert.equal(earlyRsm.notSeenDates.length, 1, "the 11th only — today (the 12th) is not judged yet");
  assert.equal(earlyRsm.wholePeriod, false, `fewer than ${WHOLE_PERIOD_MIN_DAYS} finished working days is never "not seen on any day"`);
}

function runSeenDaysStayOnTheSeat() {
  // The CNS calendar: the service keeps only a person's CNS stretches, as the line filter does.
  const calendar = buildFieldAbsenceCalendar({
    end: "2026-10-20",
    evidence: evidence({ "REP-D": ["2026-10-11", "2026-10-14"], "REP-E": ["2026-10-11", "2026-10-18"] }),
    people: [PEOPLE.find((row) => row.key === "REP-D")!, person("REP-E", [span("REP", "CNS", "2026-09-01", "2026-10-14")])],
    start: "2026-10-10",
    today: TODAY,
  });
  const of = (key: string) => calendar.people.find((row) => row.key === key)!;
  assert.deepEqual(of("REP-E").seenDates, ["2026-10-11"], "a record on his Pedia seat is not the CNS calendar's to show");
  assert.equal(of("REP-E").lastSeen, "2026-10-11", "his last record on THIS calendar, not the one on the line he moved to");
  assert.deepEqual(of("REP-D").seenDates, ["2026-10-11"], "a record after his last working day (a reused CRM login) is not his");
  assert.equal(of("REP-D").lastSeen, "2026-10-11");
}

function runDepartedAgentsOwnVisits() {
  // The CRM's default read hides every row a departed agent filed himself, so a rep serving his notice
  // read as "not seen" on days he visited. His own rows are read separately and credited to him alone.
  const row = (agent: string | null, date: string, visitType: number, extra: Partial<CrmDayVisitRow> = {}): CrmDayVisitRow => ({
    agent_hr_id: agent,
    comment: "the rep's own words",
    customer_name: null,
    double2_hr_id: null,
    double_hr_id: null,
    visit_date: date,
    visit_type: visitType,
    visit_type_description: visitType === 0 ? "Regular Visit" : visitType === -4 ? "Annual Vacation" : "Unknown",
    ...extra,
  });
  const days = departedAgentCrmDays(
    [
      row("rep-x", "2026-10-11", 0),
      row("REP-X", "2026-10-11", 0),
      row("REP-X", "2026-10-12", -4),
      row("REP-X", "2026-10-14", -99),
      row("REP-A", "2026-10-15", 0),
      row("MGR-1", "2026-10-15", 0, { double_hr_id: "REP-X" }),
      row("REP-X", null as unknown as string, 0),
    ],
    ["REP-X"],
  );
  assert.deepEqual(
    days.map((day) => `${day.hrId} ${day.day}`).sort(),
    ["REP-X 2026-10-11", "REP-X 2026-10-12"],
    "his own visit and his CRM leave day count, once a day; an unclassified code, another agent's row and a row he was only the double on do not come from here",
  );
  assert.equal(days.find((day) => day.day === "2026-10-11")?.label, "Regular visit in the old CRM");
  assert.equal(days.some((day) => day.label.includes("own words")), false, "a rep's free-text comment never reaches the page");
  assert.deepEqual(departedAgentCrmDays([row("REP-X", "2026-10-11", 0)], []), [], "nobody departed, nothing credited");

  const evidenceSource = stripComments(readFileSync("src/lib/field-absence/server/evidence.ts", "utf8"));
  assert.equal(evidenceSource.includes("includeResignedAgents: true,"), true, "a departed person's own visits are read with the exclusion lifted");
  assert.equal(evidenceSource.includes("agentHrIds: departed,"), true, "and only for the departed people on this calendar");
  assert.equal(evidenceSource.includes("crmDayKind("), true, "classified by the day reader's own ruling, never a second copy");
  const service = stripComments(readFileSync("src/lib/field-absence/server/service.ts", "utf8"));
  assert.equal(service.includes("departedHrIds: roster.filter((person) => !person.employmentActive)"), true, "the service hands the departed set to the evidence");
  const roster = stripComments(readFileSync("src/lib/field-absence/server/roster.ts", "utf8"));
  assert.equal(roster.includes("isActiveLifecycleStatus(employee.employmentStatus)"), true, "departed means what the CRM exclusion means: the employment status");

  // Someone who declined the offer never started: never on the calendar. A resignation is judged up to
  // the last working day instead (REP-D above), and a paid decline is filed as terminated.
  assert.equal(fieldAbsenceNeverStarted("declined_offer"), true);
  assert.equal(fieldAbsenceNeverStarted(" Declined_Offer "), true);
  for (const status of ["resigned", "terminated", "active", "on_leave", null]) {
    assert.equal(fieldAbsenceNeverStarted(status), false, `${status ?? "no status"} started work`);
  }
  assert.equal(
    roster.includes("if (employee && fieldAbsenceNeverStarted(employee.employmentStatus)) continue;"),
    true,
    "the roster leaves out a seat holder who never started",
  );
}

function runUnreadableSourceListsNobody() {
  for (const source of ["crm", "leave", "trips", "punch"] as const) {
    const calendar = build({ unreadable: [source] });
    assert.equal(calendar.judged, false, `an unreadable ${source} leaves the calendar unjudged`);
    assert.deepEqual(calendar.unreadable, [source]);
    assert.equal(
      calendar.days.reduce((sum, day) => sum + day.notSeen.length, 0),
      0,
      `with ${source} unreadable nobody may be listed — every name would be an accusation the system cannot back`,
    );
    assert.equal(calendar.people.some((row) => row.wholePeriod || row.longestRun > 0 || row.notSeenDates.length > 0), false);
    // The days are still drawn and counted, so the page can say what it could not judge.
    assert.equal(calendar.days.find((day) => day.date === "2026-10-12")!.expected, 5);
  }

  const partialHolidays = build({ holidaysComplete: false });
  assert.equal(partialHolidays.holidaysComplete, false, "an incomplete holiday calendar is carried to the screen, never swallowed");
}

function runPeriods() {
  const week = resolveFieldAbsencePeriod({ today: TODAY, view: "week", week: "2026-10-18" });
  assert.equal(week.start, "2026-10-17", "the week opens on Saturday");
  assert.equal(week.end, "2026-10-23");
  assert.equal(week.previous.week, "2026-10-10");
  assert.equal(week.next.week, "2026-10-24");

  const month = resolveFieldAbsencePeriod({ month: "2026-02", today: TODAY, view: "detail" });
  assert.equal(month.view, "detail");
  assert.equal(month.start, "2026-02-01");
  assert.equal(month.end, "2026-02-28");
  assert.equal(month.previous.month, "2026-01");
  assert.equal(month.next.month, "2026-03");

  const stale = resolveFieldAbsencePeriod({ month: "2026-13", today: TODAY, view: "nonsense", week: "not-a-day" });
  assert.equal(stale.view, "month", "a stale bookmark opens the month view");
  assert.equal(stale.month, "2026-10", "and the month holding today");
  assert.equal(stale.weekStart, "2026-10-17");
}

function runReach() {
  const roles: PhoenixRole[] = ["Super Admin", "CEO", "National Sales Manager", "SFE Manager"];
  const denied: PhoenixRole[] = ["Medical Rep", "District Manager", "Regional Manager", "Finance Manager", "HR Operations", "Product Manager"];

  for (const role of roles) {
    assert.equal(canReadFieldAbsence({ role }), true, `${role} is one of the owner's four`);
    assert.deepEqual(permissionMatrix[role].field_absence, ["read"], `${role} holds field_absence:read and nothing more`);
    assert.equal(isRolePermissionWithinHardBoundary(role, "field_absence", "export"), false, "the calendar is read only, for everyone");
  }
  for (const role of denied) {
    assert.equal(canReadFieldAbsence({ role }), false, `${role} must never open the list of names`);
    assert.equal(
      isRolePermissionWithinHardBoundary(role, "field_absence", "read"),
      false,
      `the hard boundary must refuse field_absence:read to ${role}, so an override cannot hand it out`,
    );
    assert.equal((permissionMatrix[role].field_absence ?? []).length, 0);
  }

  const seats = [
    { lineCode: "CNS", occupantHrId: "N-1", tier: "NSM" },
    { lineCode: "PEDIA", occupantHrId: "N-2", tier: "NSM" },
    { lineCode: "CNS", occupantHrId: "N-3", tier: "REP" },
  ];
  assert.deepEqual(resolveFieldAbsenceScope({ hrId: "x", role: "SFE Manager" }, seats), { basis: "company" });
  assert.deepEqual(resolveFieldAbsenceScope({ hrId: "n-1", role: "National Sales Manager" }, seats), { basis: "line", lineCodes: ["CNS"] });
  assert.deepEqual(
    resolveFieldAbsenceScope({ hrId: "N-3", role: "National Sales Manager" }, seats),
    { basis: "none" },
    "an NSM on no NSM seat reaches nobody — never the whole company",
  );
  assert.deepEqual(resolveFieldAbsenceScope({ hrId: "N-1", role: "District Manager" }, seats), { basis: "none" });
  const cns = resolveFieldAbsenceScope({ hrId: "N-1", role: "National Sales Manager" }, seats);
  assert.equal(scopeAdmitsLine(cns, "CNS"), true);
  assert.equal(scopeAdmitsLine(cns, "PEDIA"), false, "his own line only");
  assert.equal(scopeAdmitsLine(cns, null), false);
}

function runSourcesAndGates() {
  // "No submit vacation": a filed request takes the name off the day; a refused one gives it back.
  for (const status of ["approved", "pending_manager", "pending_hr"]) {
    assert.equal((FILED_VACATION_STATUSES as readonly string[]).includes(status), true, `a ${status} request is a record`);
  }
  for (const status of ["rejected", "cancelled"]) {
    assert.equal((FILED_VACATION_STATUSES as readonly string[]).includes(status), false, `a ${status} request is not a record`);
  }

  // A rep's free-text comment never reaches the page; the visit type and Phoenix CRM's count do.
  assert.equal(crmDayLabel("Regular Visit: the rep's own words here", "CRM visit"), "Regular visit in the old CRM");
  assert.equal(crmDayLabel("Phoenix CRM: 3 visits", "CRM visit"), "Phoenix CRM: 3 visits");
  assert.equal(crmDayLabel("a comment with no visit type", "CRM visit"), "CRM visit");
  assert.equal(crmDayLabel(undefined, "Leave recorded in the CRM"), "Leave recorded in the CRM");

  const evidenceSource = stripComments(readFileSync("src/lib/field-absence/server/evidence.ts", "utf8"));
  for (const reader of ["getCrmActivityDayMaps(", "loadFiledLeaveDays(", "loadOutstationTripDays(", "loadEmployeeDayPunchMinutes(", "loadCallRateHolidays("]) {
    assert.equal(evidenceSource.includes(reader), true, `the evidence must be read through ${reader.slice(0, -1)}, the reader the system already trusts`);
  }
  assert.equal(/weekly[-_]?plan|crm_plans/i.test(evidenceSource), false, "a weekly plan is never a record (owner, 2026-10-12)");
  assert.equal(evidenceSource.includes("Promise.allSettled("), true, "each source is read on its own, so one failure is named rather than fatal");

  // The grant and the four roles are checked before a single row is read.
  const service = stripComments(readFileSync("src/lib/field-absence/server/service.ts", "utf8"));
  const grant = service.indexOf('assertPermission(access, "field_absence", "read")');
  const roles = service.indexOf("canReadFieldAbsence(access)");
  const firstRead = service.indexOf("loadFieldAbsenceSeats(");
  assert.ok(grant > -1 && roles > -1 && firstRead > -1, "the service must check the grant, check the roles and read the seats");
  assert.ok(grant < firstRead && roles < firstRead, "the gate runs before the first read");

  for (const page of ["app/(admin)/admin/field-absence/page.tsx", "app/employee-portals/field-absence/page.tsx"]) {
    const source = stripComments(readFileSync(page, "utf8"));
    assert.equal(source.includes('canAccess(access, "field_absence", "read")'), true, `${page} names its own grant`);
    assert.equal(source.includes("loadFieldAbsencePage("), true, `${page} calls the one shared loader`);
  }
}

function runNavigation() {
  // A permission is not reach: each of the four must be offered a row in the shell it renders.
  const rows = (mode: "admin" | "employee-portal") =>
    getNavigationSections(mode)
      .flatMap((section) => section.items)
      .filter((item) => item.label === "Field Absence Calendar");

  const admin = rows("admin");
  for (const role of ["Super Admin", "CEO", "SFE Manager"] as const) {
    assert.equal(
      admin.some((item) => item.href === "/admin/field-absence" && (!item.roles || item.roles.includes(role))),
      true,
      `${role} must be offered the admin row`,
    );
  }
  const portal = rows("employee-portal");
  assert.equal(portal.some((item) => item.href === "/employee-portals/field-absence" && item.roles?.includes("National Sales Manager")), true);
  assert.equal(portal.some((item) => item.href.startsWith("/admin/")), false, "the portal catalog never carries an /admin/ href");

  assert.equal(
    resolvePortalTwin("/admin/field-absence", "National Sales Manager"),
    "/employee-portals/field-absence",
    "an NSM following an admin link lands on his own door, not on the portal home",
  );

  // The portal rail is built by hand and reads neither catalog — pin its row and its flag.
  const rail = stripComments(readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8"));
  assert.equal(rail.includes('showFieldAbsenceTab ? [{ href: "/employee-portals/field-absence"'), true);
  const flags = stripComments(readFileSync("src/lib/employee-portal/navigation.ts", "utf8"));
  assert.equal(flags.includes("showFieldAbsenceTab: isNationalSalesManager,"), true, "the rail row is the National Sales Manager's alone");
}

export function runFieldAbsenceCalendarTests() {
  runDayRules();
  runPersonSummaries();
  runSeenDaysStayOnTheSeat();
  runDepartedAgentsOwnVisits();
  runUnreadableSourceListsNobody();
  runPeriods();
  runReach();
  runSourcesAndGates();
  runNavigation();
}
