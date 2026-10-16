import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { PHOENIX_CRM_EMAIL_EVENT_TYPES, PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import {
  dmPlansInPhoenixCrmFor,
  flagManagerCustomer,
  halfOfListType,
  isManagerDayOpen,
  managerDayHalves,
  managerOutcome,
  managerOwnVisitClosed,
  managerPlanApprovers,
  managerPlanSeats,
  managerPlanStatusLine,
  managerPlanSummaryText,
  managerPlanWeeks,
  managerWeekState,
  matchCustomerName,
  nextManagerPlanStatus,
  parseManagerSlotDraft,
} from "../src/lib/phoenix-crm/manager-plan-rules.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, personKey, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import type { PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import {
  assertManagerPlanWriter,
  managerDistrictSeats,
  managerPlanDeciderRole,
  managerPlanReach,
  managerTeamSeats,
  readsManagerPlanOf,
  resolveManagerPlanReader,
} from "../src/lib/phoenix-crm/server/manager-plan-reach.ts";

/**
 * Phoenix CRM — the district manager's weekly plan (owner, 2026-10-16, five rounds in chat).
 *
 * His week is the rep's numbered form inverted: each half-day is WITH A REP (ticking that rep's own
 * customers), ADMIN (one of the seven activities) or a SINGLE VISIT (an area of his district). It is
 * approved by his RSM or NSM in the Approvals Hub, Hany Saad's district managers then by Ali Mohamed Ali,
 * and the Administrator may act in place of either. The rep never sees it.
 *
 * What this file pins:
 *   1. the rules — the weeks, the field day's halves, the three kinds read strictly, the chain with its
 *      second stage, the state machine, the flags on a ticked customer, the outcome, the name match;
 *   2. WHO reads, writes and decides — a rep is refused; the district manager writes his own; the acting
 *      district manager who also holds a rep seat plans both, and her own rep seat is never one of "her
 *      reps"; his RSM/NSM, SFE, the CEO and the Super Admin read; the Administrator decides in place;
 *   3. the database half — RLS on every table, the service role only, `is_test` in the week key, a
 *      Thursday a morning and never a Friday, no foreign key to the rep's plan items;
 *   4. nothing outside the module reads the tables, and nothing reads his visits into a KPI;
 *   5. no email, ever, and the Hub counts each week once;
 *   6. the legacy form refuses a switched district manager, his Plans tab goes and his calendar stays;
 *   7. the old "My own visit" is closed for a district manager.
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
const D11 = seat({ seatId: "SEAT-AIF-REP-D11", tier: "REP", path: [...DM1.path, "SEAT-AIF-REP-D11"], occupantHrId: "B-7", areaName: "Menoufia 1" });
const D12 = seat({ seatId: "SEAT-AIF-REP-D12", tier: "REP", path: [...DM1.path, "SEAT-AIF-REP-D12"], occupantHrId: null, areaName: "Menoufia 2" });
const DM2 = seat({ seatId: "SEAT-AIF-DM-D2", tier: "DM", path: [...NSM.path, "SEAT-AIF-DM-D2"], occupantHrId: "B-76", regionName: "Delta (2)" });
const D21 = seat({ seatId: "SEAT-AIF-REP-D21", tier: "REP", path: [...DM2.path, "SEAT-AIF-REP-D21"], occupantHrId: "B-21", areaName: "Mansoura" });
// The acting district manager, as production holds her: her acting seat, and her own rep seat UNDER it.
const ADM = seat({ seatId: "SEAT-AIF-ADM-UE-1", tier: "ACTING_DM", path: [...NSM.path, "SEAT-AIF-ADM-UE-1"], occupantHrId: "B-1", regionName: "Upper Egypt 1" });
const UE1 = seat({ seatId: "SEAT-AIF-REP-UE1", tier: "REP", path: [...ADM.path, "SEAT-AIF-REP-UE1"], occupantHrId: "B-1", areaName: "Minia 1" });
const UE2 = seat({ seatId: "SEAT-AIF-REP-UE2", tier: "REP", path: [...ADM.path, "SEAT-AIF-REP-UE2"], occupantHrId: null, areaName: "Minia 2" });
const UE9 = seat({ seatId: "SEAT-AIF-REP-UE9", tier: "REP", path: [...ADM.path, "SEAT-AIF-REP-UE9"], occupantHrId: "AI-0012", areaName: "Beni Suef" });
// Hany Saad's line: his district managers' weeks go on to Ali Mohamed Ali (plan-second-approver.ts).
const HANY = seat({ seatId: "SEAT-PED-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-PED-NSM"], occupantHrId: "PD-0001", lineCode: "pedia", lineName: "Pedia" });
const PDM = seat({ seatId: "SEAT-PED-DM-1", tier: "DM", path: [...HANY.path, "SEAT-PED-DM-1"], occupantHrId: "PD-0040", lineCode: "pedia", lineName: "Pedia", regionName: "Alex" });
const P11 = seat({ seatId: "SEAT-PED-REP-11", tier: "REP", path: [...PDM.path, "SEAT-PED-REP-11"], occupantHrId: "PD-0041", lineCode: "pedia", lineName: "Pedia", areaName: "Smouha" });

const org = buildOrgIndex([CEO, NSM, DM1, D11, D12, DM2, D21, ADM, UE1, UE2, UE9, HANY, PDM, P11]);

/** Friday 16 October 2026: the coming week is the week of Saturday 17 October. */
const FRIDAY = "2026-10-16";

