import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { ApiError } from "../src/lib/http/api-errors.ts";
import {
  buildDoubleVisitDays,
  countsAsManagersDoubleVisit,
  defaultDoubleVisitWeek,
  districtManagers,
  doubleVisitHalves,
  doubleVisitKey,
  doubleVisitOutcome,
  doubleVisitSummaryText,
  doubleVisitTeam,
  doubleVisitWeekName,
  doubleVisitWeeks,
  isDoubleVisitDayOpen,
  isDoubleVisitWeek,
  resolveDoubleVisitSlot,
  summarizeDoubleVisitWeek,
  type DoubleVisitStoredSlot,
} from "../src/lib/phoenix-crm/double-visit-plan-rules.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, personKey, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { testModeFor, testReadSeats, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import {
  assertDoubleVisitPlanWriter,
  doubleVisitPlanReach,
  resolveDoubleVisitPlanReader,
} from "../src/lib/phoenix-crm/server/double-visit-plans.ts";

/**
 * Phoenix CRM — the district manager's double-visit plan (owner, 2026-10-02).
 *
 * The district manager — an acting one too — plans, for the coming field week, which of HIS reps he
 * joins on which day, AM or PM. After the day each planned half-day reads done or not done, and the
 * week reads "Planned 3 · done 2". And, asked directly that day: "Rep does not see it".
 *
 * What this file pins:
 *   1. the rules — the weeks, the field day's halves (Thursday a morning, a holiday nothing), the days
 *      that can still change, one half-day checked before the database is asked, the team, and done
 *      as the manager report's own rule, judged only once the day's visits have closed;
 *   2. WHO reads and who writes: the rep is refused; the district manager reads and writes his OWN
 *      plan and nobody else's; another district manager is refused; SFE reads every one and writes
 *      none; the Super Admin reads every one and writes only in the test world; a test account works
 *      as its district manager in the test world only; a regional or national manager and the CEO
 *      are refused;
 *   3. the database half — RLS on, the service role only, `is_test` in the key, the Cairo day, and a
 *      half-day another screen changed refused rather than written over;
 *   4. that nothing the rep touches reads it, and that nothing about it notifies anyone.
 */

// ── The organogram the matrix runs on ───────────────────────────────────────────────────────────

function seat(overrides: Partial<OrgSeat> & Pick<OrgSeat, "seatId" | "tier" | "path">): OrgSeat {
  return {
    parentSeatId: overrides.path.length > 1 ? overrides.path[overrides.path.length - 2] : null,
    occupantHrId: null,
    lineCode: "anti_infective",
    lineName: "Anti Infective",
    areaName: null,
    regionName: null,
    seatLabel: null,
    ...overrides,
  };
}

const CEO = seat({ seatId: "SEAT-CEO", tier: "CEO", path: ["SEAT-CEO"], occupantHrId: "B-2", lineCode: null, lineName: null });
const NSM = seat({ seatId: "SEAT-AIF-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-AIF-NSM"], occupantHrId: "B-900" });
const DM1 = seat({ seatId: "SEAT-AIF-DM-D1", tier: "DM", path: [...NSM.path, "SEAT-AIF-DM-D1"], occupantHrId: "B-12", regionName: "Delta (1)" });
const D11 = seat({ seatId: "SEAT-AIF-REP-D11", tier: "REP", path: [...DM1.path, "SEAT-AIF-REP-D11"], occupantHrId: "B-7", areaName: "Menoufia 1", regionName: "Delta (1)" });
const D12 = seat({ seatId: "SEAT-AIF-REP-D12", tier: "REP", path: [...DM1.path, "SEAT-AIF-REP-D12"], occupantHrId: null, areaName: "Menoufia 2", regionName: "Delta (1)" });
const D13 = seat({ seatId: "SEAT-AIF-REP-D13", tier: "REP", path: [...DM1.path, "SEAT-AIF-REP-D13"], occupantHrId: "b-8", areaName: "Tanta", regionName: "Delta (1)" });
const DM2 = seat({ seatId: "SEAT-AIF-DM-D2", tier: "DM", path: [...NSM.path, "SEAT-AIF-DM-D2"], occupantHrId: "B-76", regionName: "Delta (2)" });
const D21 = seat({ seatId: "SEAT-AIF-REP-D21", tier: "REP", path: [...DM2.path, "SEAT-AIF-REP-D21"], occupantHrId: "B-21", areaName: "Mansoura", regionName: "Delta (2)" });
// The acting district manager, as production holds him: his acting seat under the national manager,
// and his own rep seat UNDER it.
const ADM = seat({ seatId: "SEAT-AIF-ADM-UE-1", tier: "ACTING_DM", path: [...NSM.path, "SEAT-AIF-ADM-UE-1"], occupantHrId: "B-1", regionName: "Upper Egypt 1" });
const UE1 = seat({ seatId: "SEAT-AIF-REP-UE1", tier: "REP", path: [...ADM.path, "SEAT-AIF-REP-UE1"], occupantHrId: "B-1", areaName: "Minia 1", regionName: "Upper Egypt 1" });
const UE2 = seat({ seatId: "SEAT-AIF-REP-UE2", tier: "REP", path: [...ADM.path, "SEAT-AIF-REP-UE2"], occupantHrId: null, areaName: "Minia 2", regionName: "Upper Egypt 1" });
const UE9 = seat({ seatId: "SEAT-AIF-REP-UE9", tier: "REP", path: [...ADM.path, "SEAT-AIF-REP-UE9"], occupantHrId: "AI-0012", areaName: "Beni Suef", regionName: "Upper Egypt 1" });
// A line that has not opened: SFE does not reach its district manager; the Super Admin does.
const CNS_NSM = seat({ seatId: "SEAT-CNS-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-CNS-NSM"], occupantHrId: "B-950", lineCode: "cns", lineName: "CNS" });
const CNS_DM = seat({ seatId: "SEAT-CNS-DM-C1", tier: "DM", path: [...CNS_NSM.path, "SEAT-CNS-DM-C1"], occupantHrId: "B-120", lineCode: "cns", lineName: "CNS", regionName: "Cairo" });
const C11 = seat({ seatId: "SEAT-CNS-REP-C11", tier: "REP", path: [...CNS_DM.path, "SEAT-CNS-REP-C11"], occupantHrId: "B-121", lineCode: "cns", lineName: "CNS", areaName: "Nasr City" });

