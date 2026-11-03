import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getNavigationSections } from "../src/config/system-navigation.ts";
import { HR_ROLE_BUNDLES, isSalaryBlindRole } from "../src/lib/auth/hr-functions.ts";
import { buildPermissionLookup, permissionMatrix } from "../src/lib/auth/permissions.ts";
import { isPageFencedForRole } from "../src/lib/auth/seat-page-fences.ts";
import {
  buildHrOperationsScoreboard,
  groupHrOperationsTiles,
  HR_OPERATIONS_TILE_GROUPS,
  joinerMarks,
  joinersDue,
  peopleLeaving,
} from "../src/lib/hr/hr-operations-overview-logic.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import { isPrivateCalendarGlobalViewer } from "../src/lib/private-calendar/logic.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE HR OPERATIONS SPECIALIST'S LANDING PAGE AND SIDEBAR (owner, 2026-11-03): "design it to be
 * identical in design and identy to the talnt acqyuisition and godmode premium polish it and add hr
 * calen dars and interview calendar and add some relevent modules in her account and side bar".
 *
 * Four things must stay true however the page is reworked: it is the Talent Acquisition page's own
 * parts, she stays salary-blind, she only VIEWS the Interview Calendar, and what the new grants carry
 * in that she was not given stays fenced.
 */

const SEAT = "HR Administration";
const PAGE = "src/components/hr/hr-operations-overview.tsx";
const LOADER = "src/lib/hr/hr-operations-overview.ts";
const ROUTE = "app/(admin)/admin/hr-command-center/page.tsx";

const code = (file: string) => stripComments(readFileSync(file, "utf8"));

function railHrefs(role: string): string[] {
  return getSections(
    getNavigationSections("hr"),
    "hr",
    buildPermissionLookup(permissionMatrix, role as never),
    role as never,
  ).flatMap((section) => section.items.map((item) => item.href));
}