type ViewerOptions = { superAdmin?: boolean; sfe?: boolean; testPersona?: boolean; canCreate?: boolean; canApprove?: boolean; company?: boolean };

/** A viewer as resolvePhoenixCrmViewer builds one: the matrix grants and the organogram scope. */
function viewerFor(hrId: string, role: string, options: ViewerOptions = {}): PhoenixCrmViewer {
  const company = Boolean(options.superAdmin || options.sfe || options.company);
  const scope = company ? org.territories : territoriesInScope(org, hrId, "tree");
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
    cairoToday: FRIDAY,
    visitDay: FRIDAY,
    openLines: new Set(["anti_infective", "pedia"]),
    ownTerritories: ownTerritories(org, hrId),
    waitingTerritories: [],
    scopeTerritories: scope,
    waitingScopeTerritories: [],
    managerSeats: heldManagerSeats(org, hrId),
  } as unknown as PhoenixCrmViewer;
}

const rep = viewerFor("B-7", "Medical Rep", { canApprove: false });
const dm = viewerFor("B-12", "District Manager");
const otherDm = viewerFor("B-76", "District Manager");
const actingDm = viewerFor("B-1", "District Manager");
const nsm = viewerFor("B-900", "National Sales Manager", { canCreate: false });
const hany = viewerFor("PD-0001", "National Sales Manager", { canCreate: false });
const ceo = viewerFor("B-2", "CEO", { company: true, canCreate: false, canApprove: false });
const sfe = viewerFor("B-300", "SFE Manager", { sfe: true, canCreate: false });
const owner = viewerFor("B-10", "Super Admin", { superAdmin: true });
const testNsm = viewerFor("B-900", "National Sales Manager", { canCreate: false, testPersona: true });

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