const org = buildOrgIndex([CEO, NSM, DM1, D11, D12, D13, DM2, D21, ADM, UE1, UE2, UE9, CNS_NSM, CNS_DM, C11]);
const OPEN_LINES: ReadonlySet<string> = new Set(["anti_infective"]);

/** Friday 2 October 2026: the coming week is the week of Saturday 3 October. */
const FRIDAY = "2026-10-02";

type ViewerOptions = { superAdmin?: boolean; sfe?: boolean; testPersona?: boolean; canCreate?: boolean; canApprove?: boolean; company?: boolean; today?: string };

/** A viewer exactly as resolvePhoenixCrmViewer builds one: the matrix grants, the organogram scope, open lines. */
function viewerFor(hrId: string, role: string, options: ViewerOptions = {}): PhoenixCrmViewer {
  const company = Boolean(options.superAdmin || options.sfe || options.company);
  const scope = company ? org.territories : territoriesInScope(org, hrId, "tree");
  const isOpen = (entry: OrgSeat) => Boolean(entry.lineCode && OPEN_LINES.has(entry.lineCode));
  const held = ownTerritories(org, hrId);
  const today = options.today ?? FRIDAY;
  return {
    hrId: personKey(hrId),
    role,
    isSuperAdmin: options.superAdmin ?? false,
    isSfeManager: options.sfe ?? false,
    isTestPersona: options.testPersona ?? false,
    basis: company ? "all" : "tree",
    canCreate: options.canCreate ?? true,
    canApprove: options.canApprove ?? true,
    canUpdate: options.superAdmin ?? false,
    org,
    config: { lineRollout: [] },
    cairoToday: today,
    visitDay: today,
    openLines: OPEN_LINES,
    ownTerritories: held.filter(isOpen),
    waitingTerritories: held.filter((entry) => !isOpen(entry)),
    scopeTerritories: options.superAdmin ? scope : scope.filter(isOpen),
    waitingScopeTerritories: [],
    managerSeats: heldManagerSeats(org, hrId),
  } as unknown as PhoenixCrmViewer;
}

// The phoenix_crm grants per role (tests/phoenix-crm-boundary.test.ts GRANTS): create is a rep's and a
// district manager's and the Super Admin's; approve is every manager's and SFE's.
const rep = viewerFor("B-7", "Medical Rep", { canApprove: false });
const dm = viewerFor("B-12", "District Manager");
const otherDm = viewerFor("B-76", "District Manager");
const actingDm = viewerFor("B-1", "District Manager");
const nsm = viewerFor("B-900", "National Sales Manager", { canCreate: false });
const ceo = viewerFor("B-2", "CEO", { company: true, canCreate: false, canApprove: false });
const sfe = viewerFor("B-300", "SFE Manager", { sfe: true, canCreate: false });
const owner = viewerFor("B-10", "Super Admin", { superAdmin: true });
const testDm = viewerFor("B-12", "District Manager", { testPersona: true });
const testRep = viewerFor("B-7", "Medical Rep", { testPersona: true, canApprove: false });

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

function refused(run: () => unknown, status: number, pattern: RegExp, message: string): void {
  assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === status && pattern.test(error.message), message);
}

/** Every .ts/.tsx file under these folders, with forward slashes. */
function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