function testTheRouteGivesHerThisPageByHerBundle() {
  const route = code(ROUTE);
  assert.match(route, /hrBundleForRole\(access\.role\) === HR_OPERATIONS_SPECIALIST_SEAT/, "split on her bundle, never a second list");
  assert.match(route, /<HrOperationsOverview data=\{data\} identity=\{identity\} \/>/, "the route renders her page");
  assert.match(route, /getHrOperationsOverview\(access,/, "and only her loader runs for her");
}

function testThePageIsTheTalentAcquisitionPagesOwnParts() {
  const page = code(PAGE);
  for (const part of ["PhoenixIdentityStrip", "TaScoreboard", "TaCommandRail", "MetricTile", "TaTodayInterviews", "TaDatedPeople", "TalentAcquisitionCalendar", "HrOnVacationToday", "HrMyRecord"]) {
    assert.ok(page.includes(`<${part}`), `her page draws the shared ${part}`);
  }
  assert.ok(!/function MetricTile|function KpiCard/.test(page), "a card is imported, never copied, so the two pages cannot drift");
  assert.ok(!page.includes("HrCommandCharts"), "the generic page's charts stay off, as on the Talent Acquisition page");
  assert.match(page, /hiredWindow=\{null\}/, "no Hired window: nothing on this seat counts hires");
  assert.ok(!/\brounded-(?!none)/.test(page), "square edges");
  assert.ok(!page.includes("overflow-x-auto"), "never a horizontal scroll");
  assert.ok(!page.includes("truncate"), "never an ellipsis");
}

function testNothingOnHerPageCarriesMoneyOrAnOffer() {
  const loader = code(LOADER);
  assert.ok(!loader.includes("listOffers"), "listOffers selects the letter's money; her joiners come from getHiringJoiners");
  assert.match(loader, /getHiringJoiners\(\)/, "the narrow joiner read");

  const leaving = peopleLeaving(
    [
      { effectiveDate: "2026-11-05", employeeName: "Going Soon", id: "1", jobTitle: "Accountant", settlement: { net: 999 }, status: "approved" } as never,
      { effectiveDate: "2026-11-06", employeeName: "Was Refused", id: "2", jobTitle: null, status: "rejected" },
      { effectiveDate: "2026-11-06", employeeName: "Called It Off", id: "3", jobTitle: null, status: "cancelled" },
      { effectiveDate: "2026-11-06", employeeName: "Already Gone", id: "4", jobTitle: null, status: "completed" },
      { effectiveDate: "2027-03-01", employeeName: "Far Off", id: "5", jobTitle: null, status: "submitted" },
    ],
    "2026-11-03",
  );
  assert.deepEqual(
    leaving.rows,
    [{ dateKey: "2026-11-05", href: "/hr/resignations", id: "1", name: "Going Soon", title: "Accountant" }],
    "only an open resignation inside the fortnight, and only its name, title and date: the settlement stays on the server",
  );

  const marks = joinerMarks([
    { mobile: "010", name: "Soon", notes: "private", offerId: "a", startKey: "2026-11-10", title: null } as never,
    { name: "No Day Yet", offerId: "b", startKey: "", title: "Rep" },
  ]);
  assert.deepEqual(
    marks,
    [{ dateKey: "2026-11-10", href: "/hr/hiring-documents", id: "a", name: "Soon", title: "" }],
    "a joiner reaches the page as name, title and day; one with no day yet has no place on a calendar",
  );
  assert.equal(isSalaryBlindRole(SEAT), true, "she is still the salary-blind seat");
}

function testAFailedReadIsNeverDrawnAsNobodyOrAsAZero() {
  assert.equal(joinersDue(null, "2026-11-03").loaded, false, "a failed joiner read is said on the panel");
  assert.equal(peopleLeaving(null, "2026-11-03").loaded, false, "and a failed resignations read");
  assert.equal(joinersDue([], "2026-11-03").loaded, true, "an empty list is a real answer");

  const all = buildHrOperationsScoreboard({
    joiners: { confirmed: 0, total: 0 },
    records: { active: 0, incomplete: 0 },
    reports: { reviewed: 0, toReview: 0 },
  });
  assert.equal(all.length, 3);
  for (const card of all) {
    assert.equal(card.rate, null, `${card.key}: nothing to divide by is a sentence, never 0%`);
    assert.ok(card.emptyLabel.length > 0);
  }
  assert.deepEqual(
    buildHrOperationsScoreboard({ joiners: null, records: null, reports: { reviewed: 3, toReview: 1 } }).map((card) => [card.key, card.rate]),
    [["reports-answered", 0.75]],
    "a source that did not load leaves its card out",
  );
  assert.equal(
    buildHrOperationsScoreboard({ joiners: null, records: { active: 10, incomplete: 4 }, reports: null })[0].numerator,
    6,
    "complete records are the active ones minus the incomplete",
  );
}

function testTheSixFiguresStandInThreeGroups() {
  const keys = HR_OPERATIONS_TILE_GROUPS.flatMap((group) => [...group.tileKeys]) as string[];
  assert.equal(keys.length, 6, "six figures across, as on the Talent Acquisition page");
  const tiles = [...keys, "no-manager", "contracts-hr", "hr-reports-submitted"].map((key) => ({ key }));
  const groups = groupHrOperationsTiles(tiles);
  assert.deepEqual(groups.map((group) => group.label), ["Review", "People", "Follow-ups"]);
  assert.equal(groups.flatMap((group) => group.tiles).length, 6, "a builder's other figures stay off this page");
  assert.deepEqual(
    groupHrOperationsTiles([{ key: "headcount" }]).map((group) => group.key),
    ["people"],
    "a group whose source did not load is left out, never a row of zeroes",
  );
}

function testSheOnlyViewsTheInterviewCalendar() {
  const page = code(PAGE);
  assert.match(page, /<TaTodayInterviews readOnly/, "today's panel never tells her to book");
  assert.match(
    code("src/lib/recruitment/interview-calendar.ts"),
    /if \(access\.role === "HR Administration"\) return false;\s+if \(isInterviewCalendarOwner\(access\)\) return true;/,
    "the request gate refuses her seat first: every page and the request route ask mayRequestInterviews",
  );
  assert.ok(!/press a free time|ask for an interview|Book on/i.test(page), "and no word on her page does");
  assert.match(
    code("src/components/hr/talent-acquisition/today-interviews.tsx"),
    /readOnly \? "Open the calendar" : "Book on the calendar"/,
    "the panel's quiet link follows the prop",
  );
}

function testHerSidebarHoldsTheCalendarsAndTheModules() {
  const rail = railHrefs(SEAT);
  for (const href of [
    "/hr/admin/hr-command-center",
    "/hr/hr-calendar",
    "/hr/admin/company-calendar",
    "/hr/recruitment/interview-calendar",
    "/hr/admin/private-calendars",
    "/hr/admin/weekly-plans/calendar",
    "/hr/reports/vacancies",
    "/hr/admin/vacation-report",
    "/hr/workspace/fingerprint-report",
  ]) {
    assert.ok(rail.includes(href), `${href} is on her sidebar`);
    assert.equal(isPageFencedForRole(SEAT as never, href), false, `${href} opens for her: a row must never bounce`);
  }
  assert.equal(
    rail.filter((href) => href === "/hr/recruitment/interview-calendar").length,
    1,
    "the Interview Calendar is one row",
  );
  // Every door on her page is a page on her sidebar.
  const doors = [...code(PAGE).matchAll(/\{ href: "([^"]+)", icon:/g)].map((match) => match[1]);
  assert.equal(doors.length, 5, "the five calendar doors");
  for (const door of doors) assert.ok(rail.includes(door), `${door} is a door she can walk through`);

  for (const href of ["/hr/spotlight", "/hr/admin/early-birds", "/hr/business-cards", "/hr/workspace"]) {
    assert.ok(!rail.includes(href), `${href} is not on her sidebar`);
  }
}

// The owner's "Open it for her" (2026-11-03). The row alone would land her on her own calendar, so the
// page's own rule must admit her, and it must not spread to the two seats that were never offered it.
function testPrivateCalendarsOpensForHerAndNoOtherNewSeat() {
  const viewer = (role: string) =>
    isPrivateCalendarGlobalViewer({ hrId: "TEST-1", loginId: "TEST-1", role, scope: "company" } as never, []);
  assert.equal(viewer(SEAT), true, "the page's own rule admits her, or the row bounces");
  assert.equal(viewer("HR Operations"), false, "HR Operations was not offered it");
  assert.equal(viewer("HR Advisory"), false, "HR Advisory was not offered it");
  assert.doesNotMatch(
    code("src/lib/private-calendar/export.ts"),
    /EGP|salary/i,
    "the calendar she can now export for anyone carries no pay",
  );
}

function testWhatTheNewGrantsCarryInStaysFenced() {
  const matrix = (permissionMatrix as unknown as Record<string, Record<string, readonly string[]>>)[SEAT];
  assert.deepEqual([...(matrix.hr_calendar ?? [])], ["read"], "the Company Calendar, to read");
  assert.deepEqual([...(matrix.weekly_plans ?? [])], ["read"], "the Planning Calendar, to read");
  assert.deepEqual([...(matrix.vacancies ?? [])], ["read"], "the Vacancies Report, to read");
  assert.equal(matrix.milestones, undefined, "Milestones widens only on his words naming it (2026-09-23)");
  assert.equal(matrix.spotlight, undefined, "Spotlight prints sales in EGP and stays shut");
  assert.ok(([...HR_ROLE_BUNDLES[SEAT]] as string[]).includes("hr_calendars"), "a seat grant, through a function");
  assert.ok(!([...HR_ROLE_BUNDLES[SEAT]] as string[]).includes("recognition"), "not the function that carries Spotlight");

  for (const path of [
    "/admin/field-workforce-compliance",
    "/admin/field-workforce-compliance/visits/B-1/2026-11-03",
    "/admin/crm-tools",
    "/admin/weekly-plans",
    "/admin/approvals/plan",
    "/admin/approvals/plan/1",
    "/admin/pm-products",
  ]) {
    assert.equal(isPageFencedForRole(SEAT as never, path), true, `${path} stays closed to her`);
  }
  assert.equal(isPageFencedForRole(SEAT as never, "/admin/weekly-plans/calendar"), false, "the Planning Calendar itself is hers");
}

export async function runHrOperationsOverviewTests() {
  testTheRouteGivesHerThisPageByHerBundle();
  testThePageIsTheTalentAcquisitionPagesOwnParts();
  testNothingOnHerPageCarriesMoneyOrAnOffer();
  testAFailedReadIsNeverDrawnAsNobodyOrAsAZero();
  testTheSixFiguresStandInThreeGroups();
  testSheOnlyViewsTheInterviewCalendar();
  testHerSidebarHoldsTheCalendarsAndTheModules();
  testPrivateCalendarsOpensForHerAndNoOtherNewSeat();
  testWhatTheNewGrantsCarryInStaysFenced();
}