/** One top-level function's body: from its declaration to the next top-level `export` or `function`. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must exist`);
  const rest = text.slice(start + declaration.length);
  const next = rest.search(/\n(export |async function |function )/);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function filesUnder(dir: string): string[] {
  const root = new URL(`../${dir}/`, import.meta.url);
  const out: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(new URL(relative, root), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const next = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(`${next.replace(/\\/g, "/")}/`);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(`${dir}/${next.replace(/\\/g, "/")}`);
    }
  };
  walk("");
  return out;
}

const MANAGER_TABLES = [
  "phoenix_crm_manager_plans",
  "phoenix_crm_manager_customers",
  "phoenix_crm_manager_plan_slots",
  "phoenix_crm_manager_plan_customers",
  "phoenix_crm_manager_plan_events",
  "phoenix_crm_manager_plan_edit_requests",
  "phoenix_crm_manager_visits",
] as const;

const MANAGER_FUNCTIONS = [
  "phoenix_crm_save_manager_plan_slot",
  "phoenix_crm_manager_plan_transition",
  "phoenix_crm_raise_manager_plan_edit",
  "phoenix_crm_decide_manager_plan_edit",
  "phoenix_crm_expire_manager_plan_edit_requests",
  "phoenix_crm_request_manager_customer_removal",
  "phoenix_crm_decide_manager_customer_removal",
  "phoenix_crm_merge_duplicate_customer",
] as const;

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

export async function runPhoenixCrmManagerPlanTests(): Promise<void> {
  // ── 1. The rules ──────────────────────────────────────────────────────────────────────────────

  // One week: the coming Saturday's. On a Thursday the week he is in still has its morning, so it is
  // offered too (sent late, stamped late); on the Friday it is gone.
  assert.deepEqual(managerPlanWeeks(FRIDAY), ["2026-10-17"], "on a Friday only the coming week is offered");
  assert.deepEqual(managerPlanWeeks("2026-10-15"), ["2026-10-10", "2026-10-17"], "on the Thursday the week he is in is still offered, beside the coming one");
  assert.equal(managerWeekState({ weekStart: "2026-10-17", cairoToday: FRIDAY, status: null, editAsked: false }), "plan");
  assert.equal(managerWeekState({ weekStart: "2026-10-17", cairoToday: FRIDAY, status: "submitted", editAsked: false }), "sent");
  assert.equal(managerWeekState({ weekStart: "2026-10-17", cairoToday: FRIDAY, status: "approved", editAsked: true }), "asked");
  assert.equal(managerWeekState({ weekStart: "2026-10-03", cairoToday: FRIDAY, status: null, editAsked: false }), "closed", "a week that has passed is closed");
  assert.equal(managerWeekState({ weekStart: "2026-10-24", cairoToday: FRIDAY, status: null, editAsked: false }), "closed", "never a week after the coming one");

  // The field day's halves: Saturday to Wednesday AM and PM, Thursday a morning, never a Friday, a holiday nothing.
  assert.deepEqual(managerDayHalves("2026-10-17", null), ["AM", "PM"], "Saturday holds a morning and an evening");
  assert.deepEqual(managerDayHalves("2026-10-22", null), ["AM"], "Thursday holds a morning only");
  assert.deepEqual(managerDayHalves("2026-10-23", null), [], "Friday holds nothing");
  assert.deepEqual(managerDayHalves("2026-10-18", "Armed Forces Day"), [], "a public holiday holds nothing");
  assert.equal(isManagerDayOpen({ date: "2026-10-23", cairoToday: FRIDAY, returnedDay: null, holiday: null }), false, "a Friday is never open");
  assert.equal(isManagerDayOpen({ date: "2026-10-15", cairoToday: FRIDAY, returnedDay: null, holiday: null }), false, "a day that has passed is never open");
  assert.equal(isManagerDayOpen({ date: "2026-10-19", cairoToday: FRIDAY, returnedDay: "2026-10-20", holiday: null }), false, "while one day is returned, only that day opens");
  assert.equal(isManagerDayOpen({ date: "2026-10-20", cairoToday: FRIDAY, returnedDay: "2026-10-20", holiday: null }), true);

  // The three kinds, read strictly: each carries its own fields and nothing else.
  const withRep = parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "with_rep", repSeatId: D11.seatId, customers: [{ customerId: UUID_A }, { customerId: UUID_A }] });
  assert.ok(withRep.ok, "with a rep and one of his customers is a valid half-day");
  if (withRep.ok) {
    assert.equal(withRep.value.customers.length, 1, "the same customer ticked twice is kept once");
    assert.equal(withRep.value.areaSeatId, null, "with a rep carries no area");
    assert.equal(withRep.value.activityType, null, "with a rep carries no activity");
  }
  assert.equal(parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "with_rep", customers: [{ customerId: UUID_A }] }).ok, false, "with a rep names the rep");
  assert.equal(parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "with_rep", repSeatId: D11.seatId, customers: [] }).ok, false, "with a rep ticks at least one customer, or Mark all");
  assert.equal(
    parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "with_rep", repSeatId: D11.seatId, customers: [{ managerCustomerId: UUID_B }] }).ok,
    false,
    "with a rep, the customers are the rep's own — never Manager's own list",
  );
  const admin = parseManagerSlotDraft({ date: "2026-10-17", half: "PM", kind: "admin", activityType: "meeting", customers: [{ customerId: UUID_A }], note: "  Cycle   meeting " });
  assert.ok(admin.ok, "admin with one of the seven activities is valid");
  if (admin.ok) {
    assert.deepEqual(admin.value.customers, [], "an admin half-day holds no customer");
    assert.equal(admin.value.note, "Cycle meeting", "the note is trimmed and its spaces folded");
  }
  assert.equal(parseManagerSlotDraft({ date: "2026-10-17", half: "PM", kind: "admin", activityType: "golf" }).ok, false, "admin names one of the seven activities");
  const single = parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "single_visit", areaSeatId: D12.seatId, customers: [{ customerId: UUID_A }, { managerCustomerId: UUID_B }] });
  assert.ok(single.ok, "a single visit in a vacant area, with a rep-list customer and one of his own, is valid");
  assert.equal(parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "single_visit", customers: [{ customerId: UUID_A }] }).ok, false, "a single visit names the area");
  assert.equal(parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "single_visit", areaSeatId: D12.seatId, customers: [] }).ok, false, "a single visit names at least one customer");
  assert.equal(parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "single_visit", areaSeatId: D12.seatId, customers: [{ customerId: UUID_A, managerCustomerId: UUID_B }] }).ok, false, "a customer is one list's or the other's, never both");
  const cleared = parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: null });
  assert.ok(cleared.ok && cleared.value.kind === null, "a null kind clears the half-day");
  assert.equal(parseManagerSlotDraft({ date: "2026-10-17", half: "Noon", kind: "admin", activityType: "meeting" }).ok, false, "AM or PM, nothing else");

  // The chain: his RSM/NSM; Hany Saad's district managers then Ali Mohamed Ali.
  const plain = managerPlanApprovers(org, DM1.seatId);
  assert.equal(plain.first?.hrId, personKey("B-900"), "a district manager's first approver is the manager above his seat");
  assert.equal(plain.secondHrId, null, "and he has no second stage");
  const hanys = managerPlanApprovers(org, PDM.seatId);
  assert.equal(hanys.first?.hrId, personKey("PD-0001"), "Hany Saad approves first for his district managers");
  assert.equal(personKey(hanys.secondHrId), personKey("A-12"), "then Ali Mohamed Ali");

  // The state machine the screen offers buttons from.
  assert.equal(nextManagerPlanStatus({ action: "submit", status: "draft", stage: null, hasSecond: false }), "submitted");
  assert.equal(nextManagerPlanStatus({ action: "submit", status: "returned", stage: null, hasSecond: false }), "submitted", "a returned week is sent again");
  assert.equal(nextManagerPlanStatus({ action: "submit", status: "submitted", stage: null, hasSecond: false }), null, "a sent week is not sent twice");
  assert.equal(nextManagerPlanStatus({ action: "approve", status: "submitted", stage: "first", hasSecond: false }), "approved", "one stage: the first approval closes it");
  assert.equal(nextManagerPlanStatus({ action: "approve", status: "submitted", stage: "first", hasSecond: true }), "first_approved", "two stages: the first approval passes it on");
  assert.equal(nextManagerPlanStatus({ action: "approve", status: "first_approved", stage: "second", hasSecond: true }), "approved");
  assert.equal(nextManagerPlanStatus({ action: "approve", status: "first_approved", stage: "first", hasSecond: true }), null, "the first approver never decides the second stage");
  assert.equal(nextManagerPlanStatus({ action: "return", status: "submitted", stage: "first", hasSecond: false }), "returned");
  assert.equal(nextManagerPlanStatus({ action: "return", status: "first_approved", stage: "second", hasSecond: true }), "returned");
  assert.equal(nextManagerPlanStatus({ action: "approve", status: "approved", stage: "first", hasSecond: false }), null, "an approved week is never approved again");

  // The status names the person it waits on; the Administrator's decision says so.
  assert.equal(managerPlanStatusLine({ status: "submitted", firstName: "Hany Saad" }), "Waiting for Hany Saad to approve");
  assert.equal(managerPlanStatusLine({ status: "first_approved", secondName: "Ali Mohamed Ali" }), "Waiting for Ali Mohamed Ali to approve");
  assert.equal(managerPlanStatusLine({ status: "approved", deciderName: "Hany Saad", byAdministrator: true }), "Approved by the Administrator");
  assert.equal(managerPlanStatusLine({ status: "returned", managerName: "Mohamed Ali" }), "Waiting for Mohamed Ali to edit and resend");

  // A ticked customer, read against the rep's own day: a rep's draft is "not sent"; a dropped one is flagged, never removed.
  assert.equal(flagManagerCustomer({ onRepDay: true, repWeekSent: true }), null);
  assert.equal(flagManagerCustomer({ onRepDay: true, repWeekSent: false }), "not_sent");
  assert.equal(flagManagerCustomer({ onRepDay: false, repWeekSent: true }), "dropped");
  assert.equal(flagManagerCustomer({ onRepDay: false, repWeekSent: false }), "dropped", "a customer the rep no longer has is dropped, sent or not");
  assert.equal(halfOfListType("Pharmacy"), "PM", "a pharmacy on the rep's day falls in the evening");
  assert.equal(halfOfListType("AM"), "AM");

  // Planned against actual. A day closes for its visits at 02:00 Cairo the next morning.
  assert.equal(managerOutcome({ kind: "admin", date: "2026-10-14", done: false, cairoToday: FRIDAY, visitDay: FRIDAY }), "not_checkable", "admin is never checkable");
  assert.equal(managerOutcome({ kind: "with_rep", date: "2026-10-14", done: true, cairoToday: FRIDAY, visitDay: FRIDAY }), "done");
  assert.equal(managerOutcome({ kind: "with_rep", date: "2026-10-14", done: false, cairoToday: FRIDAY, visitDay: FRIDAY }), "not_done");
  assert.equal(
    managerOutcome({ kind: "single_visit", date: "2026-10-15", done: false, cairoToday: FRIDAY, visitDay: "2026-10-15" }),
    "open",
    "at 01:00 on Friday, Thursday's visits are still being logged, so Thursday is not yet a miss",
  );
  assert.equal(managerOutcome({ kind: "single_visit", date: "2026-10-18", done: false, cairoToday: FRIDAY, visitDay: FRIDAY }), "ahead");
  assert.equal(managerPlanSummaryText({ planned: 12, done: 9, notDone: 3, unplanned: 0 }), "Planned 12 · done 9");
  assert.equal(managerPlanSummaryText({ planned: 12, done: 9, notDone: 3, unplanned: 2 }), "Planned 12 · done 9 · 2 unplanned", "unplanned visits are named apart");

  // A typed customer: the match is OFFERED, exact first; namesakes are real, so both come back.
  const candidates = [
    { id: "a", name: "Ahmed Samir", source: "rep" as const },
    { id: "b", name: "ahmed  samir", source: "own" as const },
    { id: "c", name: "Ahmed Samir Ali", source: "rep" as const },
    { id: "d", name: "Mona Fathy", source: "rep" as const },
  ];
  assert.deepEqual(matchCustomerName("Ahmed Samir", candidates).map((entry) => entry.id), ["a", "b", "c"], "both namesakes, then the longer name");
  assert.deepEqual(matchCustomerName("   ", candidates), [], "an empty name matches nothing");

  // ── 2. Who plans, reads, writes and decides ───────────────────────────────────────────────────

  assert.deepEqual(managerPlanSeats(org, "B-12").map((entry) => entry.seatId), [DM1.seatId], "a district manager plans on his DM seat");
  assert.deepEqual(managerPlanSeats(org, "B-1").map((entry) => entry.seatId), [ADM.seatId], "the acting district manager plans on her acting seat");
  assert.deepEqual(managerPlanSeats(org, "B-7"), [], "a rep has no plan seat");

  assert.equal(managerPlanReach(rep), null, "a rep never reaches a district manager's plan");
  assert.throws(() => resolveManagerPlanReader(rep, null), /district manager's weekly plan is read by/, "a rep is refused by name");
  assert.throws(() => assertManagerPlanWriter(rep), /Only a district manager plans/);

  assert.deepEqual(managerPlanReach(dm), { mode: "own", canWrite: true, managers: [] }, "the district manager plans his own week");
  assert.equal(assertManagerPlanWriter(dm).seatId, DM1.seatId);
  assert.throws(() => resolveManagerPlanReader(otherDm, "B-12"), /opens only the weekly plan of their own seat/, "another district manager is refused");
  assert.equal(readsManagerPlanOf(otherDm, "B-12"), false);

  // Nosiba's shape: an acting district manager who also holds a rep seat files BOTH weeks, and her own rep
  // seat is never one of "her reps". Its area stays in her district for a single visit; so does a vacant one.
  assert.equal(assertManagerPlanWriter(actingDm).seatId, ADM.seatId, "the acting district manager plans her manager week");
  assert.ok(actingDm.ownTerritories.some((entry) => entry.seatId === UE1.seatId), "and she still holds her own rep seat for her rep week");
  assert.deepEqual(managerTeamSeats(actingDm, "B-1").map((entry) => entry.seatId), [UE9.seatId], "her reps: the occupied seats of her district, never her own");
  assert.deepEqual(
    managerDistrictSeats(actingDm, "B-1").map((entry) => entry.seatId).sort(),
    [UE2.seatId, UE9.seatId].sort(),
    "her district's areas include the vacant seat and never her own rep seat",
  );

  const nsmReach = managerPlanReach(nsm);
  assert.equal(nsmReach?.mode, "pick", "the NSM picks among the district managers below him");
  assert.equal(nsmReach?.canWrite, false, "and never writes one");
  assert.deepEqual(nsmReach?.managers.map((entry) => entry.hrId).sort(), [personKey("B-1"), personKey("B-12"), personKey("B-76")].sort(), "his own line's district managers, never Pedia's");
  assert.throws(() => assertManagerPlanWriter(nsm), /Only a district manager plans/);
  assert.equal(readsManagerPlanOf(hany, "PD-0040"), true, "Hany reads his district manager's week");
  assert.equal(readsManagerPlanOf(hany, "B-12"), false, "and no other line's");

  for (const [name, viewer] of [["the CEO", ceo], ["SFE", sfe], ["the Super Admin", owner]] as const) {
    const reach = managerPlanReach(viewer);
    assert.equal(reach?.mode, "pick", `${name} reads any district manager's week`);
    assert.ok(reach?.managers.some((entry) => entry.hrId === personKey("PD-0040")), `${name} reaches every line`);
    assert.equal(reach?.canWrite, false, `${name} never writes one`);
  }
  assert.throws(() => assertManagerPlanWriter(owner), /./, "the Super Admin plans no district manager's week");

  // Deciding: the holder stored on the row at send, the Administrator in place of either, never across worlds.
  const firstStep = { stage: "first" as const, firstApproverHrId: personKey("B-900"), secondApproverHrId: null, isTest: false };
  assert.equal(managerPlanDeciderRole(nsm, firstStep), "first", "the stored first approver decides the first stage");
  assert.equal(managerPlanDeciderRole(dm, firstStep), null, "the district manager never decides his own week");
  assert.equal(managerPlanDeciderRole(owner, firstStep), "administrator", "the Administrator acts in place of the holder");
  assert.equal(managerPlanDeciderRole(testNsm, firstStep), null, "a test account never decides a real week");
  const secondStep = { stage: "second" as const, firstApproverHrId: personKey("PD-0001"), secondApproverHrId: personKey("A-12"), isTest: false };
  assert.equal(managerPlanDeciderRole(hany, secondStep), null, "Hany never decides Ali's stage");
  assert.equal(managerPlanDeciderRole(viewerFor("A-12", "National Sales Manager", { canCreate: false }), secondStep), "second", "Ali decides the second stage");

  // The old "My own visit" is closed for a district manager and an acting one, and stays for a rep, an RSM and an NSM.
  assert.equal(managerOwnVisitClosed(org, "B-12"), true);
  assert.equal(managerOwnVisitClosed(org, "B-1"), true);
  assert.equal(managerOwnVisitClosed(org, "B-7"), false);
  assert.equal(managerOwnVisitClosed(org, "B-900"), false);

  // The switch: only once his own team is live.
  assert.equal(dmPlansInPhoenixCrmFor(managerPlanSeats(org, "B-12"), (entry) => entry.seatId === DM1.seatId), true, "a live team plans in Phoenix CRM");
  assert.equal(dmPlansInPhoenixCrmFor(managerPlanSeats(org, "B-12"), () => false), false, "a team not yet started keeps the legacy form");
  assert.equal(dmPlansInPhoenixCrmFor(managerPlanSeats(org, "B-7"), () => true), false, "a rep is never switched");

  // ── 3. The database half ─────────────────────────────────────────────────────────────────────

  const sql = stripSqlComments(readFileSync(new URL("../supabase/migrations/20261017000000_phoenix_crm_manager_plan.sql", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  for (const table of MANAGER_TABLES) {
    assert.ok(sql.includes(`alter table public.${table} enable row level security;`), `${table} has RLS on`);
    assert.ok(sql.includes(`revoke all on table public.${table} from public, anon, authenticated;`), `${table} is revoked from the browser roles`);
    assert.ok(sql.includes(`grant all on table public.${table} to service_role;`), `${table} is the service role's`);
  }
  assert.equal(/grant [^;]* to (anon|authenticated)\b/i.test(sql), false, "nothing in the migration is granted to a browser role");
  for (const fn of MANAGER_FUNCTIONS) {
    const at = sql.indexOf(`create or replace function public.${fn}(p jsonb)`);
    assert.ok(at >= 0, `${fn} is created`);
    assert.match(sql.slice(at, at + 200), /security definer/, `${fn} is SECURITY DEFINER`);
    assert.ok(sql.includes(`revoke execute on function public.${fn}(jsonb) from public, anon, authenticated;`), `${fn} is revoked from the browser roles`);
    assert.ok(sql.includes(`grant execute on function public.${fn}(jsonb) to service_role;`), `${fn} is the service role's`);
  }
  assert.match(sql, /on public\.phoenix_crm_manager_plans \(manager_hr_id, week_start, is_test\)/, "one week per manager per world");
  assert.match(sql, /check \(extract\(isodow from week_start\) = 6\)/, "a week starts on a Saturday");
  assert.match(sql, /check \(plan_date between week_start and week_start \+ 5\)/, "a half-day falls Saturday to Thursday — never the Friday");
  assert.match(sql, /check \(not \(extract\(isodow from plan_date\) = 4 and half = 'PM'\)\)/, "Thursday holds a morning only");
  assert.equal(/references public\.phoenix_crm_plan_items/.test(sql), false, "no foreign key to the rep's plan items — his own save rewrites them");

  // ── 4. Nothing outside the module reads the tables, and his visits never reach a KPI ─────────

  const tableRead = /\.from\(\s*["'`]phoenix_crm_manager_/;
  for (const file of [...filesUnder("src"), ...filesUnder("app")]) {
    if (!tableRead.test(source(file))) continue;
    assert.match(file, /^src\/lib\/phoenix-crm\/server\/manager-[a-z-]+\.ts$/, `${file} reads a manager-plan table directly — outside screens go through manager-plan-readers.ts`);
  }
  for (const file of readdirSync(new URL("../supabase/migrations/", import.meta.url))) {
    if (!file.endsWith(".sql") || file === "20261017000000_phoenix_crm_manager_plan.sql") continue;
    const text = readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8");
    assert.equal(text.includes("phoenix_crm_manager_visits"), false, `${file} names his own visits — they count in his own report only, never a view or a KPI`);
  }
  for (const outside of [
    "src/lib/weekly-planning/calendar-service.ts",
    "src/lib/weekly-planning/plan-adherence-data.ts",
    "src/lib/private-calendar/plan-items.ts",
    "src/lib/calendar/service.ts",
    "src/lib/action-center/decided-for-me.ts",
    "src/lib/phoenix-crm/server/visit-report.ts",
  ]) {
    const text = source(outside);
    assert.match(text, /@\/lib\/phoenix-crm\/server\/manager-plan-readers/, `${outside} reads his week through the one adapter`);
    assert.equal(/@\/lib\/phoenix-crm\/server\/manager-plan-(rows|queue|report|hub)"/.test(text), false, `${outside} never reaches past the adapter`);
  }
  for (const quiet of ["src/lib/phoenix-crm/server/manager-plan-readers.ts", "src/lib/phoenix-crm/server/manager-plan-queue.ts"]) {
    assert.equal(/from "@\/lib\/(notifications\/|phoenix-crm\/server\/notifications)/.test(source(quiet)), false, `${quiet} imports no notice sender — it would close the import cycle through notifications/in-app.ts`);
  }

  // ── 5. No email, and the Hub counts each week once ───────────────────────────────────────────

  assert.deepEqual(PHOENIX_CRM_EMAIL_EVENT_TYPES, [], "Phoenix CRM emails nobody");
  assert.ok(PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES.includes("manager_plan_edit_expired"), "the expired ask goes in-app and by Telegram only");
  const policy = source("src/lib/notifications/policy.ts");
  const managerPolicies = policy.split("\n").filter((line) => /"phoenix_crm\.manager_(plan|list)_[a-z_]+":/.test(line));
  assert.equal(managerPolicies.length, 9, "nine manager-plan notices are registered");
  for (const line of managerPolicies) assert.equal(line.includes("\"email\""), false, `never email: ${line.trim().slice(0, 60)}`);
  const inApp = source("src/lib/notifications/in-app.ts");
  for (const key of ["manager_plan_waiting", "manager_plan_edit_waiting", "manager_list_removal_waiting"]) {
    assert.match(inApp, new RegExp(`"phoenix_crm:${key}": \\{ domain: "plan"`), `${key} archives through the Hub's plan domain, never phoenixCrmPlan`);
  }

  const hub = source("src/lib/approvals-hub/service.ts");
  assert.match(functionBody(hub, "export async function getPlanApprovalsForResponder("), /loadManagerPlanQueue\(/, "the Hub's one queue merges the manager weeks");
  assert.equal(/loadManagerPlanQueue|manager-plan-queue/.test(functionBody(source("src/lib/weekly-planning/service.ts"), "export async function getPlansAwaitingAction(")), false, "the view-as inbox's legacy read does not count them a second time");
  for (const crmCounter of ["src/lib/phoenix-crm/server/overview.ts", "src/lib/phoenix-crm/server/needs-you.ts", "src/lib/phoenix-crm/server/decision-queues.ts"]) {
    assert.equal(/manager-plan-queue|loadManagerPlanQueue/.test(source(crmCounter)), false, `${crmCounter} never counts a manager week — Needs You would count it twice`);
  }

  // ── 6. The legacy form, the nav and the old address ──────────────────────────────────────────

  const legacy = source("src/lib/weekly-planning/service.ts");
  assert.match(functionBody(legacy, "export async function createEmployeePlan("), /await assertPlansOnThisForm\(access\)/, "a switched district manager cannot create a legacy plan");
  assert.match(functionBody(legacy, "export async function updateEmployeePlan("), /await assertPlansOnThisForm\(access\)/, "nor revise or send one");
  assert.match(functionBody(legacy, "async function plansInPhoenixCrm("), /dmPlansInPhoenixCrm\(access\.hrId\)/, "the switch is the live-team rule");
  assert.match(functionBody(legacy, "export async function getEmployeePlansWorkspace("), /!\(await plansInPhoenixCrm\(access\)\)/, "the legacy workspace offers him no new plan");

  const navArgs = ["District Manager", "District Manager", "Anti Infective", "Sales", "B-12", false, false, true, false, false, false] as const;
  const legacyNav = resolveEmployeePortalNavVisibility(...navArgs, false);
  const switchedNav = resolveEmployeePortalNavVisibility(...navArgs, true);
  assert.equal(legacyNav.showPlansTab, true, "a district manager on the legacy form keeps his Plans tab");
  assert.equal(switchedNav.showPlansTab, false, "a switched district manager loses the Plans tab");
  assert.equal(switchedNav.showPlanningCalendarTab, true, "and keeps the Planning Calendar");

  const plansPage = source("app/employee-portals/plans/page.tsx");
  assert.match(
    plansPage,
    /if \(!selectedPlanId && \(await dmPlansInPhoenixCrm\(access\.hrId\)[^{]*\{\s*redirect\(`\$\{PHOENIX_CRM_PORTAL_PATH\}\?tab=plan`\);/,
    "the old address sends a switched district manager to the Phoenix CRM Plan tab, and a ?plan= deep link still opens",
  );

  // ── 7. The old "My own visit" is refused for a district manager ──────────────────────────────

  const visits = source("src/lib/phoenix-crm/server/visits.ts");
  assert.match(
    functionBody(visits, "export async function saveVisit("),
    /enteredAs === "manager" && visit\.kind === "single" && managerOwnVisitClosed\(viewer\.org, viewer\.hrId\)/,
    "the server refuses a district manager's single visit under a rep's seat",
  );
  assert.match(source("src/components/phoenix-crm/visit-log-form.tsx"), /form\.ownVisitClosed/, "the form shows the option closed");

  // ── The words on his screens ─────────────────────────────────────────────────────────────────

  for (const screen of ["src/components/approvals-hub/manager-plan-request-detail.tsx", "src/components/approvals-hub/manager-plan-decision-actions.tsx"]) {
    assert.equal(/\b(doctors?|accounts?)\b/i.test(source(screen)), false, `${screen} says customers, never doctors or accounts`);
  }
}