export function runPhoenixCrmDoubleVisitPlanTests(): void {
  // ── 1. The rules ──────────────────────────────────────────────────────────────────────────────
  {
    // The weeks: last week and this week to read, and the coming week — the one a rep plans too.
    assert.deepEqual(doubleVisitWeeks(FRIDAY), ["2026-09-19", "2026-09-26", "2026-10-03"], "on Friday 2 October the coming week is Saturday the 3rd's");
    assert.equal(defaultDoubleVisitWeek(FRIDAY), "2026-10-03", "the plan opens on the week he plans");
    assert.deepEqual(doubleVisitWeeks("2026-10-03"), ["2026-09-26", "2026-10-03", "2026-10-10"], "on the Saturday the week turns over");
    assert.equal(doubleVisitWeekName("2026-09-26", FRIDAY), "This week");
    assert.equal(doubleVisitWeekName("2026-10-03", FRIDAY), "Coming week");
    assert.equal(doubleVisitWeekName("2026-09-19", FRIDAY), "Last week");
    assert.equal(isDoubleVisitWeek("2026-10-10", FRIDAY), false, "never a week beyond the coming one");
    assert.equal(isDoubleVisitWeek("2026-09-12", FRIDAY), false, "and only the weeks offered");
    assert.equal(isDoubleVisitWeek("2026-10-04", FRIDAY), false, "a week is keyed by its Saturday");

    // The halves: the plan's own field week. Thursday is a morning, Friday holds nothing, nor a holiday.
    assert.deepEqual(doubleVisitHalves("2026-10-04", null), ["AM", "PM"], "a Sunday holds an AM and a PM double visit");
    assert.deepEqual(doubleVisitHalves("2026-10-08", null), ["AM"], "Thursday is a morning");
    assert.deepEqual(doubleVisitHalves("2026-10-09", null), [], "Friday is never a field day");
    assert.deepEqual(doubleVisitHalves("2026-10-08", "Armed Forces Day"), [], "a public holiday holds nothing");

    // The days that can still change: today onward, this week and the coming one only.
    assert.equal(isDoubleVisitDayOpen("2026-10-01", FRIDAY), false, "yesterday is read-only");
    assert.equal(isDoubleVisitDayOpen("2026-10-03", FRIDAY), true, "the coming week opens");
    assert.equal(isDoubleVisitDayOpen("2026-10-08", FRIDAY), true, "to its Thursday");
    assert.equal(isDoubleVisitDayOpen("2026-10-10", FRIDAY), false, "and not a day beyond it");
    assert.equal(isDoubleVisitDayOpen("2026-10-05", "2026-10-05"), true, "today is still his to change");
    assert.equal(isDoubleVisitDayOpen("2026-10-04", "2026-10-05"), false, "a day that has passed is fixed");
    assert.equal(isDoubleVisitDayOpen("2026-10-15", "2026-10-05"), true, "on Monday the coming week is the 10th's, to its Thursday");
    assert.equal(isDoubleVisitDayOpen("2026-10-17", "2026-10-05"), false, "and the week after it is not open yet");

    // The team: reps of his own district, never a vacant seat, never another district's, never his own.
    assert.deepEqual(
      doubleVisitTeam(org, "B-12", org.territories).map((entry) => entry.seatId),
      ["SEAT-AIF-REP-D11", "SEAT-AIF-REP-D13"],
      "the district manager joins his own reps — the vacant Menoufia 2 has nobody to join, Delta (2) is not his",
    );
    assert.deepEqual(
      doubleVisitTeam(org, "B-1", org.territories).map((entry) => entry.seatId),
      ["SEAT-AIF-REP-UE9"],
      "the acting district manager joins his rep, never his own territory under his acting seat",
    );
    assert.deepEqual(doubleVisitTeam(org, "b-12", org.territories).length, 2, "an hr id is compared as a person, never by its case");
    assert.deepEqual(doubleVisitTeam(org, "B-7", org.territories), [], "a rep has no team");
    assert.deepEqual(doubleVisitTeam(org, null, org.territories), [], "nobody has no team");
    assert.deepEqual(
      districtManagers(org).map((entry) => entry.hrId).sort(),
      ["B-1", "B-12", "B-120", "B-76"],
      "every district manager and acting district manager — never a national manager or the CEO",
    );
    assert.deepEqual(
      districtManagers(org, (entry) => Boolean(entry.lineCode && OPEN_LINES.has(entry.lineCode))).map((entry) => entry.hrId).sort(),
      ["B-1", "B-12", "B-76"],
      "narrowed to the open lines when asked",
    );

    // One half-day, checked before the database is asked.
    const team = doubleVisitTeam(org, "B-12", org.territories);
    const holidays = new Map<string, string>([["2026-10-08", "Armed Forces Day"]]);
    type SlotOverrides = Partial<{ date: unknown; half: unknown; seatId: unknown; expectedSeatId: unknown }>;
    const slot = (overrides: SlotOverrides) =>
      resolveDoubleVisitSlot({ date: "2026-10-04", half: "AM", seatId: D11.seatId, expectedSeatId: null, cairoToday: FRIDAY, holidays, team, ...overrides });
    const picked = slot({});
    assert.ok(picked.ok, "a rep of his team on a field day of the coming week saves");
    if (picked.ok) {
      assert.equal(picked.value.seat?.seatId, D11.seatId);
      assert.equal(picked.value.weekStart, "2026-10-03", "the week is the day's own field week");
      assert.equal(picked.value.expectedSeatId, null);
    }
    const refusalOf = (overrides: SlotOverrides) => {
      const result = slot(overrides);
      return result.ok ? "saved" : result.kind;
    };
    assert.equal(refusalOf({ date: "4 October" }), "bad_input", "a day that is not a day is refused");
    assert.equal(refusalOf({ half: "EVENING" }), "bad_input", "AM or PM, nothing else");
    assert.equal(refusalOf({ date: "2026-10-09" }), "not_field_time", "Friday is not a field day");
    assert.equal(refusalOf({ date: "2026-10-08", half: "PM" }), "not_field_time", "Thursday afternoon is not a field half-day");
    assert.equal(refusalOf({ date: "2026-10-01" }), "passed", "a day that has passed stays as planned");
    assert.equal(refusalOf({ date: "2026-10-10" }), "ahead", "never a week beyond the coming one");
    assert.equal(refusalOf({ date: "2026-10-08" }), "holiday", "a public holiday holds no double visit");
    assert.equal(refusalOf({ date: "2026-10-08", seatId: null, expectedSeatId: D11.seatId }), "saved", "but one planned on it before can still be cleared");
    assert.equal(refusalOf({ seatId: D21.seatId }), "not_team", "another district's rep is not his to join");
    assert.equal(refusalOf({ seatId: D12.seatId }), "not_team", "a vacant territory has nobody to join");
    assert.equal(refusalOf({ seatId: "" }), "saved", "an empty pick clears the half-day");
    const changed = slot({ expectedSeatId: ` ${D13.seatId} ` });
    assert.ok(changed.ok && changed.value.expectedSeatId === D13.seatId, "the rep the screen showed travels to the database, trimmed");

    // Done is the manager report's rule: the manager of a double or chain visit, or the senior of a chain.
    assert.equal(countsAsManagersDoubleVisit({ kind: "double", managerHrId: "B-12", seniorHrId: null }, "B-12"), true, "a double visit he was on");
    assert.equal(countsAsManagersDoubleVisit({ kind: "chain", managerHrId: "B-12", seniorHrId: "B-900" }, "B-12"), true, "a chain visit with him as the manager");
    assert.equal(countsAsManagersDoubleVisit({ kind: "chain", managerHrId: "B-1", seniorHrId: "B-12" }, "B-12"), true, "a chain visit with him as the senior");
    assert.equal(countsAsManagersDoubleVisit({ kind: "single", managerHrId: "B-12", seniorHrId: null }, "B-12"), false, "his own single visit on the seat has no rep on it");
    assert.equal(countsAsManagersDoubleVisit({ kind: "double", managerHrId: "B-76", seniorHrId: null }, "B-12"), false, "another manager's double visit is not his");
    assert.equal(countsAsManagersDoubleVisit({ kind: "double", managerHrId: "b-12", seniorHrId: null }, "B-12"), true, "an hr id is compared as a person");
    assert.equal(countsAsManagersDoubleVisit({ kind: "double", managerHrId: "B-12", seniorHrId: null }, null), false);

    // Judged only once the day's visits have closed (02:00 Cairo the next morning).
    assert.equal(doubleVisitOutcome({ date: "2026-10-04", done: true, cairoToday: "2026-10-04", visitDay: "2026-10-04" }), "done");
    assert.equal(doubleVisitOutcome({ date: "2026-10-04", done: false, cairoToday: "2026-10-04", visitDay: "2026-10-04" }), "open", "today is not over");
    assert.equal(
      doubleVisitOutcome({ date: "2026-10-04", done: false, cairoToday: "2026-10-05", visitDay: "2026-10-04" }),
      "open",
      "at 01:30 the rep may still log what they did together, so it is not 'not done' yet",
    );
    assert.equal(doubleVisitOutcome({ date: "2026-10-04", done: false, cairoToday: "2026-10-05", visitDay: "2026-10-05" }), "not_done", "from 02:00 it is");
    assert.equal(doubleVisitOutcome({ date: "2026-10-06", done: false, cairoToday: "2026-10-05", visitDay: "2026-10-05" }), "ahead", "a day to come is only planned");

    // The week: Saturday to Thursday, each half-day planned and how it went.
    const stored: DoubleVisitStoredSlot[] = [
      { date: "2026-10-03", half: "AM", seatId: D11.seatId, repHrId: "B-7" },
      { date: "2026-10-04", half: "PM", seatId: D13.seatId, repHrId: "B-8" },
      // Planned before the 8th was confirmed a holiday: it stays on screen, to be cleared.
      { date: "2026-10-08", half: "AM", seatId: D11.seatId, repHrId: "B-7" },
    ];
    const days = buildDoubleVisitDays({
      weekStart: "2026-10-03",
      cairoToday: "2026-10-05",
      visitDay: "2026-10-05",
      holidays,
      slots: stored,
      doneKeys: new Set([doubleVisitKey(D11.seatId, "2026-10-03", "AM"), doubleVisitKey(D11.seatId, "2026-10-04", "PM")]),
      canWrite: true,
    });
    assert.deepEqual(
      days.map((day) => day.date),
      ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"],
      "Saturday to Thursday, never the Friday",
    );
    assert.deepEqual(days.map((day) => day.editable), [false, false, true, true, true, true], "the days that have passed are read-only");
    const outcome = (date: string, half: "AM" | "PM") => days.find((day) => day.date === date)?.slots.find((entry) => entry.half === half)?.outcome;
    assert.equal(outcome("2026-10-03", "AM"), "done", "he was on a visit with that rep that morning");
    assert.equal(outcome("2026-10-04", "PM"), "not_done", "a visit with ANOTHER rep that evening does not do this one");
    assert.equal(outcome("2026-10-04", "AM"), null, "nothing planned, nothing judged");
    assert.equal(outcome("2026-10-08", "AM"), "ahead");
    const holiday = days.find((day) => day.date === "2026-10-08");
    assert.deepEqual(holiday?.halves, [], "the holiday holds nothing new");
    assert.deepEqual(holiday?.slots.map((entry) => entry.half), ["AM"], "but shows what was planned on it before");
    assert.equal(holiday?.holiday, "Armed Forces Day");
    assert.deepEqual(days.find((day) => day.date === "2026-10-05")?.slots.map((entry) => entry.half), ["AM", "PM"], "a working day offers both halves");
    const readOnly = buildDoubleVisitDays({ weekStart: "2026-10-03", cairoToday: "2026-10-05", visitDay: "2026-10-05", holidays, slots: stored, doneKeys: new Set(), canWrite: false });
    assert.ok(readOnly.every((day) => !day.editable), "nobody who only reads the plan can change a day of it");

    const summary = summarizeDoubleVisitWeek(days);
    assert.deepEqual(summary, { planned: 3, done: 1, notDone: 1 });
    assert.equal(doubleVisitSummaryText(summary), "Planned 3 · done 1", "the week at a glance, in the owner's words");
    assert.equal(doubleVisitSummaryText({ planned: 3, done: 2 }), "Planned 3 · done 2");
  }

  // ── 2. Who reads, who writes ──────────────────────────────────────────────────────────────────
  {
    // The rep — and a test account working as a rep — never reaches it.
    assert.equal(doubleVisitPlanReach(rep, false), null, "the rep is not offered the plan");
    refused(() => resolveDoubleVisitPlanReader(rep, false, null), 403, /district manager, SFE and the Super Admin/, "the rep is refused reading it");
    refused(() => resolveDoubleVisitPlanReader(rep, false, "B-12"), 403, /district manager, SFE and the Super Admin/, "even his own manager's, by name");
    refused(() => assertDoubleVisitPlanWriter(rep, false, null), 403, /district manager, SFE and the Super Admin/, "and refused writing it");
    assert.equal(doubleVisitPlanReach(testRep, testModeFor(testRep, false)), null, "a test account working as a rep is refused too");
    refused(() => resolveDoubleVisitPlanReader(testRep, true, null), 403, /district manager/, "in the test world as in the real one");

    // The district manager: his own plan, real entries, for his own team.
    assert.deepEqual(doubleVisitPlanReach(dm, false), { mode: "own", canWrite: true });
    const own = resolveDoubleVisitPlanReader(dm, false, null);
    assert.equal(own.managerHrId, "B-12", "he reads his own plan");
    assert.equal(resolveDoubleVisitPlanReader(dm, false, "b-12").managerHrId, "B-12", "named by himself, in any case");
    assert.equal(assertDoubleVisitPlanWriter(dm, false, null), "B-12", "he writes his own plan");
    refused(() => resolveDoubleVisitPlanReader(dm, false, "B-76"), 403, /their own/, "never another district manager's plan");
    refused(() => assertDoubleVisitPlanWriter(dm, false, "B-76"), 403, /their own/, "and never writes one");
    // Retired 2026-10-03: a `test` flag from anyone but a TEST- login is READ AND DROPPED, not
    // refused — a 403 here would blank a tab that was open across the deploy.
    assert.equal(testModeFor(dm, "true"), false, "the test world is nobody's now");
    assert.deepEqual(
      doubleVisitTeam(org, "B-12", testReadSeats(dm, false, dm.scopeTerritories)).map((entry) => entry.seatId),
      [D11.seatId, D13.seatId],
      "his team is read out of his own scope",
    );

    // Another district manager is refused the first one's plan, and reads his own.
    refused(() => resolveDoubleVisitPlanReader(otherDm, false, "B-12"), 403, /their own/, "another district manager is refused");
    assert.equal(resolveDoubleVisitPlanReader(otherDm, false, null).managerHrId, "B-76", "and reads his own");
    assert.deepEqual(doubleVisitTeam(org, "B-76", otherDm.scopeTerritories).map((entry) => entry.seatId), [D21.seatId]);

    // The acting district manager: app role District Manager on an acting seat — a planner too.
    assert.deepEqual(doubleVisitPlanReach(actingDm, false), { mode: "own", canWrite: true }, "an acting district manager plans their own");
    assert.deepEqual(
      doubleVisitTeam(org, "B-1", testReadSeats(actingDm, false, actingDm.scopeTerritories)).map((entry) => entry.seatId),
      [UE9.seatId],
      "with his rep, never himself",
    );
    assert.equal(doubleVisitPlanReach(viewerFor("B-7", "District Manager"), false), null, "the app role alone, with no district seat, plans nothing");

    // The national manager and the CEO read the Team tab, never this plan.
    assert.equal(doubleVisitPlanReach(nsm, false), null, "a national manager is not offered it");
    refused(() => resolveDoubleVisitPlanReader(nsm, false, "B-12"), 403, /district manager, SFE/, "and is refused");
    assert.equal(doubleVisitPlanReach(ceo, false), null, "the CEO is not offered it");
    refused(() => resolveDoubleVisitPlanReader(ceo, false, null), 403, /district manager, SFE/, "and is refused");
    refused(() => assertDoubleVisitPlanWriter(nsm, false, null), 403, /district manager, SFE/, "neither writes one");

    // SFE reads every district manager's plan, real entries, on the open lines — and writes none.
    assert.deepEqual(doubleVisitPlanReach(sfe, false), { mode: "pick", canWrite: false }, "SFE reads, read only");
    const sfeList = resolveDoubleVisitPlanReader(sfe, false, null);
    assert.equal(sfeList.managerHrId, null, "SFE chooses whose plan to read");
    assert.deepEqual(sfeList.managers?.map((entry) => entry.hrId).sort(), ["B-1", "B-12", "B-76"], "every district manager of the open lines");
    assert.equal(resolveDoubleVisitPlanReader(sfe, false, "B-12").managerHrId, "B-12", "SFE reads a district manager's plan");
    refused(() => resolveDoubleVisitPlanReader(sfe, false, "B-120"), 404, /organogram/, "never one on a line that has not opened");
    refused(() => resolveDoubleVisitPlanReader(sfe, false, "B-900"), 404, /organogram/, "and never a national manager's, who has none");
    refused(() => assertDoubleVisitPlanWriter(sfe, false, "B-12"), 403, /Each district manager plans their own/, "SFE never writes one");
    assert.equal(testModeFor(sfe, "true"), false, "and has no test world either");

    // The Super Admin reads every one and writes none — his test mode is RETIRED (owner, 2026-10-03:
    // "the test in the phoenix crm is now irrelevant, u can fully retire it"). He used to write a
    // half-day as the district manager he picked, in the test world; a half-day is that district
    // manager's own, and the refusal says so instead of naming a control that no longer exists.
    assert.deepEqual(doubleVisitPlanReach(owner, false), { mode: "pick", canWrite: false }, "real entries: he reads, read only");
    assert.equal(resolveDoubleVisitPlanReader(owner, false, "B-120").managerHrId, "B-120", "every district, open line or not");
    for (const named of ["B-12", null, "B-900"] as const) {
      refused(
        () => assertDoubleVisitPlanWriter(owner, false, named),
        403,
        /does not plan a district manager's double visits/,
        `never a real entry, whoever he names (${named ?? "nobody"})`,
      );
    }
    assert.deepEqual(
      doubleVisitTeam(org, "B-120", testReadSeats(owner, true, owner.scopeTerritories)).map((entry) => entry.seatId),
      [C11.seatId],
      "in the test world his team reaches any territory, as every test entry of the Super Admin's does",
    );

    // A test account works as the district manager it mirrors — in the test world, whatever the screen sent.
    assert.equal(testModeFor(testDm, false), true, "a test account is in the test world, always");
    assert.deepEqual(doubleVisitPlanReach(testDm, true), { mode: "own", canWrite: true }, "it plans as the district manager it mirrors");
    assert.equal(doubleVisitPlanReach(testDm, false), null, "and never in the real world");
    assert.equal(assertDoubleVisitPlanWriter(testDm, true, null), "B-12", "his own plan, in the test world");
    refused(() => assertDoubleVisitPlanWriter(testDm, true, "B-76"), 403, /their own/, "never another district manager's");
  }

  // ── 3. The database half ──────────────────────────────────────────────────────────────────────
  {
    const path = "supabase/migrations/20261002120003_phoenix_crm_double_visit_plans.sql";
    const sql = stripSqlComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    assert.match(sql, /create table if not exists public\.phoenix_crm_double_visit_plans \(/, "one table of its own");
    assert.match(sql, /\n\s*is_test boolean not null default false,\n/, "the test world, as on every Phoenix CRM table");
    assert.match(
      sql,
      /create unique index if not exists phoenix_crm_double_visit_plans_slot_uniq\s+on public\.phoenix_crm_double_visit_plans \(manager_hr_id, plan_date, half, is_test\);/,
      "one rep a half-day a manager, per world — a test entry never collides with a real one",
    );
    assert.match(sql, /constraint phoenix_crm_double_visit_plans_half check \(half in \('AM', 'PM'\)\)/);
    assert.match(sql, /constraint phoenix_crm_double_visit_plans_in_week check \(plan_date between week_start and week_start \+ 5\)/, "never a Friday");
    assert.match(sql, /constraint phoenix_crm_double_visit_plans_thursday_am check \(not \(extract\(isodow from plan_date\) = 4 and half = 'PM'\)\)/, "Thursday is a morning");

    // Locked to the service role: RLS on, the browser roles revoked.
    assert.ok(sql.includes("alter table public.phoenix_crm_double_visit_plans enable row level security;"), "RLS is on");
    assert.ok(
      sql.includes("create policy phoenix_crm_double_visit_plans_service_role\n  on public.phoenix_crm_double_visit_plans for all to service_role using (true) with check (true);"),
      "the one policy names the service role",
    );
    assert.ok(sql.includes("revoke all on table public.phoenix_crm_double_visit_plans from public, anon, authenticated;"), "the browser roles hold nothing");
    assert.ok(sql.includes("grant all on table public.phoenix_crm_double_visit_plans to service_role;"), "the service role holds it");
    assert.doesNotMatch(sql, /\bgrant\b[^;]*\bto\s+[^;]*\b(?:anon|authenticated|public)\b/i, "nothing is granted to a browser role");

    // The one function: SECURITY DEFINER, a fixed search path, the service role only.
    const start = sql.indexOf("create or replace function public.phoenix_crm_save_double_visit_slot(p jsonb)");
    assert.ok(start >= 0, "the save function is there");
    const fn = sql.slice(start, sql.indexOf("\n$$;", start));
    assert.match(fn, /\nsecurity definer\nset search_path to 'public'\nas \$\$/, "SECURITY DEFINER with its search path fixed");
    assert.ok(sql.includes("revoke execute on function public.phoenix_crm_save_double_visit_slot(jsonb) from public, anon, authenticated;"));
    assert.ok(sql.includes("grant execute on function public.phoenix_crm_save_double_visit_slot(jsonb) to service_role;"));
    assert.match(fn, /\n\s*v_today date := \(now\(\) at time zone 'Africa\/Cairo'\)::date;\n/, "the Cairo day, stated");
    assert.doesNotMatch(sql, /\bcurrent_date\b/i, "never the database's UTC day");
    assert.match(fn, /v_is_test boolean := coalesce\(\(p ->> 'is_test'\)::boolean, false\);/, "the world comes from the server");
    assert.match(
      fn,
      /if extract\(isodow from v_date\) = 5 or \(extract\(isodow from v_date\) = 4 and v_half = 'PM'\) then\s+raise exception 'phoenix_crm:double_visit_not_field_time';/,
      "a Friday and a Thursday afternoon are refused in the database too",
    );
    assert.match(fn, /if v_date < v_today then\s+raise exception 'phoenix_crm:double_visit_day_passed';/, "a day that has passed keeps its plan");
    assert.match(fn, /if v_week > v_this_week \+ 7 then\s+raise exception 'phoenix_crm:double_visit_week_ahead';/, "never a week beyond the coming one");
    assert.match(
      fn,
      /pg_advisory_xact_lock\(\s*hashtext\('phoenix_crm:double_visit:' \|\| v_manager \|\| ':' \|\| v_date::text \|\| ':' \|\| v_half \|\| ':' \|\| v_is_test::text\)\s*\);/,
      "one half-day at a time, per world",
    );
    assert.match(
      fn,
      /if \(case when v_found then v_row\.seat_id else null end\) is distinct from v_expected then\s+raise exception 'phoenix_crm:double_visit_changed';/,
      "a half-day another screen changed first is refused, never written over",
    );
    assert.ok(fn.indexOf("double_visit_changed") < fn.indexOf("delete from public.phoenix_crm_double_visit_plans"), "the check comes before any write");
    const writes = [...fn.matchAll(/\b(insert\s+into|delete\s+from|update)\s+([a-z_][a-z_0-9.]*)/gi)].map((match) => match[2]);
    assert.deepEqual([...new Set(writes)], ["public.phoenix_crm_double_visit_plans"], "it writes its own table and nothing else");
    assert.doesNotMatch(sql, /notification|pg_notify/i, "and tells nobody");

    // Its refusals read as sentences on the screen.
    const db = source("src/lib/phoenix-crm/server/db.ts");
    for (const code of ["double_visit_not_field_time", "double_visit_day_passed", "double_visit_week_ahead", "double_visit_changed"]) {
      assert.ok(fn.includes(`'phoenix_crm:${code}'`), `the function raises ${code}`);
      assert.match(db, new RegExp(`\\n\\s*${code}: \\{`), `${code} has its sentence in REFUSALS`);
    }
  }

  // ── 4. Nothing the rep touches reads it, and nothing about it tells anyone ────────────────────
  {
    const files = [...walk("src"), ...walk("app")];
    assert.ok(files.length > 1000, `the scan found only ${files.length} files — it has stopped seeing the code`);
    const raw = new Map<string, string>();
    for (const file of files) raw.set(file, readFileSync(file, "utf8"));
    const holding = (needle: string) => files.filter((file) => (raw.get(file) ?? "").includes(needle)).sort();

    assert.deepEqual(
      holding("phoenix_crm_double_visit_plans"),
      ["src/lib/phoenix-crm/server/double-visit-plans.ts"],
      "the table is read and written by its own service and nowhere else — no rep screen, no report, no digest",
    );
    // 🔴 RETIRED 2026-10-16: the district manager's weekly plan (`manager-plans.ts`) replaced this planner.
    // Its Team-tab section is gone and its POST answers 410; the GET and the table stay, so a week planned
    // here can still be read, and the Visit report still shows those weeks beside the new plan's.
    assert.deepEqual(
      holding("@/lib/phoenix-crm/server/double-visit-plans"),
      [
        "app/api/phoenix-crm/double-visit-plans/route.ts",
        // Expense Approvals' Phoenix CRM evidence (2026-11-07) reads one person's ride-along days through the
        // service's own `readDoubleVisitPlansForTrip`; that reading is the Super Admin approver's alone.
        "src/lib/outstation/crm-trip-evidence-reader.ts",
        // The Visit report generator's loader (2026-10-15) reads the plans through the service's own
        // `readDoubleVisitPlansForReport`; the screen is the Super Admin's and the SFE Manager's alone.
        "src/lib/phoenix-crm/server/visit-report.ts",
        "src/lib/phoenix-crm/view-types.ts",
      ],
      "the service is reached by its route, the Super Admin's visit report and the type names only — the Team tab no longer asks it",
    );
    assert.deepEqual(holding("@/components/phoenix-crm/double-visit-plan-section"), [], "no screen draws the retired planner");
    assert.deepEqual(holding("DoubleVisitPlanSection"), [], "and its section is gone, not hidden");
    assert.deepEqual(
      holding("/api/phoenix-crm/double-visit-plans"),
      ["src/lib/security/access-registry.ts"],
      "no screen calls the retired route; the registry still names it, because the GET still answers",
    );
    assert.deepEqual(
      holding("@/lib/phoenix-crm/double-visit-plan-rules"),
      [
        // The weekly plan reuses its district-manager list and its "counts as his double visit" rule; since
        // 2026-10-17 the report reaches that rule through `countsAsPlannersVisitWithRep` in the rules file.
        "src/lib/phoenix-crm/manager-plan-rules.ts",
        "src/lib/phoenix-crm/server/double-visit-plans.ts",
        "src/lib/phoenix-crm/server/manager-plan-reach.ts",
        // The manager's visit details name a ride-along by the same rule the calendar cell counts it by (2026-10-20).
        "src/lib/phoenix-crm/server/manager-visit-details.ts",
        // The team calendar draws a manager's ride-alongs by the same "counts as his double visit" rule (2026-10-19).
        "src/lib/phoenix-crm/server/team-calendar.ts",
      ],
      "the rules are read by the service, by the weekly plan that replaced it, by the team calendar's manager rows and by the manager's visit details",
    );

    // No notice of any kind: the service and its route import nothing that sends one.
    for (const file of ["src/lib/phoenix-crm/server/double-visit-plans.ts", "app/api/phoenix-crm/double-visit-plans/route.ts"]) {
      const text = source(file);
      assert.doesNotMatch(text, /@\/lib\/notifications|server\/notifications|notifyPhoenixCrm|sendEmail|telegram/i, `${file} tells nobody`);
    }

    // Done reads what every KPI reads: the countable visits, validated customers, one world.
    const service = source("src/lib/phoenix-crm/server/double-visit-plans.ts");
    const doneReader = service.slice(service.indexOf("async function loadDoneKeys"), service.indexOf("function storedSlotOf"));
    assert.ok(doneReader.includes('.from("phoenix_crm_countable_visits_with_history")'), "done is read from the countable visits — an off-plan visit counts once approved");
    assert.ok(doneReader.includes('.eq("customer_validated", true)'), "on validated customers, as the manager report counts them");
    assert.ok(doneReader.includes('.eq("is_test", isTest)'), "in one world");
    assert.equal(doneReader.includes('.from("phoenix_crm_visits")'), false, "never the raw visits");
    assert.ok(doneReader.includes("countsAsManagersDoubleVisit(visit, manager)"), "and the manager report's own rule decides which visits are his");
    const planReader = service.slice(service.indexOf("async function loadPlanRows"), service.indexOf("async function loadDoneKeys"));
    assert.ok(planReader.includes('.eq("is_test", isTest)'), "the plan is read in one world");
    assert.match(service, /export async function loadDoubleVisitPlan[\s\S]*?const isTest = testModeFor\(viewer, raw\.test\);\s+const reader = resolveDoubleVisitPlanReader\(/, "a read is gated before anything is loaded");
    assert.match(
      service,
      /export async function saveDoubleVisitSlot[\s\S]*?const isTest = testModeFor\(viewer, body\.test\);\s+const managerHrId = assertDoubleVisitPlanWriter\(viewer, isTest, body\.manager\);/,
      "a write is gated before anything is read or written",
    );

    // The Team tab no longer carries the planner: the district manager's weekly plan took its place there.
    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.equal(team.includes("doubleVisitPlanReach"), false, "the Team view no longer asks for the retired planner's reach");
    assert.ok(team.includes("managerPlans: (() => {"), "it carries the weekly plan's reach instead");

    // The route: `read` to look, `create` to write, the origin checked first — and the registry agrees.
    const route = source("app/api/phoenix-crm/double-visit-plans/route.ts");
    assert.match(route, /export async function GET[\s\S]*?await assertPermission\(access, "phoenix_crm", "read"\);[\s\S]*?loadDoubleVisitPlan\(/);
    assert.match(
      route,
      /export async function POST[\s\S]*?const csrf = assertSameOriginMutation\(request\);[\s\S]*?await assertPermission\(access, "phoenix_crm", "create"\);[\s\S]*?error: "superseded"[\s\S]*?\{ status: 410 \}/,
      "a save answers 410 superseded, behind the same gate a save had",
    );
    assert.equal(route.includes("saveDoubleVisitSlot("), false, "and writes nothing");
  }
}
