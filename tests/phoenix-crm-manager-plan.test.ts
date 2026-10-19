import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { owesAWeeklyPlan } from "../src/lib/daily-deductions/no-weekly-plan-select.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { PHOENIX_CRM_EMAIL_EVENT_TYPES, PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES } from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { fieldWeekStart, weekdayOfIsoDay } from "../src/lib/phoenix-crm/calendar.ts";
import {
  ceoHrIdOf,
  countManagerOutcomes,
  countsAsPlannersVisitWithRep,
  DM_SINGLE_VISIT_HALF_DAYS_MAX,
  isManagerAskLive,
  managerEvidenceKey,
  managerVisitWindow,
  dmPlansInPhoenixCrmFor,
  dmSingleVisitCapError,
  flagManagerCustomer,
  halfOfListType,
  isManagerDayOpen,
  isManagerPlanSent,
  legacyStyleApprovers,
  managerAdminActivities,
  managerDayHalves,
  managerOutcome,
  managerOwnVisitClosed,
  managerPlanApprovers,
  managerPlannerTitle,
  managerPlanScopes,
  managerPlanSeats,
  managerPlanWriterOf,
  managerScopeTerritories,
  managerSlotScopeError,
  PRODUCT_MANAGER_PLAN_LINES,
  PRODUCT_MANAGER_PLAN_ROLES,
  seniorPlanSeats,
  singleVisitHalfKey,
  singleVisitHalfOfHour,
  managerPlanStatusLine,
  managerPlanSummaryText,
  managerPlanWeeks,
  managerWeekState,
  managerAskStage,
  matchCustomerName,
  missingManagerCustomerField,
  nextManagerPlanStatus,
  parseManagerSlotDraft,
} from "../src/lib/phoenix-crm/manager-plan-rules.ts";
import {
  isOldCrmPlanAction,
  oldCrmActionToVerification,
  oldCrmApprovalOptions,
  oldCrmHalfOf,
  oldCrmPlanOf,
  oldCrmStatusLabel,
} from "../src/lib/phoenix-crm/old-crm-plan-rules.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, personKey, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import type { PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { accessRegistry } from "../src/lib/security/access-registry.ts";
import { askSteps } from "../src/lib/phoenix-crm/server/manager-plan-hub.ts";
import { managerQueuePlace } from "../src/lib/phoenix-crm/server/manager-plan-queue.ts";
import { managerPlanRowOf } from "../src/lib/phoenix-crm/server/manager-plan-rows.ts";
import {
  assertManagerPlanWriter,
  managerAskDeciderRole,
  managerDistrictSeats,
  managerPlanChoices,
  managerPlanDeciderRole,
  managerPlanReach,
  managerTeamSeats,
  readsManagerPlanOf,
  resolveManagerPlanReader,
} from "../src/lib/phoenix-crm/server/manager-plan-reach.ts";
import { managerHalfLegacyType } from "../src/lib/phoenix-crm/server/manager-plan-readers.ts";
import { managerPlanDeliveries } from "../src/lib/phoenix-crm/server/notifications.ts";
import { VISIT_REPORT_FIELDS } from "../src/lib/phoenix-crm/visit-report-fields.ts";

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
 *   7. the old "My own visit" is closed for a district manager;
 *   8. the review fixes of 17 Oct 2026 — a with-a-rep half-day is Field and never a Double Visit, a new
 *      tick sits on the rep's own half, a title that still owes the legacy plan keeps it, a re-saved
 *      half-day keeps its visits, only a sent week is judged, every decision names what it read, and the
 *      screens keep a dropped rep's customers and their pickers on screen;
 *   9. after a regional manager agrees, the national sales manager above him approves his ask to edit a
 *      week and his ask to remove a customer too (owner, 2026-10-17, "Week + edit asks + removals") — each
 *      step decided only by its holder, the Hub filing it by its step, and the database never letting who
 *      decides close a two-step ask at the first approval;
 *  10. the plan widened to the regional, national and product managers (owner, 2026-10-17: "Now do the same
 *      for the product managers and the national sales managers and the regional manager") — the four
 *      kinds of writer, the scope each picks first, the "as today" approvers with HR's automatic
 *      acknowledgement on every week but a district manager's, Office for everyone but a district
 *      manager, the product managers filing both forms, the attendance office days, the report's product
 *      manager slot, the Hub's two feeds, and the routes every writer reaches with `read`.
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
// Pedia, as production holds it: Hany Saad on the one regional seat, under Ali Mohamed Ali's national
// seat. A regional manager's approval goes on to the national sales manager above him, always.
const ALI = seat({ seatId: "SEAT-PED-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-PED-NSM"], occupantHrId: "A-12", lineCode: "pedia", lineName: "Pedia" });
const HANY = seat({ seatId: "SEAT-PED-RSM", tier: "RSM", path: [...ALI.path, "SEAT-PED-RSM"], occupantHrId: "PD-0001", lineCode: "pedia", lineName: "Pedia" });
const PDM = seat({ seatId: "SEAT-PED-DM-1", tier: "DM", path: [...HANY.path, "SEAT-PED-DM-1"], occupantHrId: "PD-0040", lineCode: "pedia", lineName: "Pedia", regionName: "Alex" });
const P11 = seat({ seatId: "SEAT-PED-REP-11", tier: "REP", path: [...PDM.path, "SEAT-PED-REP-11"], occupantHrId: "PD-0041", lineCode: "pedia", lineName: "Pedia", areaName: "Smouha" });

const org = buildOrgIndex([CEO, NSM, DM1, D11, D12, DM2, D21, ADM, UE1, UE2, UE9, ALI, HANY, PDM, P11]);

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
const hany = viewerFor("PD-0001", "Regional Manager", { canCreate: false });
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

  // The chain: his RSM/NSM; after a regional manager, the national sales manager above him — never skipped.
  const plain = managerPlanApprovers(org, DM1.seatId);
  assert.equal(plain.first?.hrId, personKey("B-900"), "a district manager's first approver is the manager above his seat");
  assert.equal(plain.secondHrId, null, "and with no regional manager above him he has no second stage");
  const hanys = managerPlanApprovers(org, PDM.seatId);
  assert.equal(hanys.first?.hrId, personKey("PD-0001"), "Hany Saad approves first for his district managers");
  assert.equal(personKey(hanys.secondHrId), personKey("A-12"), "then Ali Mohamed Ali");
  {
    // The rule is the SEAT, not a named pair: a regional manager on another line, with nobody listed for him.
    const cnsNsm = seat({ seatId: "SEAT-CNS-NSM", tier: "NSM", path: ["SEAT-CEO", "SEAT-CNS-NSM"], occupantHrId: "B-122", lineCode: "cns", lineName: "CNS" });
    const cnsRsm = seat({ seatId: "SEAT-CNS-RSM", tier: "RSM", path: [...cnsNsm.path, "SEAT-CNS-RSM"], occupantHrId: "B-501", lineCode: "cns", lineName: "CNS" });
    const cnsDm = seat({ seatId: "SEAT-CNS-DM-9", tier: "DM", path: [...cnsRsm.path, "SEAT-CNS-DM-9"], occupantHrId: "B-502", lineCode: "cns", lineName: "CNS" });
    const filled = managerPlanApprovers(buildOrgIndex([CEO, cnsNsm, cnsRsm, cnsDm]), cnsDm.seatId);
    assert.equal(filled.first?.hrId, personKey("B-501"), "a new regional manager approves first");
    assert.equal(filled.secondHrId, personKey("B-122"), "and the national sales manager above him always approves after him");
    const nsmEmpty = managerPlanApprovers(buildOrgIndex([CEO, { ...cnsNsm, occupantHrId: null }, cnsRsm, cnsDm]), cnsDm.seatId);
    assert.equal(nsmEmpty.secondHrId, personKey("B-2"), "an empty national seat passes the second step up to the CEO, never closes the week at one approval");
    const rsmEmpty = managerPlanApprovers(buildOrgIndex([CEO, cnsNsm, { ...cnsRsm, occupantHrId: null }, cnsDm]), cnsDm.seatId);
    assert.equal(rsmEmpty.first?.hrId, personKey("B-122"), "an empty regional seat passes the first step up to the national sales manager");
    assert.equal(rsmEmpty.secondHrId, null, "who then approves alone — there is no regional approval to follow");
  }
  {
    // The database closes a week at the first approval ONLY when no second approver was stored on send —
    // never by who decides, so the Administrator acting for the regional manager still passes it on.
    const migration = stripSqlComments(readFileSync(new URL("../supabase/migrations/20261017000000_phoenix_crm_manager_plan.sql", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    const approveBranch = migration.slice(migration.indexOf("elsif v_action = 'approve' then"), migration.indexOf("v_event := case when v_plan.status = 'first_approved'"));
    assert.ok(approveBranch.length > 0, "the approve branch is read");
    assert.ok(
      approveBranch.includes("set status = case when pl.second_approver_hr_id is null then 'approved' else 'first_approved' end"),
      "the first approval passes a two-stage week on, whoever decides it",
    );
    assert.ok(!/\b(?:if|when)\s+v_role\b/.test(approveBranch), "no decider's role closes a two-stage week at the first approval");
  }

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
  assert.throws(() => resolveManagerPlanReader(rep, null), /manager's weekly plan is read by/, "a rep is refused by name");
  assert.throws(() => assertManagerPlanWriter(rep), /Only a district, regional, national or product manager plans/);

  assert.deepEqual(managerPlanReach(dm), { mode: "own", canWrite: true, managers: [] }, "the district manager plans his own week");
  assert.equal(assertManagerPlanWriter(dm).seat?.seatId, DM1.seatId);
  assert.equal(assertManagerPlanWriter(dm).kind, "dm", "a district manager plans as one");
  assert.throws(() => resolveManagerPlanReader(otherDm, "B-12"), /opens only the weekly plans of their own seat/, "another district manager is refused");
  assert.equal(readsManagerPlanOf(otherDm, "B-12"), false);

  // Nosiba's shape: an acting district manager who also holds a rep seat files BOTH weeks, and her own rep
  // seat is never one of "her reps". Its area stays in her district for a single visit; so does a vacant one.
  assert.equal(assertManagerPlanWriter(actingDm).seat?.seatId, ADM.seatId, "the acting district manager plans her manager week");
  assert.ok(actingDm.ownTerritories.some((entry) => entry.seatId === UE1.seatId), "and she still holds her own rep seat for her rep week");
  assert.deepEqual(managerTeamSeats(actingDm, "B-1").map((entry) => entry.seatId), [UE9.seatId], "her reps: the occupied seats of her district, never her own");
  assert.deepEqual(
    managerDistrictSeats(actingDm, "B-1").map((entry) => entry.seatId).sort(),
    [UE2.seatId, UE9.seatId].sort(),
    "her district's areas include the vacant seat and never her own rep seat",
  );

  // Since 2026-10-17 the NSM plans a week of his own too, and still reads the district managers below him.
  const nsmReach = managerPlanReach(nsm);
  assert.equal(nsmReach?.mode, "own", "the NSM plans his own week");
  assert.equal(nsmReach?.canWrite, true, "and writes it with read alone — his grants are read and approve");
  assert.deepEqual(nsmReach?.managers.map((entry) => entry.hrId).sort(), [personKey("B-1"), personKey("B-12"), personKey("B-76")].sort(), "his own line's district managers, never Pedia's");
  assert.equal(assertManagerPlanWriter(nsm).kind, "nsm");
  assert.equal(readsManagerPlanOf(nsm, "B-12"), true, "and opens a district manager's week below him");
  assert.equal(resolveManagerPlanReader(nsm, "B-12").canWrite, false, "but never writes it");
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

  assert.deepEqual(PHOENIX_CRM_EMAIL_EVENT_TYPES, ["recorded_visit_decided"], "the district manager's plan emails nobody — the one email exception is the recorded-visit decision");
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
  assert.match(functionBody(legacy, "export async function getEmployeePlansWorkspace("), /movedToPhoenixCrm = employee \? await plansInPhoenixCrm\(access\) : false;[\s\S]*employee &&\s*!movedToPhoenixCrm &&/, "the legacy workspace offers him no new plan");

  const navArgs = ["District Manager", "District Manager", "Anti Infective", "Sales", "B-12", false, false, true, false, false, false] as const;
  const legacyNav = resolveEmployeePortalNavVisibility(...navArgs, false);
  const switchedNav = resolveEmployeePortalNavVisibility(...navArgs, true);
  assert.equal(legacyNav.showPlansTab, true, "a district manager on the legacy form keeps his Plans tab");
  assert.equal(switchedNav.showPlansTab, true, "a switched district manager KEEPS the Plans tab — it is his history now (owner, 2026-10-17)");
  assert.equal(switchedNav.showPlanningCalendarTab, true, "and keeps the Planning Calendar");

  // His history, read only (owner, 2026-10-17: "make it unhidden, but make them not able to submit … only
  // able to see their historical plans"): the page shows PlansHistory, never the builder, to a switched
  // manager opening his own plans, and nothing on this form writes for him.
  const plansPage = source("app/employee-portals/plans/page.tsx");
  assert.equal(/redirect\(`\$\{PHOENIX_CRM_PORTAL_PATH\}/.test(plansPage), false, "the old address no longer bounces a switched manager away");
  assert.match(plansPage, /if \(workspace\.plansInPhoenixCrm && !reviewsSomeoneElse\) \{[\s\S]*<PlansHistory/, "a switched manager opening the page gets the history view");
  assert.match(plansPage, /reviewsSomeoneElse = openedPlan !== null && !ownPlans\.some/, "a link to someone else's plan still opens the review workspace");
  const history = source("src/components/employee-portal/plans-history.tsx");
  for (const writer of ["<Button", "<input", "<textarea", "<select", "runAction", "createEmployeePlan", "submitPlan", "fetch("]) {
    assert.equal(history.includes(writer), false, `the history view holds no ${writer} — it cannot write`);
  }
  assert.match(functionBody(legacy, "export async function getEmployeePlansWorkspace("), /loadOwnPlanRows\(employee\.hrId\)/, "his history is every plan he filed, not only the company-wide window");
  for (const writer of ["export async function cancelEmployeePlan(", "export async function requestEditEmployeePlan(", "export async function submitVisitDetails("]) {
    assert.match(functionBody(legacy, writer), /await assertPlansOnThisForm\(access\)/, `${writer} refuses a switched manager`);
  }

  // ── 7. The old "My own visit" is refused for a district manager ──────────────────────────────

  const visits = source("src/lib/phoenix-crm/server/visits.ts");
  assert.match(
    functionBody(visits, "export async function saveVisit("),
    /enteredAs === "manager" && visit\.kind === "single" && \(await managerOwnVisitClosedNow\(viewer\)\)/,
    "the server refuses a district manager's single visit under a rep's seat",
  );
  // …but only once he plans in Phoenix CRM: one still on the legacy form (Mohamed Alaa Eleiwa until his
  // team starts) has no "My single visits" to log in instead, so he keeps "My own visit".
  const closedNow = functionBody(source("src/lib/phoenix-crm/server/manager-plan-switch.ts"), "export async function managerOwnVisitClosedNow(");
  assert.match(closedNow, /if \(!managerOwnVisitClosed\(viewer\.org, viewer\.hrId\)\) return false;/, "the seat test comes first");
  assert.match(closedNow, /return dmPlansInPhoenixCrm\(viewer\.hrId, \{[^}]*\}\)\.catch\(\(\) => false\);/, "then the switch, and an unreadable answer keeps the option open");
  assert.match(
    source("src/lib/phoenix-crm/server/visits.ts"),
    /ownVisitClosed: enteredAs === "manager" && \(await managerOwnVisitClosedNow\(viewer\)\)/,
    "the form shows the option closed only where the save would refuse it",
  );
  assert.match(source("src/components/phoenix-crm/visit-log-form.tsx"), /form\.ownVisitClosed/, "the form shows the option closed");

  // ── 8. The review fixes of 17 Oct 2026 ───────────────────────────────────────────────────────

  // A half-day with a rep is Field, never a Double Visit: only the rep's own logged visit naming him is one.
  assert.equal(managerHalfLegacyType("with_rep", null), "Field", "with a rep reads as Field on every calendar");
  assert.equal(managerHalfLegacyType("single_visit", null), "Field");
  assert.equal(managerHalfLegacyType("admin", "travel"), "Travel");
  assert.equal(/"Double Visit"/.test(source("src/lib/phoenix-crm/server/manager-plan-readers.ts")), false, "the adapter has no Double Visit to hand any screen");
  const planField = VISIT_REPORT_FIELDS.find((field) => field.key === "doubleVisitPlan");
  assert.equal(planField?.label, "Manager's plan with the rep", "the visit report names the plan for what it is, and keeps its key for saved layouts");

  // A NEW tick with a rep sits on that rep's own half-day; one already on this half-day with this rep stays.
  const plans = source("src/lib/phoenix-crm/server/manager-plans.ts");
  const saveSlot = functionBody(plans, "export async function saveManagerPlanSlot(");
  assert.match(saveSlot, /if \(draft\.kind === "with_rep"\) \{[\s\S]*?await assertOnTheRepsHalf\(\{/, "the server checks a with-a-rep tick, not only the screen");
  const onHalf = functionBody(plans, "async function assertOnTheRepsHalf(");
  assert.match(onHalf, /repHalfKey\(input\.repSeatId, input\.date, input\.half\)/, "against the rep's own day and half");
  assert.match(onHalf, /row\.kind === "with_rep" && row\.repSeatId === input\.repSeatId/, "a customer kept from the same rep's half-day passes");
  assert.match(onHalf, /if \(!onHalf\.has\(id\) && !kept\.has\(id\)\) \{\s*throw conflictError\(/, "anything else is refused");

  // Re-saving a single-visit half-day hands the visits he already logged on it to the new slot.
  assert.match(saveSlot, /const savedSlotId = textOrNull\(saved\.slot_id\);\s*if \(draft\.kind === "single_visit" && savedSlotId\) \{\s*await relinkPlannedVisits\(/, "the re-saved half-day keeps its visits");
  const relink = functionBody(plans, "async function relinkPlannedVisits(");
  assert.match(relink, /\.eq\("is_unplanned", false\)/, "only planned visits move");
  assert.match(relink, /\.is\("plan_slot_id", null\)/, "only the ones the delete left without a slot");
  assert.match(relink, /\.eq\("half", input\.half\)/, "only that half-day's");
  assert.equal(/\bthrow\b/.test(relink), false, "a failed relink is logged, never thrown — the half-day is already saved");

  // Every send and decision names the version its screen showed; the removal names the ask it read.
  const transition = functionBody(plans, "export async function transitionManagerPlan(");
  assert.match(transition, /const expectedVersion = expectedVersionOf\(body\.version\);\s*if \(expectedVersion === null\) throw validationError\(/, "a week is never decided unread");
  assert.equal(/expectedVersionOf\(body\.version\) \?\? /.test(transition), false, "never the version as it stands now");
  const decideEdit = functionBody(plans, "export async function decideManagerPlanEdit(");
  assert.match(decideEdit, /if \(expectedVersion === null\) throw validationError\(/, "an edit ask is never decided unread");
  assert.equal(/expectedVersionOf\(body\.version\) \?\? /.test(decideEdit), false);
  const decideRemoval = functionBody(source("src/lib/phoenix-crm/server/manager-customers.ts"), "export async function decideManagerCustomerRemoval(");
  assert.match(decideRemoval, /if \(!requestedAt \|\| requestedAt !== row\.removalRequestedAt\) \{\s*throw conflictError\(/, "a re-raised removal ask is never decided on the old one's page");
  assert.match(source("src/components/approvals-hub/manager-plan-decision-actions.tsx"), /body = \{\s*id: target\.customerId,\s*requestedAt: target\.requestedAt,/, "the Hub sends the ask it showed");

  // A title that still owes the legacy weekly plan keeps the legacy form — the no-weekly-plan charge reads it.
  assert.equal(owesAWeeklyPlan("Product Manager"), true);
  assert.equal(owesAWeeklyPlan("District Sales Manager"), false, "today's district managers owe no legacy plan");
  const switchSource = source("src/lib/phoenix-crm/server/manager-plan-switch.ts");
  assert.match(
    functionBody(switchSource, "export async function dmPlansInPhoenixCrm("),
    /if \(seats\.length === 0\) return seniorPlansInPhoenixCrm\(org, hrId, options\.cairoToday\);\s*if \(await owesTheLegacyWeeklyPlan\(hrId\)\) return false;/,
    "a seat holder whose title owes the legacy plan is never switched off it",
  );
  assert.match(
    functionBody(switchSource, "async function seniorPlansInPhoenixCrm("),
    /if \(seats\.length === 0\) return false;\s*if \(await owesTheLegacyWeeklyPlan\(hrId\)\) return false;/,
    "nor is a regional or national seat holder whose title owes it",
  );
  assert.match(functionBody(switchSource, "async function owesTheLegacyWeeklyPlan("), /owesAWeeklyPlan\(row\.job_title\)/, "read from the job title, exactly as the charge reads it");

  // Only a sent week is judged; a draft or a returned week lists its visits apart.
  assert.equal(isManagerPlanSent("draft"), false);
  assert.equal(isManagerPlanSent("returned"), false);
  assert.equal(isManagerPlanSent("submitted"), true);
  const report = functionBody(source("src/lib/phoenix-crm/server/manager-plan-report.ts"), "export async function computeManagerReports(");
  assert.match(report, /loadManagerSlotRows\(planRows\.filter\(\(plan\) => isManagerPlanSent\(plan\.status\)\)/, "an unsent week's half-days are neither planned nor missed");
  assert.match(report, /visit\.managerHrId === managerHrId && \(visit\.isUnplanned \|\| !weekSent\)/, "and its visits are still shown, apart");

  // The board: a rep whose half emptied stays selectable while his ticks remain, and Mark all needs a customer.
  const board = source("src/components/phoenix-crm/manager-plan-board.tsx");
  const withRepPart = functionBody(board, "function WithRepPart(");
  assert.match(withRepPart, /const disabled = !canEdit \|\| \(nothingToTick && rep\.seatId !== keptSeatId\);/, "the rep he already ticked customers of stays selectable");
  assert.match(withRepPart, /\{chosen \|\| dropped\.length > 0 \? \(/, "the dropped customers are shown even when the rep's half is empty");
  assert.match(withRepPart, /disabled=\{tickable\.length === 0\}/, "Mark all is off when the rep has nobody on that half he can tick");
  assert.match(board, /useEffect\(\(\) => \(\) => onHidden\(\), \[\]\);/, "an edit made just before the board leaves the screen is sent on the way out");

  // The Team tab's pickers stay on screen while the next report or list loads.
  const team = source("src/components/phoenix-crm/manager-plan-team.tsx");
  assert.match(functionBody(team, "export function ManagerPlansSection("), /const pickers = view \?\? chosenFrom;/, "the week and manager pickers survive a pick");
  assert.match(functionBody(team, "export function ManagerOwnListSection("), /if \(!chosenFrom \|\| !chosenFrom\.managers\) return loading;/, "so does the own-list picker");

  // The visit form never pre-picks a Double visit on a territory with no rep to go with.
  const visitForm = source("src/components/phoenix-crm/visit-log-form.tsx");
  assert.match(visitForm, /useState<PhoenixCrmVisitKind>\(form\.ownVisitClosed && enteringManagerHasRep\(form\) \? "double" : "single"\)/, "Double is pre-picked only where it can be saved");

  // His own visit log asks for no photo.
  assert.equal(/\bphoto/i.test(source("src/lib/phoenix-crm/server/manager-visits.ts")), false, "a district manager's single visit takes no photo");

  // ── 9. After a regional manager, the NSM approves his asks too (owner, 2026-10-17) ────────────

  // "Week + edit asks + removals": his ask to reopen a sent week and his ask to take a customer off his
  // own list follow the week — the regional manager first, then the national sales manager stored on it.
  assert.equal(managerAskStage("pending"), "first", "an open ask waits on its first approver");
  assert.equal(managerAskStage("removal_pending"), "first");
  assert.equal(managerAskStage("first_approved"), "second", "after the regional manager agrees, it waits on the NSM above him");
  assert.equal(managerAskStage("removal_first_approved"), "second");
  for (const closed of ["reopened", "refused", "expired", "removed", "active", null]) {
    assert.equal(managerAskStage(closed), null, `an ask that is ${String(closed)} waits on nobody`);
  }

  const ali = viewerFor("A-12", "National Sales Manager", { canCreate: false });
  const askFirst = { stage: "first" as const, approverHrId: personKey("PD-0001"), secondApproverHrId: personKey("A-12"), isTest: false };
  const askSecond = { ...askFirst, stage: "second" as const };
  assert.equal(managerAskDeciderRole(hany, askFirst), "first", "the regional manager decides the first step of the ask");
  assert.equal(managerAskDeciderRole(ali, askFirst), null, "the NSM never takes the regional manager's step");
  assert.equal(managerAskDeciderRole(ali, askSecond), "second", "the NSM decides the second step");
  assert.equal(managerAskDeciderRole(hany, askSecond), null, "and the regional manager never decides it");
  assert.equal(managerAskDeciderRole(owner, askFirst), "administrator", "the Administrator acts in place of either holder");
  assert.equal(managerAskDeciderRole(owner, askSecond), "administrator");
  assert.equal(managerAskDeciderRole(nsm, { stage: "first", approverHrId: personKey("B-900"), secondApproverHrId: null, isTest: false }), "first", "with no regional manager, the NSM decides alone");
  assert.equal(managerAskDeciderRole(testNsm, { stage: "first", approverHrId: personKey("B-900"), secondApproverHrId: null, isTest: false }), null, "never across worlds");

  // The Hub's queue files each open item by its own step: the regional manager's turn, then the NSM's.
  assert.equal(managerQueuePlace("PD-0001", "first", "PD-0001", "A-12"), "awaiting", "the first step is the regional manager's turn");
  assert.equal(managerQueuePlace("A-12", "first", "PD-0001", "A-12"), "upcoming", "and is coming to the NSM");
  assert.equal(managerQueuePlace("A-12", "second", "PD-0001", "A-12"), "awaiting", "once the regional manager agrees it is the NSM's turn");
  assert.equal(managerQueuePlace("PD-0001", "second", "PD-0001", "A-12"), null, "and off the regional manager's list");
  assert.equal(managerQueuePlace("A-12", null, "PD-0001", "A-12"), null, "a closed ask waits on nobody");
  const queue = source("src/lib/phoenix-crm/server/manager-plan-queue.ts");
  assert.match(functionBody(queue, "async function loadOpenEditAsks("), /\.in\("status", \["pending", "first_approved"\]\)/, "an ask is open at either step");
  assert.match(functionBody(queue, "async function loadOpenRemovals("), /\.in\("status", \["removal_pending", "removal_first_approved"\]\)/, "so is a removal");
  const queueBody = functionBody(queue, "export async function loadManagerPlanQueue(");
  assert.match(queueBody, /managerQueuePlace\(me, stage, ask\.approverHrId, ask\.secondApproverHrId\)/, "an ask is filed by its own step");
  assert.match(queueBody, /managerQueuePlace\(me, stage, textOrNull\(row\.removal_approver_hr_id\), textOrNull\(row\.removal_second_approver_hr_id\)\)/, "and so is a removal");
  assert.match(
    functionBody(hub, "export async function getSecondApproverPlanRequests("),
    /fetchCrmManagerPlanRequestItems\(access, access\.hrId\)/,
    "the NSM's feed is every week stored with him as its second approver — the seat, never a named pair",
  );

  // The tracker: both steps from the moment it is asked, and a closed ask never shows a step it never reached.
  const stepNames = new Map<string, string>([
    ["PD-0040", "Mostafa Kamel"],
    ["PD-0001", "Hany Saad"],
    ["A-12", "Ali Mohamed Ali"],
  ]);
  const asked = {
    askedLabel: "Asked to edit",
    askerHrId: "PD-0040",
    askedAt: "2026-10-17T08:00:00Z",
    status: "open" as const,
    approverHrId: "PD-0001",
    secondApproverHrId: "A-12" as string | null,
    firstDecidedByHrId: null as string | null,
    firstDecidedRole: null as string | null,
    firstDecidedAt: null as string | null,
    decidedByHrId: null as string | null,
    decidedRole: null as string | null,
    decidedAt: null as string | null,
  };
  const trackOf = (track: Parameters<typeof askSteps>[0]) => askSteps(track, stepNames).map((step) => `${step.label}: ${step.who} (${step.state})`);
  assert.deepEqual(
    trackOf(asked),
    ["Asked to edit: Mostafa Kamel (done)", "Manager approval: Hany Saad (current)", "Second approval: Ali Mohamed Ali (waiting)"],
    "both steps show from the moment it is asked",
  );
  assert.deepEqual(trackOf({ ...asked, secondApproverHrId: null }), ["Asked to edit: Mostafa Kamel (done)", "Manager approval: Hany Saad (current)"], "one step where no regional manager sits above him");
  const agreed = { ...asked, status: "first_approved" as const, firstDecidedByHrId: "PD-0001", firstDecidedRole: "first", firstDecidedAt: "2026-10-17T09:00:00Z" };
  assert.deepEqual(trackOf(agreed).slice(1), ["Manager approval: Hany Saad (done)", "Second approval: Ali Mohamed Ali (current)"], "the regional manager agreed; the NSM decides now");
  assert.equal(askSteps({ ...agreed, firstDecidedRole: "administrator" }, stepNames)[1]?.who, "The Administrator", "a step the Administrator took says so");
  const done = { ...agreed, status: "approved" as const, decidedByHrId: "A-12", decidedRole: "second", decidedAt: "2026-10-17T10:00:00Z" };
  assert.deepEqual(trackOf(done).slice(1), ["Manager approval: Hany Saad (done)", "Second approval: Ali Mohamed Ali (done)"]);
  assert.deepEqual(
    trackOf({ ...asked, status: "refused", decidedByHrId: "PD-0001", decidedRole: "first", decidedAt: "2026-10-17T09:00:00Z" }).slice(1),
    ["Manager approval: Hany Saad (refused)"],
    "a refusal at the first step closes it there, and the second step is never drawn as still to come",
  );
  assert.deepEqual(
    trackOf({ ...agreed, status: "refused", decidedByHrId: "A-12", decidedRole: "second", decidedAt: "2026-10-17T10:00:00Z" }).slice(1),
    ["Manager approval: Hany Saad (done)", "Second approval: Ali Mohamed Ali (refused)"],
    "a refusal at the second step leaves the first step done",
  );
  assert.deepEqual(trackOf({ ...agreed, status: "expired", decidedRole: "system", decidedAt: "2026-10-23T00:00:00Z" }).slice(1), [
    "Manager approval: Hany Saad (done)",
    "Second approval: Ali Mohamed Ali (closed)",
  ]);

  // The NSM is told when the regional manager agrees — a notice of its own, naming who agreed first.
  const notice = {
    kind: "manager_plan" as const,
    seat: PDM,
    managerHrId: "PD-0040",
    recordId: UUID_A,
    planId: UUID_B,
    weekStart: "2026-10-17",
    note: "A rep sent after me",
    customerName: null,
    byAdministrator: false,
  };
  for (const step of ["edit_waiting", "removal_waiting"] as const) {
    const [toHany] = managerPlanDeliveries({ ...notice, step, recipientHrId: "PD-0001", actorHrId: "PD-0040", version: 1 }, stepNames);
    const [toAli] = managerPlanDeliveries({ ...notice, step, recipientHrId: "A-12", actorHrId: "PD-0001", version: 2, secondStep: true }, stepNames);
    assert.ok(toHany && toAli, `${step} is delivered at both steps`);
    assert.equal(toHany.message.includes("approved it first"), false, `${step}: the regional manager reads a plain ask`);
    assert.ok(toAli.message.includes("Hany Saad approved it first; it needs your approval too."), `${step}: the NSM reads who agreed first`);
    assert.deepEqual(toAli.recipients, ["A-12"], `${step}: the second notice goes to the NSM alone`);
    assert.notEqual(toHany.idempotencyKey, toAli.idempotencyKey, `${step}: the second notice is never swallowed as a repeat of the first`);
  }

  // The server: the ask stores the second approver, a step is decided only by its holder, and the page
  // names the step it showed.
  assert.match(functionBody(plans, "export async function raiseManagerPlanEdit("), /second_approver_hr_id: approvers\.secondHrId,/, "his ask to edit stores the NSM above a regional manager");
  const customers = source("src/lib/phoenix-crm/server/manager-customers.ts");
  assert.match(functionBody(customers, "export async function requestManagerCustomerRemoval("), /second_approver_hr_id: approvers\.secondHrId,/, "so does his ask to remove a customer");
  for (const [name, body] of [["the edit ask", decideEdit], ["the removal", decideRemoval]] as const) {
    assert.match(body, /if \(!stage \|\| \(body\.stage !== undefined && body\.stage !== stage\)\) throw conflictError\(/, `${name}: a page left open on a step already taken is refused`);
    assert.match(body, /managerAskDeciderRole\(viewer, \{ stage, approverHrId: [a-z]+\.approverHrId, secondApproverHrId: [a-z]+\.secondApproverHrId, isTest \}\)/, `${name}: only that step's holder decides it`);
    assert.match(body, /secondStep: true,/, `${name}: the NSM is told when the regional manager agrees`);
  }
  const actions = source("src/components/approvals-hub/manager-plan-decision-actions.tsx");
  assert.equal(actions.split("stage: target.stage ?? undefined").length - 1, 2, "the Hub sends the step it showed, for the ask and the removal");

  // The database: the step never depends on who decides, the code running before it keeps working, and an
  // ask nobody finished deciding closes with its week at either step.
  const asksSql = stripSqlComments(
    readFileSync(new URL("../supabase/migrations/20261017120000_phoenix_crm_manager_asks_second_approval.sql", import.meta.url), "utf8"),
  ).replace(/\r\n/g, "\n");
  const sqlFunction = (fn: string): string => {
    const start = asksSql.indexOf(`create or replace function public.${fn}(p jsonb)`);
    assert.ok(start >= 0, `${fn} is replaced`);
    return asksSql.slice(start, asksSql.indexOf("\n$$;", start));
  };
  for (const fn of [
    "phoenix_crm_raise_manager_plan_edit",
    "phoenix_crm_decide_manager_plan_edit",
    "phoenix_crm_expire_manager_plan_edit_requests",
    "phoenix_crm_request_manager_customer_removal",
    "phoenix_crm_decide_manager_customer_removal",
  ]) {
    assert.match(sqlFunction(fn).slice(0, 200), /security definer/, `${fn} is SECURITY DEFINER`);
    assert.ok(asksSql.includes(`revoke execute on function public.${fn}(jsonb) from public, anon, authenticated;`), `${fn} is revoked from the browser roles`);
    assert.ok(asksSql.includes(`grant execute on function public.${fn}(jsonb) to service_role;`), `${fn} is the service role's`);
  }
  assert.equal(/grant [^;]* to (anon|authenticated)\b/i.test(asksSql), false, "nothing is granted to a browser role");
  const decideEditSql = sqlFunction("phoenix_crm_decide_manager_plan_edit");
  assert.ok(
    decideEditSql.includes("v_stage := coalesce(v_stage, case when v_request.status = 'first_approved' then 'second' else 'first' end);"),
    "a caller that names no step decides the step the ask waits on — the code running before this deploy keeps working",
  );
  assert.ok(decideEditSql.includes("(v_role = 'first' and v_stage <> 'first') or (v_role = 'second' and v_stage <> 'second')"), "a holder decides only his own step");
  assert.ok(decideEditSql.includes("elsif v_stage = 'first' and v_request.second_approver_hr_id is not null then"), "the first approval passes it on whenever a second approver is stored");
  assert.ok(decideEditSql.indexOf("if v_decision = 'refuse' then") < decideEditSql.indexOf("elsif v_stage = 'first'"), "a refusal at either step closes the ask");
  const decideRemovalSql = sqlFunction("phoenix_crm_decide_manager_customer_removal");
  assert.ok(decideRemovalSql.includes("v_stage := coalesce(v_stage, case when v_row.status = 'removal_first_approved' then 'second' else 'first' end);"));
  assert.ok(decideRemovalSql.includes("if v_decision = 'approve' and v_stage = 'first' and v_row.removal_second_approver_hr_id is not null then"), "the customer stays on the list until the NSM approves too");
  for (const [name, text] of [["the edit ask", decideEditSql], ["the removal", decideRemovalSql]] as const) {
    assert.equal(
      /\b(?:if|elsif|when)\b[^\n]*v_role\s*(?:=|<>|!=|is distinct from|is not distinct from)\s*'administrator'/.test(text),
      false,
      `${name}: no decider's role closes a two-step ask at the first approval`,
    );
  }
  assert.ok(sqlFunction("phoenix_crm_expire_manager_plan_edit_requests").includes("where r.status in ('pending', 'first_approved')"), "an ask closes with its week at either step");
  assert.ok(asksSql.includes("on public.phoenix_crm_manager_plan_edit_requests (plan_id) where status in ('pending', 'first_approved');"), "one ask open per week, at either step");
  assert.ok(asksSql.includes("(status <> 'first_approved' or (second_approver_hr_id is not null and first_decided_at is not null))"), "an ask waits on a second step only when one was stored");

  // ── 10. The regional, national and product managers plan here too (owner, 2026-10-17) ─────────

  // Production's shape on 17 Oct 2026: Hany Saad's region of three under Ali Mohamed Ali, Ali's own
  // districts beside it (Cairo vacant but live, one vacant and not started), the line's "Others" bucket,
  // and the Anti Infective and CNS lines with their own national sales managers.
  const ped = (seatId: string, overrides: Partial<OrgSeat> & Pick<OrgSeat, "tier" | "path">): OrgSeat =>
    seat({ seatId, lineCode: "pedia", lineName: "Pedia", ...overrides });
  const wNsm = ped("W-PED-NSM", { tier: "NSM", path: ["SEAT-CEO", "W-PED-NSM"], occupantHrId: "A-12" });
  const wRsm = ped("W-PED-RSM", { tier: "RSM", path: [...wNsm.path, "W-PED-RSM"], occupantHrId: "PD-0001" });
  const wAlex = ped("W-PED-DM-ALEX", { tier: "DM", path: [...wRsm.path, "W-PED-DM-ALEX"], occupantHrId: "PD-0040", regionName: "Alex-BHR" });
  const wDelta1 = ped("W-PED-DM-D1", { tier: "DM", path: [...wRsm.path, "W-PED-DM-D1"], occupantHrId: "PD-0050", regionName: "Delta (1)" });
  const wDelta2 = ped("W-PED-DM-D2", { tier: "DM", path: [...wRsm.path, "W-PED-DM-D2"], occupantHrId: "PD-0060", regionName: "Delta (2)" });
  const wGiza = ped("W-PED-DM-GIZA", { tier: "DM", path: [...wNsm.path, "W-PED-DM-GIZA"], occupantHrId: "PD-0070", regionName: "Giza" });
  const wCairo = ped("W-PED-DM-CAIRO", { tier: "DM", path: [...wNsm.path, "W-PED-DM-CAIRO"], occupantHrId: null, regionName: "Cairo" });
  const wDark = ped("W-PED-DM-DARK", { tier: "DM", path: [...wNsm.path, "W-PED-DM-DARK"], occupantHrId: null, regionName: "Not started" });
  const wOthers = ped("W-PED-OTHERS", { tier: "DM", path: [...wNsm.path, "W-PED-OTHERS"], occupantHrId: null, isOtherPseudoDm: true });
  const wAlexRep = ped("W-PED-REP-ALEX", { tier: "REP", path: [...wAlex.path, "W-PED-REP-ALEX"], occupantHrId: "PD-0041" });
  const wCairoRep = ped("W-PED-REP-CAIRO", { tier: "REP", path: [...wCairo.path, "W-PED-REP-CAIRO"], occupantHrId: "PD-0081" });
  const wOthersRep = ped("W-PED-REP-OTHERS", { tier: "REP", path: [...wOthers.path, "W-PED-REP-OTHERS"], occupantHrId: null });
  const wAifNsm = seat({ seatId: "W-AIF-NSM", tier: "NSM", path: ["SEAT-CEO", "W-AIF-NSM"], occupantHrId: "B-900" });
  const wAifDm = seat({ seatId: "W-AIF-DM", tier: "DM", path: [...wAifNsm.path, "W-AIF-DM"], occupantHrId: "B-12", regionName: "Delta (1)" });
  const wAifRep = seat({ seatId: "W-AIF-REP", tier: "REP", path: [...wAifDm.path, "W-AIF-REP"], occupantHrId: "B-7" });
  const wCnsNsm = seat({ seatId: "W-CNS-NSM", tier: "NSM", path: ["SEAT-CEO", "W-CNS-NSM"], occupantHrId: "B-122", lineCode: "cns", lineName: "CNS" });
  const wCnsDm = seat({ seatId: "W-CNS-DM", tier: "DM", path: [...wCnsNsm.path, "W-CNS-DM"], occupantHrId: "B-502", lineCode: "cns", lineName: "CNS" });
  const wide = buildOrgIndex([
    CEO, wNsm, wRsm, wAlex, wDelta1, wDelta2, wGiza, wCairo, wDark, wOthers, wAlexRep, wCairoRep, wOthersRep, wAifNsm, wAifDm, wAifRep, wCnsNsm, wCnsDm,
  ]);
  const liveExceptDark = (entry: OrgSeat) => entry.seatId !== wDark.seatId;

  // The four kinds. A district manager seat comes first, then a national or regional seat, then the
  // product managers' role — Hossam Reda, the Marketing Manager, is not one of them.
  const asKind = (hrId: string, productManager = false) => managerPlanWriterOf(wide, hrId, { productManager })?.kind ?? null;
  assert.equal(asKind("PD-0001"), "rsm", "Hany Saad plans as the regional sales manager");
  assert.equal(asKind("A-12"), "nsm", "Ali Mohamed Ali as a national sales manager");
  assert.equal(asKind("B-900"), "nsm");
  assert.equal(asKind("B-122"), "nsm", "the CNS national sales manager too");
  assert.equal(asKind("PD-0040"), "dm", "a district manager stays a district manager");
  assert.equal(asKind("PD-0040", true), "dm", "whatever else he holds");
  assert.equal(asKind("B-155", true), "pm", "a product manager plans by the role");
  assert.equal(asKind("B-155"), null, "and nobody plans by a role that is not one of the two");
  assert.equal(asKind("PD-0041"), null, "a rep never plans a manager's week");
  assert.equal(asKind("B-2"), null, "the CEO plans none");
  assert.deepEqual([...PRODUCT_MANAGER_PLAN_ROLES].sort(), ["Group Product Manager", "Product Manager"], "Rasha and Ahmed's two roles, never the Marketing Manager's");
  const pmWriter = managerPlanWriterOf(wide, "B-155", { productManager: true });
  assert.equal(pmWriter?.seat, null, "a product manager's week sits on no seat");
  assert.deepEqual(pmWriter?.lineCodes, ["pedia", "anti_infective"], "and spans his two lines — never CNS");
  assert.deepEqual([...PRODUCT_MANAGER_PLAN_LINES], ["pedia", "anti_infective"]);
  assert.deepEqual(seniorPlanSeats(wide, "B-155"), [], "a product manager holds no regional or national seat, so nothing ever switches his legacy form off");
  assert.equal(managerPlannerTitle("rsm"), "Regional sales manager");
  assert.equal(managerPlannerTitle("pm"), "Product manager");

  // The scope he picks first. A district manager picks none; Hany his three; Ali every district below him,
  // Hany's grouped under Hany's region; a product manager a line, then its districts or "any rep".
  const scopesOf = (hrId: string, productManager = false, live = liveExceptDark) => {
    const writer = managerPlanWriterOf(wide, hrId, { productManager });
    assert.ok(writer, `${hrId} plans a week`);
    return managerPlanScopes(wide, writer, live);
  };
  assert.deepEqual(scopesOf("PD-0040"), [], "a district manager's scope is his own district");
  const hanyScopes = scopesOf("PD-0001");
  assert.deepEqual(hanyScopes.map((entry) => entry.dmSeatId), [wAlex.seatId, wDelta1.seatId, wDelta2.seatId], "Hany picks among his three district managers");
  assert.ok(hanyScopes.every((entry) => entry.regionSeatId === null), "his own region is never a group inside his own picker");
  const aliScopes = scopesOf("A-12");
  assert.deepEqual(
    aliScopes.map((entry) => entry.dmSeatId),
    [wAlex.seatId, wCairo.seatId, wDelta1.seatId, wDelta2.seatId, wGiza.seatId],
    "Ali picks every district below him: the vacant one whose team is live, never one not started, never Others",
  );
  assert.deepEqual(
    aliScopes.filter((entry) => entry.regionSeatId === wRsm.seatId).map((entry) => entry.dmSeatId),
    [wAlex.seatId, wDelta1.seatId, wDelta2.seatId],
    "Hany's three are grouped under Hany's region",
  );
  assert.equal(aliScopes.find((entry) => entry.dmSeatId === wDelta1.seatId)?.regionHrId, personKey("PD-0001"));
  assert.equal(aliScopes.find((entry) => entry.dmSeatId === wCairo.seatId)?.dmHrId, null, "a vacant district names no district manager");
  assert.equal(
    scopesOf("A-12", false, () => true).some((entry) => entry.dmSeatId === wOthers.seatId),
    false,
    "the per-line Others bucket is never a district, live or not",
  );
  const pmScopes = scopesOf("B-155", true);
  assert.deepEqual(
    pmScopes.map((entry) => entry.key),
    [
      `dm:${wAlex.seatId}`, `dm:${wCairo.seatId}`, `dm:${wDelta1.seatId}`, `dm:${wDelta2.seatId}`, `dm:${wGiza.seatId}`, "line:pedia",
      `dm:${wAifDm.seatId}`, "line:anti_infective",
    ],
    "a product manager picks Pedia or Anti Infective, then its district managers or any rep in the line",
  );
  assert.equal(pmScopes.some((entry) => entry.lineCode === "cns"), false, "never CNS");
  assert.deepEqual(
    managerScopeTerritories(wide, { dmSeatId: null, lineCode: "pedia" }, "B-155").map((entry) => entry.seatId),
    [wAlexRep.seatId, wCairoRep.seatId],
    "any rep in the line: every Pedia territory, a vacant district's included, never one under Others",
  );
  assert.deepEqual(managerScopeTerritories(wide, { dmSeatId: wCairo.seatId, lineCode: "pedia" }, "A-12").map((entry) => entry.seatId), [wCairoRep.seatId]);

  // A half-day carries the scope it was planned in, checked against who plans it; Admin carries none.
  const scoped = parseManagerSlotDraft({
    date: "2026-10-17", half: "AM", kind: "with_rep", repSeatId: wAlexRep.seatId, customers: [{ customerId: UUID_A }], scopeDmSeatId: wAlex.seatId, scopeLineCode: "pedia",
  });
  assert.ok(scoped.ok && scoped.value.scopeDmSeatId === wAlex.seatId && scoped.value.scopeLineCode === "pedia", "a with-a-rep half-day keeps its district manager");
  const office = parseManagerSlotDraft({ date: "2026-10-17", half: "PM", kind: "admin", activityType: "office", scopeDmSeatId: wAlex.seatId, scopeLineCode: "pedia" });
  assert.ok(office.ok && office.value.activityType === "office" && office.value.scopeDmSeatId === null, "Office is an Admin half-day, and Admin carries no scope");
  assert.equal(parseManagerSlotDraft({ date: "2026-10-17", half: "AM", kind: "with_rep", repSeatId: wAlexRep.seatId, customers: [{ customerId: UUID_A }], scopeDmSeatId: wAlex.seatId }).ok, false, "a district manager's seat always names its line");
  const officeHalf = { kind: "admin" as const, activityType: "office" as const, scopeDmSeatId: null, scopeLineCode: null };
  assert.match(managerSlotScopeError("dm", officeHalf, []) ?? "", /Office is not one of a district manager's half-days/, "Office is refused a district manager");
  for (const kind of ["rsm", "nsm", "pm"] as const) assert.equal(managerSlotScopeError(kind, officeHalf, []), null, `Office is a ${kind} planner's`);
  const withRepHalf = (scopeDmSeatId: string | null, scopeLineCode: string | null) => ({ kind: "with_rep" as const, activityType: null, scopeDmSeatId, scopeLineCode });
  assert.match(managerSlotScopeError("dm", withRepHalf(wAlex.seatId, "pedia"), []) ?? "", /your own district/, "a district manager's half-day names no other district");
  assert.match(managerSlotScopeError("rsm", withRepHalf(null, null), hanyScopes) ?? "", /Choose the district manager first/);
  assert.equal(managerSlotScopeError("rsm", withRepHalf(wDelta1.seatId, "pedia"), hanyScopes), null, "Hany plans in his own region");
  assert.match(managerSlotScopeError("rsm", withRepHalf(wGiza.seatId, "pedia"), hanyScopes) ?? "", /Choose one of the district managers shown/, "and never in Ali's Giza");
  assert.equal(managerSlotScopeError("pm", withRepHalf(null, "pedia"), pmScopes), null, "a product manager may skip the district manager");
  assert.ok(managerSlotScopeError("pm", withRepHalf(null, "cns"), pmScopes), "but never into CNS");
  assert.equal(managerAdminActivities("dm").some((entry) => entry.key === "office"), false, "a district manager's board offers no Office");
  for (const kind of ["rsm", "nsm", "pm"] as const) assert.equal(managerAdminActivities(kind)[0]?.key, "office", `the ${kind} board offers Office first`);

  // "As today, HR auto acknowledge": his own manager, then the CEO; one step when that manager IS the CEO.
  assert.equal(ceoHrIdOf(wide), personKey("B-2"));
  assert.deepEqual(legacyStyleApprovers({ plannerHrId: "PD-0001", managerHrId: "A-12", ceoHrId: "B-2" }), { firstHrId: personKey("A-12"), secondHrId: personKey("B-2") }, "Hany → Ali → the CEO");
  assert.deepEqual(legacyStyleApprovers({ plannerHrId: "B-900", managerHrId: "B-2", ceoHrId: "B-2" }), { firstHrId: personKey("B-2"), secondHrId: null }, "a national sales manager → the CEO, in one step");
  assert.deepEqual(legacyStyleApprovers({ plannerHrId: "B-156", managerHrId: "B-155", ceoHrId: "B-2" }), { firstHrId: personKey("B-155"), secondHrId: personKey("B-2") }, "Ahmed → Rasha → the CEO");
  assert.deepEqual(legacyStyleApprovers({ plannerHrId: "B-155", managerHrId: "B-150", ceoHrId: "B-2" }), { firstHrId: personKey("B-150"), secondHrId: personKey("B-2") }, "Rasha → Hossam → the CEO");
  assert.deepEqual(legacyStyleApprovers({ plannerHrId: "B-155", managerHrId: null, ceoHrId: "B-2" }), { firstHrId: personKey("B-2"), secondHrId: null }, "no manager on record → the CEO alone");
  assert.deepEqual(legacyStyleApprovers({ plannerHrId: "B-155", managerHrId: "b-155", ceoHrId: "B-2" }), { firstHrId: personKey("B-2"), secondHrId: null }, "never his own approver");
  const writers = source("src/lib/phoenix-crm/server/manager-plan-writers.ts");
  const approversFor = functionBody(writers, "export async function managerApproversFor(");
  assert.match(approversFor, /if \(writer\.kind === "dm" && writer\.seat\) \{\s*const approvers = managerPlanApprovers\(org, writer\.seat\.seatId\);/, "a district manager keeps his seat chain");
  assert.match(approversFor, /return legacyStyleApprovers\(\{ plannerHrId: writer\.hrId, managerHrId: await managerOfRecord\(writer\.hrId\), ceoHrId: ceoHrIdOf\(org\) \}\);/, "everyone else goes where the legacy plan goes");
  assert.match(
    functionBody(writers, "async function managerOfRecord("),
    /const present = rows\.length > 0 && !rows\.some\(/,
    "a manager of record who has left, or who has no employees row at all, is skipped and the week goes on to the CEO",
  );
  assert.match(functionBody(writers, "async function readProductManagerRoster("), /byPerson\.get\(hrId\)/, "two spellings of one product manager's id plan once");
  assert.match(writers, /Date\.now\(\) - lastGood\.readAt <= LAST_GOOD_ROSTER_MAX_AGE_MS \? lastGood\.roster : \[\]/, "the last good roster stands in for a short failure only, never for ever");
  for (const [name, text] of [
    ["the week", functionBody(plans, "export async function transitionManagerPlan(")],
    ["the edit ask", functionBody(plans, "export async function raiseManagerPlanEdit(")],
    ["the removal", functionBody(source("src/lib/phoenix-crm/server/manager-customers.ts"), "export async function requestManagerCustomerRemoval(")],
  ] as const) {
    assert.ok(text.includes("managerApproversFor(viewer.org, writer)") || text.includes("managerApproversFor(viewer.org, writer),"), `${name} asks the one approver rule`);
  }

  // The database: the kind defaults to a district manager's, a seat is required unless a product manager,
  // Office is refused a district manager, and HR acknowledges every approved week but a district manager's.
  const widerSql = stripSqlComments(
    readFileSync(new URL("../supabase/migrations/20261017213000_phoenix_crm_manager_plan_wider_writers.sql", import.meta.url), "utf8"),
  ).replace(/\r\n/g, "\n");
  assert.ok(widerSql.includes("add column if not exists planner_kind text not null default 'dm',"), "every week so far reads as a district manager's");
  assert.ok(widerSql.includes("check (planner_kind in ('dm', 'rsm', 'nsm', 'pm'))"));
  assert.ok(widerSql.includes("check (planner_kind = 'pm' or manager_seat_id is not null)"), "a seat is required unless a product manager");
  assert.ok(widerSql.includes("and (hr_acknowledged_at is null or planner_kind <> 'dm')"), "the table itself refuses an HR acknowledgement on a district manager's week");
  assert.match(widerSql, /if v_activity = 'office' and v_planner = 'dm' then\s*raise exception 'phoenix_crm:manager_plan_bad_kind';/, "the save refuses Office for a district manager");
  assert.ok(widerSql.includes("if v_action = 'approve' and v_plan.status = 'approved' and v_plan.planner_kind <> 'dm' then"), "the closing approval of any other week is acknowledged by HR");
  assert.ok(widerSql.includes("values (v_plan.id, 'hr_acknowledged', v_hr_ack, 'system', v_plan.status, v_plan.status, v_plan.version);"), "and the tracker reads that acknowledgement as an event");
  for (const fn of ["phoenix_crm_save_manager_plan_slot", "phoenix_crm_manager_plan_transition"]) {
    const at = widerSql.indexOf(`create or replace function public.${fn}(p jsonb)`);
    assert.ok(at >= 0, `${fn} is replaced`);
    assert.match(widerSql.slice(at, at + 200), /security definer/, `${fn} stays SECURITY DEFINER`);
    assert.ok(widerSql.includes(`revoke execute on function public.${fn}(jsonb) from public, anon, authenticated;`), `${fn} stays revoked from the browser roles`);
    assert.ok(widerSql.includes(`grant execute on function public.${fn}(jsonb) to service_role;`), `${fn} stays the service role's`);
  }
  assert.equal(/grant [^;]* to (anon|authenticated)\b/i.test(widerSql), false, "nothing is granted to a browser role");
  const hubSource = source("src/lib/phoenix-crm/server/manager-plan-hub.ts");
  assert.match(hubSource, /if \(plan\.plannerKind !== "dm"\) \{\s*steps\.push\(\{\s*label: "HR acknowledgement",\s*who: "HR, automatically",/, "the tracker shows HR's step on every week but a district manager's");

  // Who reads whom: Ali reads Hany's week; a product manager's week is read by the manager on his record.
  assert.equal(readsManagerPlanOf(ali, "PD-0001"), true, "Ali reads the regional manager's week below him");
  assert.equal(readsManagerPlanOf(hany, "A-12"), false, "and never the other way up");
  const roster = [{ hrId: personKey("B-155"), managerHrId: personKey("B-150") }, { hrId: personKey("B-156"), managerHrId: personKey("B-155") }];
  const asPlanner = (hrId: string, role: string, plansAsProductManager: boolean) =>
    ({ ...viewerFor(hrId, role, { canCreate: false }), plansAsProductManager, productManagers: roster }) as unknown as PhoenixCrmViewer;
  const ahmed = asPlanner("B-156", "Product Manager", true);
  const rasha = asPlanner("B-155", "Group Product Manager", true);
  const hossam = asPlanner("B-150", "Marketing Manager", false);
  assert.equal(assertManagerPlanWriter(ahmed).kind, "pm", "Ahmed plans his own week");
  assert.equal(managerPlanReach(ahmed)?.canWrite, true, "with read alone");
  assert.equal(readsManagerPlanOf(rasha, "B-156"), true, "Rasha reads Ahmed's week");
  assert.equal(readsManagerPlanOf(ahmed, "B-155"), false, "Ahmed never reads Rasha's");
  assert.equal(readsManagerPlanOf(hossam, "B-155"), true, "Hossam reads Rasha's");
  assert.equal(managerPlanReach(hossam)?.canWrite, false, "and plans none of his own");
  assert.throws(() => assertManagerPlanWriter(hossam), /Only a district, regional, national or product manager plans/);
  assert.equal(managerPlanDeciderRole(ceo, { stage: "second", firstApproverHrId: "A-12", secondApproverHrId: personKey("B-2"), isTest: false }), "second", "the CEO decides the step stored on the week, with read alone");
  assert.match(
    functionBody(source("src/lib/phoenix-crm/server/manager-plan-reach.ts"), "export function assertManagerPlanWriter("),
    /if \(writer\.kind === "dm" && !viewer\.canCreate\) throw forbiddenError\(/,
    "a district manager still needs create; the other kinds plan by their seat or role",
  );

  // The Team tab's choices: himself first when he plans too, then everyone he reads; none with nobody to choose.
  const nsmChoices = managerPlanChoices(nsm, managerPlanReach(nsm) ?? { mode: "own", managers: [] });
  assert.equal(nsmChoices?.[0]?.hrId, personKey("B-900"), "an NSM who plans sees his own week first");
  assert.equal(nsmChoices?.[0]?.kind, "nsm");
  assert.deepEqual(nsmChoices?.slice(1).map((entry) => entry.hrId).sort(), [personKey("B-1"), personKey("B-12"), personKey("B-76")].sort(), "then the district managers below him");
  assert.equal(managerPlanChoices(dm, managerPlanReach(dm) ?? { mode: "own", managers: [] }), null, "a district manager with nobody below has nothing to choose");
  const ceoChoices = managerPlanChoices(ceo, managerPlanReach(ceo) ?? { mode: "pick", managers: [] });
  assert.ok(ceoChoices && ceoChoices.length > 0 && ceoChoices.every((entry) => entry.hrId !== personKey("B-2")), "the CEO picks among everyone, never himself");
  for (const file of ["src/lib/phoenix-crm/server/manager-plan-report.ts", "src/lib/phoenix-crm/server/manager-customers.ts"]) {
    assert.match(source(file), /managerPlanChoices\(viewer, /, `${file} lists its managers through the one rule`);
  }

  // The switch: a regional or national seat switches with the first live team below it; a product
  // manager never does, and plans here beside his legacy form.
  const weekHere = functionBody(switchSource, "export async function plansManagerWeekHere(");
  assert.match(weekHere, /if \(writer\.kind === "pm"\) return true;\s*return dmPlansInPhoenixCrm\(/, "a product manager's board always opens; everyone else's with the switch");
  assert.match(
    functionBody(switchSource, "async function seniorPlansInPhoenixCrm("),
    /seats\.some\(\(seat\) => seatHasLiveTeamBelow\(org\.seats, seat\.seatId, live\)\)/,
    "a live team below the seat switches it",
  );
  assert.match(
    source("src/lib/phoenix-crm/live-team-rules.ts"),
    /liveSeatId !== seatId && seats\.get\(liveSeatId\)\?\.path\.includes\(seatId\)/,
    "…through the one shared rule: a team BELOW the seat, never the seat's own",
  );

  // Attendance: a switched regional or national manager is judged by the Office half-days of the new
  // plan; a product manager still by the legacy form he still files.
  const officeDays = source("src/lib/attendance/plan-office-days.ts");
  assert.match(officeDays, /statuses: \["approved"\],/, "only an approved week sets an office day");
  assert.match(officeDays, /if \(halfDay\.plannerKind !== "rsm" && halfDay\.plannerKind !== "nsm"\) continue;/, "the new plan is read for the switched seat holders alone");
  // Each half is one WEEKLY entry; the resolver (plan-office-resolution.ts) makes any Office half of
  // the governing plan an office day, and names the half when only one is Office (owner, 2026-10-19);
  // a Meeting half beside an Office half counts as office too, so it is read as well.
  assert.match(
    officeDays,
    /addEntry\(hrId, halfDay\.date, \{\s*kind: "weekly",\s*isOffice: halfDay\.kind === "admin" && halfDay\.activityType === "office",\s*isMeeting: halfDay\.kind === "admin" && halfDay\.activityType === "meeting",\s*slot: halfDay\.half === "AM" \? "am" : "pm",\s*\}\);/,
    "a manager's Phoenix CRM half-day is read as a weekly plan entry for its own half",
  );
  assert.equal(managerHalfLegacyType("admin", "office"), "Office", "every calendar reads an Office half-day as the legacy Office");

  // The report: a product manager stands with a rep in the visit's own product manager slot.
  assert.equal(countsAsPlannersVisitWithRep({ kind: "product_manager", managerHrId: null, seniorHrId: null, productManagerHrId: "b-155" }, "B-155"), true, "the rep's visit naming the product manager counts for him");
  assert.equal(countsAsPlannersVisitWithRep({ kind: "chain", managerHrId: "PD-0001", seniorHrId: null, productManagerHrId: "b-155" }, "B-155"), true, "and so does a chain visit that names him");
  assert.equal(countsAsPlannersVisitWithRep({ kind: "single", managerHrId: null, seniorHrId: null, productManagerHrId: "b-155" }, "B-155"), false, "a visit of a kind that cannot carry a product manager does not count for him");
  assert.equal(countsAsPlannersVisitWithRep({ kind: "single", managerHrId: "B-155", seniorHrId: null, productManagerHrId: null }, "B-155"), false, "a single visit in the manager slot is still no double visit");
  assert.equal(countsAsPlannersVisitWithRep({ kind: "double", managerHrId: "PD-0001", seniorHrId: null, productManagerHrId: null }, "PD-0001"), true);
  assert.match(source("src/lib/phoenix-crm/server/manager-plan-report.ts"), /readBy\("product_manager_hr_id", part\),/, "the report reads that slot");

  // The Hub: the District Manager tab carries district managers' weeks only; Company Plans the others'.
  assert.ok(hub.includes('fetchCrmManagerPlanRequestItems(access, null, "dm")'), "the district managers' feed");
  assert.ok(hub.includes('fetchCrmManagerPlanRequestItems(access, null, "others")'), "the regional, national and product managers' weeks on Company Plans");
  assert.ok(hub.includes('(row.plannerKind === "dm") === (kinds === "dm")'), "split by the week's own kind");

  // The routes: every writer reaches them with read — the writer rule decides, never the create grant.
  const routeFiles = filesUnder("app/api/phoenix-crm/manager-plans").filter((file) => file.endsWith("/route.ts"));
  assert.equal(routeFiles.length, 14, "the fourteen manager-plan routes");
  for (const file of routeFiles) {
    const text = source(file);
    assert.match(text, /assertPermission\(access, "phoenix_crm", "read"\)/, `${file} asks read`);
    assert.equal(/assertPermission\(access, "phoenix_crm", "(create|approve|update)"\)/.test(text), false, `${file} never asks a grant only a district manager holds`);
  }
  const registry = source("src/lib/security/access-registry.ts").split("\n").filter((line) => line.includes('pattern: "/api/phoenix-crm/manager-plans'));
  assert.equal(registry.length, 17, "seventeen declarations across the fourteen routes");
  for (const line of registry) assert.ok(line.includes('permission: { resource: "phoenix_crm", action: "read" }'), `declared on read: ${line.trim().slice(0, 120)}`);

  // 🔴 `read` at the door makes the SERVICE the gate: a Medical Rep holds `read` too. So each of the ten
  // mutating POSTs names the function it ends in, and that function holds the writer check or the stored
  // approver's. A new manager-plan POST with no row here fails — it cannot copy the `read` door without
  // declaring the gate behind it (the registry's own permission audit cannot tell the two apart).
  const writerGate = /assertManagerPlanWriter\(viewer\)/;
  const plansFile = "src/lib/phoenix-crm/server/manager-plans.ts";
  const customersFile = "src/lib/phoenix-crm/server/manager-customers.ts";
  // One function serves the send AND the decision, so each of those rows is held to ITS OWN branch, and
  // the check must stand before that branch's write — not merely somewhere in the function.
  const gates: Array<{ route: string; service: string; file: string; gate: RegExp[]; branch?: [string, string] }> = [
    { route: "/api/phoenix-crm/manager-plans", service: "saveManagerPlanSlot", file: plansFile, gate: [writerGate] },
    {
      route: "/api/phoenix-crm/manager-plans/submit",
      service: "transitionManagerPlan",
      file: plansFile,
      gate: [writerGate],
      branch: ['if (action === "submit") {', "callPhoenixCrm"],
    },
    {
      route: "/api/phoenix-crm/manager-plans/decide",
      service: "transitionManagerPlan",
      file: plansFile,
      gate: [/managerPlanDeciderRole\(viewer/],
      branch: ["const hasSecond", "callPhoenixCrm"],
    },
    { route: "/api/phoenix-crm/manager-plans/edit-requests", service: "raiseManagerPlanEdit", file: plansFile, gate: [writerGate] },
    { route: "/api/phoenix-crm/manager-plans/edit-requests/decide", service: "decideManagerPlanEdit", file: plansFile, gate: [/managerAskDeciderRole\(viewer/] },
    { route: "/api/phoenix-crm/manager-plans/customers", service: "addManagerCustomer", file: customersFile, gate: [writerGate] },
    { route: "/api/phoenix-crm/manager-plans/customers/match", service: "matchManagerCustomer", file: customersFile, gate: [writerGate] },
    { route: "/api/phoenix-crm/manager-plans/customers/locate", service: "locateManagerCustomer", file: customersFile, gate: [writerGate] },
    { route: "/api/phoenix-crm/manager-plans/customers/removal", service: "requestManagerCustomerRemoval", file: customersFile, gate: [writerGate] },
    { route: "/api/phoenix-crm/manager-plans/customers/removal/decide", service: "decideManagerCustomerRemoval", file: customersFile, gate: [/managerAskDeciderRole\(viewer/] },
    { route: "/api/phoenix-crm/manager-plans/visits", service: "logManagerVisit", file: "src/lib/phoenix-crm/server/manager-visits.ts", gate: [writerGate] },
  ];
  const registeredPosts = accessRegistry
    .filter((entry) => entry.pattern.startsWith("/api/phoenix-crm/manager-plans") && entry.methods.includes("POST"))
    .map((entry) => entry.pattern)
    .sort();
  assert.deepEqual(registeredPosts, gates.map((row) => row.route).sort(), "every manager-plan POST declares the service gate behind its read door");
  for (const { route, service, file, gate, branch } of gates) {
    assert.ok(source(`app${route}/route.ts`).includes(`await ${service}(viewer`), `POST ${route} ends in ${service}`);
    const whole = functionBody(source(file), `export async function ${service}(`);
    let body = whole;
    if (branch) {
      const start = whole.indexOf(branch[0]);
      assert.ok(start >= 0, `${service} (POST ${route}) still opens its branch with ${branch[0]}`);
      const end = whole.indexOf(branch[1], start + branch[0].length);
      assert.ok(end > start, `${service} (POST ${route}) still writes through ${branch[1]} inside that branch`);
      body = whole.slice(start, end);
    }
    for (const check of gate) assert.match(body, check, `${service} (POST ${route}) holds its writer or approver check before its write`);
  }

  // The board: the scope picker, the half-day override, and the HR line on a non-district manager's send.
  assert.match(board, /function ScopePicker\(/, "the board picks the district manager first");
  assert.match(board, /Another district manager for this half/, "once per day, a half on request");
  assert.match(board, /Once it is approved, HR acknowledges it automatically\./, "the send step names HR's automatic acknowledgement");

  // ── A district manager's single visits: two days a week, four half-days (owner, 2026-10-17) ───

  assert.equal(DM_SINGLE_VISIT_HALF_DAYS_MAX, 4, "two full days of single visits a week are four half-days");
  const fourUsed = new Set([
    singleVisitHalfKey("2026-10-24", "AM"),
    singleVisitHalfKey("2026-10-24", "PM"),
    singleVisitHalfKey("2026-10-26", "AM"),
    singleVisitHalfKey("2026-10-28", "AM"),
  ]);
  assert.equal(dmSingleVisitCapError(new Set(), singleVisitHalfKey("2026-10-24", "AM"), "plan"), null, "an empty week takes one");
  assert.equal(dmSingleVisitCapError(new Set([...fourUsed].slice(0, 3)), singleVisitHalfKey("2026-10-29", "AM"), "plan"), null, "the fourth half-day still fits");
  assert.match(dmSingleVisitCapError(fourUsed, singleVisitHalfKey("2026-10-29", "AM"), "plan") ?? "", /four half-days/, "the fifth half-day is refused");
  assert.match(dmSingleVisitCapError(fourUsed, singleVisitHalfKey("2026-10-27", "PM"), "visit") ?? "", /cannot be logged/, "a visit that opens a fifth half-day is refused");
  assert.equal(dmSingleVisitCapError(fourUsed, singleVisitHalfKey("2026-10-26", "AM"), "visit"), null, "a half-day the week already spends on single visits is no new one");
  assert.equal(singleVisitHalfOfHour(11), "AM", "before noon is the morning");
  assert.equal(singleVisitHalfOfHour(12), "PM", "from noon is the afternoon");
  assert.equal(/\b(he|his|him|doctors?|accounts?)\b/i.test(dmSingleVisitCapError(fourUsed, "x|AM", "plan") ?? ""), false, "the words say you and customers, never he or doctors");

  const capSource = source("src/lib/phoenix-crm/server/manager-single-visit-cap.ts");
  assert.match(functionBody(source("src/lib/phoenix-crm/server/manager-plans.ts"), "export async function saveManagerPlanSlot("), /draft\.kind === "single_visit" && own\) \{\s*await assertSingleVisitPlanFits\(/, "a district manager's plan save asks the limit");
  assert.match(functionBody(source("src/lib/phoenix-crm/server/manager-visits.ts"), "export async function logManagerVisit("), /slotId === null && writer\.kind === "dm"\) \{\s*await assertSingleVisitLogFits\(/, "an unplanned visit he logs asks the limit");
  assert.match(capSource, /\.from\("phoenix_crm_manager_visits"\)[\s\S]*singleVisitHalfOfHour\(cairoHourOf\(visit\.created_at\)\)/, "the visits he logged count, an unplanned one by the Cairo half it was logged in");
  assert.match(capSource, /slot\.kind === "single_visit"\) used\.add/, "the single-visit half-days of his plan count");

  // ── The weekly-plan audit, group C (owner, 2026-10-18) ──────────────────────────────────────────

  // C1 — an ask to edit is live only while its week is still a sent one.
  for (const planStatus of ["submitted", "first_approved", "approved"] as const) {
    assert.equal(isManagerAskLive("pending", planStatus), true, `an ask waiting on the first step is live on a ${planStatus} week`);
    assert.equal(isManagerAskLive("first_approved", planStatus), true, `an ask waiting on the second step is live on a ${planStatus} week`);
  }
  for (const planStatus of ["returned", "draft", null, undefined] as const) {
    assert.equal(isManagerAskLive("pending", planStatus), false, `an ask still open on a ${String(planStatus)} week decides nothing`);
    assert.equal(isManagerAskLive("first_approved", planStatus), false, `a second-step ask on a ${String(planStatus)} week decides nothing`);
  }
  for (const closed of ["reopened", "refused", "expired", "removal_pending", "removal_first_approved", null, ""]) {
    assert.equal(isManagerAskLive(closed, "approved"), false, `${String(closed)} is not an open edit ask`);
  }

  // The Hub's readers all ask it, so a week returned under an ask never reaches a queue, a badge or a Reopen.
  const queueSource = source("src/lib/phoenix-crm/server/manager-plan-queue.ts");
  assert.match(functionBody(queueSource, "async function loadOpenEditAsks("), /isManagerAskLive\(ask\.status, weeks\.get\(ask\.planId\)\)/, "the queue drops an open ask whose week is no longer a sent one");
  assert.match(functionBody(queueSource, "export async function loadManagerOwnRequests("), /isManagerAskLive\(ask\.status, weekStatuses\.get\(ask\.planId\)\)/, "his own requests do not show it as still waiting");
  assert.match(functionBody(source("src/lib/phoenix-crm/server/manager-plans.ts"), "async function buildBoard("), /isManagerAskLive\(latestAsk\.status, plan\?\.status \?\? null\)/, "the board does not say a returned week has an ask waiting");
  assert.match(functionBody(source("src/lib/phoenix-crm/server/manager-plan-hub.ts"), "async function planDetail("), /isManagerAskLive\(ask\.status, plan\.status\)/, "the Hub detail offers no decision on such an ask");
  for (const file of ["manager-plan-queue.ts", "manager-plan-rows.ts"]) {
    assert.equal(/notifications\/(in-app|phoenix-crm-)/.test(stripComments(source(`src/lib/phoenix-crm/server/${file}`))), false, `${file} still imports no notice sender (the import cycle)`);
  }

  // The database half of C1 and C2: one migration replaces exactly two functions and writes no row.
  const closesSql = stripSqlComments(
    readFileSync(new URL("../supabase/migrations/20261018234000_phoenix_crm_manager_plan_ask_closes_with_its_week.sql", import.meta.url), "utf8"),
  ).replace(/\r\n/g, "\n");
  const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
  const fnText = (sql: string, fn: string): string => {
    const start = sql.indexOf(`create or replace function public.${fn}(p jsonb)`);
    assert.ok(start >= 0, `${fn} is defined`);
    const end = sql.indexOf("\n$$;", start);
    assert.ok(end > start, `${fn} ends in $$;`);
    return sql.slice(start, end + 4);
  };
  const stripped = (text: string, ...cuts: RegExp[]): string => cuts.reduce((rest, cut) => rest.replace(cut, ""), text);

  const newTransition = fnText(closesSql, "phoenix_crm_manager_plan_transition");
  const closeBlock = /if v_action in \('submit', 'return'\) then\s+with closed as \([\s\S]*?from closed c;\s+end if;/;
  const block = newTransition.match(closeBlock)?.[0] ?? "";
  assert.ok(block !== "", "the transition closes the asks of the week it returns or re-sends");
  const blockSql = squash(block);
  assert.match(blockSql, /update public\.phoenix_crm_manager_plan_edit_requests r set status = 'expired', decided_at = now\(\), decided_by_hr_id = null, decided_role = 'system',/, "the ask closes as expired, by the system, exactly like the expiry pass");
  assert.match(blockSql, /where r\.plan_id = v_plan\.id and r\.status in \('pending', 'first_approved'\)/, "only an ask still open on THIS week is closed");
  assert.match(blockSql, /'edit_expired', 'SYSTEM', 'system', v_plan\.status, v_plan\.status, v_plan\.version/, "each closed ask writes the same event the expiry pass writes");
  assert.ok(blockSql.includes("'week_returned'") && blockSql.includes("'week_sent_again'"), "and the event says which of the two closed it");
  const closePos = newTransition.indexOf(block);
  assert.ok(closePos > newTransition.indexOf("insert into public.phoenix_crm_manager_plan_events"), "it runs in the same call, after the week's own event");
  assert.ok(closePos < newTransition.indexOf("'hr_acknowledged'"), "and before the HR acknowledgement step, so one transaction holds all of it");

  // Nothing else in either function moved: take the new text away and the live predecessor is left, to the character.
  const wider = stripSqlComments(readFileSync(new URL("../supabase/migrations/20261017213000_phoenix_crm_manager_plan_wider_writers.sql", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.equal(squash(stripped(newTransition, closeBlock)), squash(fnText(wider, "phoenix_crm_manager_plan_transition")), "the transition is the wider-writers function plus the close block and nothing else");

  const newDecide = fnText(closesSql, "phoenix_crm_decide_manager_plan_edit");
  assert.match(newDecide, /hr_acknowledged_at = null,\s+hr_acknowledged_by_hr_id = null,\s+version = pl\.version \+ 1,/, "a reopen clears HR's automatic acknowledgement of the approval it undoes");
  assert.equal(
    squash(stripped(newDecide, /hr_acknowledged_at = null,\s+hr_acknowledged_by_hr_id = null,\s+/)),
    squash(fnText(stripSqlComments(readFileSync(new URL("../supabase/migrations/20261017120000_phoenix_crm_manager_asks_second_approval.sql", import.meta.url), "utf8")).replace(/\r\n/g, "\n"), "phoenix_crm_decide_manager_plan_edit")),
    "the decision is the second-approval function plus the two cleared columns and nothing else",
  );
  const outsideBodies = closesSql.replace(/create or replace function[\s\S]*?\n\$\$;/g, "");
  assert.equal(/\b(insert|update|delete|alter|drop|truncate|create table|create index)\b/i.test(outsideBodies), false, "outside the two functions the migration changes no row, table or index");
  assert.equal((closesSql.match(/create or replace function/g) ?? []).length, 2, "it replaces exactly two functions");
  for (const fn of ["phoenix_crm_manager_plan_transition", "phoenix_crm_decide_manager_plan_edit"]) {
    const text = fnText(closesSql, fn);
    assert.match(text.slice(0, 250), /security definer/, `${fn} stays SECURITY DEFINER`);
    assert.match(text.slice(0, 250), /set search_path to 'public'/, `${fn} keeps its fixed search path`);
    assert.ok(closesSql.includes(`revoke execute on function public.${fn}(jsonb) from public, anon, authenticated;`), `${fn} stays revoked from the browser roles`);
    assert.ok(closesSql.includes(`grant execute on function public.${fn}(jsonb) to service_role;`), `${fn} stays the service role's`);
  }
  assert.equal(/grant [^;]* to (anon|authenticated)\b/i.test(closesSql), false, "nothing is granted to a browser role");
  assert.equal(closesSql.includes("phoenix_crm_manager_visits"), false, "the migration reads and writes no visit");

  // C2 — the stamp is read only on an approved week, so a reopened or returned one can never read as acknowledged.
  const planRaw = { id: "p-1", manager_hr_id: "B-155", week_start: "2026-10-24", hr_acknowledged_at: "2026-10-26T08:00:00Z" };
  assert.equal(managerPlanRowOf({ ...planRaw, status: "approved" })?.hrAcknowledgedAt, "2026-10-26T08:00:00Z", "an approved week keeps its acknowledgement");
  for (const status of ["draft", "submitted", "first_approved", "returned"]) {
    assert.equal(managerPlanRowOf({ ...planRaw, status })?.hrAcknowledgedAt, null, `a ${status} week reads as not acknowledged`);
  }

  // C3 — a Friday visit is outside no week: the limit and the report read one window, Saturday through Friday.
  assert.deepEqual(managerVisitWindow("2026-10-17"), { from: "2026-10-17", to: "2026-10-23" }, "the window is seven days from the Saturday");
  assert.equal(weekdayOfIsoDay(managerVisitWindow("2026-10-17").to), 5, "and ends on the Friday");
  assert.equal(fieldWeekStart("2026-10-23"), "2026-10-17", "that Friday belongs to the field week the window opens");
  assert.equal(fieldWeekStart("2026-10-24"), "2026-10-24", "and the next Saturday opens the next window");
  const reportSource = source("src/lib/phoenix-crm/server/manager-plan-report.ts");
  for (const [name, text] of [["the cap", capSource], ["the report", reportSource]] as const) {
    assert.ok(text.includes("managerVisitWindow(") && text.includes("managerVisitWindow,"), `${name} reads its visits over the shared window`);
    assert.equal(/addDaysIso\([^)]*,\s*5\)/.test(stripComments(text)), false, `${name} does not hand-roll a Thursday-ending visit window`);
  }
  assert.match(reportSource, /loadManagerVisits\(managers, managerVisitWindow\(weekStart\), isTest\)/, "the report's visits are read over it");
  assert.match(reportSource, /const weekEnd = managerVisitWindow\(weekStart\)\.to;/, "and so are the visits a rep logged with a manager");
  assert.match(capSource, /\.gte\("visit_date", visitDays\.from\)\s*\.lte\("visit_date", visitDays\.to\)/, "the limit's visits too");
  assert.equal(/export function managerVisitWindow/.test(source("src/lib/phoenix-crm/server/manager-visits.ts")), false, "there is one window, not a second one beside it");
  assert.equal(weekdayOfIsoDay("2026-10-23"), 5, "Friday is still not a planning day");

  // C4 and C5 — the report's counts: a customer who left the list is listed but owed nothing, and one visit answers a customer once.
  const row = (outcome: "done" | "not_done" | "open" | "ahead" | "not_checkable", evidenceKey: string | null, gone = false) => ({ outcome, gone, evidenceKey });
  assert.deepEqual(countManagerOutcomes([]), { planned: 0, done: 0, notDone: 0 }, "an empty week counts nothing");
  assert.deepEqual(
    countManagerOutcomes([row("done", "a"), row("not_done", "b"), row("open", "c"), row("ahead", "d"), row("not_checkable", null)]),
    { planned: 4, done: 1, notDone: 1 },
    "done, not done, open and ahead are planned; an admin half-day is counted nowhere",
  );
  assert.deepEqual(countManagerOutcomes([row("not_done", "a", true), row("done", "b", true), row("open", "c", true), row("done", "d")]), { planned: 1, done: 1, notDone: 0 }, "a customer who left the list is in none of the three counts, however his row reads");
  assert.deepEqual(countManagerOutcomes([row("done", "own|2026-10-26|c:1"), row("done", "own|2026-10-26|c:1")]), { planned: 1, done: 1, notDone: 0 }, "the same customer in both halves of one day, visited, is one done");
  assert.deepEqual(countManagerOutcomes([row("not_done", "own|2026-10-26|c:1"), row("not_done", "own|2026-10-26|c:1")]), { planned: 1, done: 0, notDone: 1 }, "and unvisited is one missed, never two");
  assert.deepEqual(countManagerOutcomes([row("done", "own|2026-10-26|c:1"), row("done", "own|2026-10-27|c:1")]), { planned: 2, done: 2, notDone: 0 }, "the same customer on two different days is two visits");
  assert.deepEqual(countManagerOutcomes([row("done", "own|2026-10-26|c:1"), row("done", "own|2026-10-26|c:2")]), { planned: 2, done: 2, notDone: 0 }, "two customers in one day are two visits");
  assert.deepEqual(countManagerOutcomes([row("open", null), row("open", null)]), { planned: 2, done: 0, notDone: 0 }, "rows that can share no evidence are never merged");
  assert.deepEqual(countManagerOutcomes([row("done", "k", true), row("done", "k")]), { planned: 1, done: 1, notDone: 0 }, "a gone row does not use up the key a live row counts under");

  const evidence = (kind: "with_rep" | "single_visit" | "admin", over: Partial<{ repSeatId: string | null; customerId: string | null; managerCustomerId: string | null }> = {}) =>
    managerEvidenceKey({ kind, repSeatId: "S-1", date: "2026-10-26", customerId: "c1", managerCustomerId: null, ...over });
  assert.equal(evidence("single_visit"), evidence("single_visit"), "a customer's single visit has one key however many halves he is in");
  assert.notEqual(evidence("single_visit"), evidence("single_visit", { customerId: "c2" }), "another customer has another");
  assert.equal(evidence("single_visit", { customerId: null, managerCustomerId: "m1" }), "own|2026-10-26|m:m1", "Manager's own customer is keyed by himself");
  assert.equal(evidence("with_rep"), "rep|S-1|2026-10-26|c1", "a with-rep customer is keyed by seat, day and customer");
  assert.notEqual(evidence("with_rep"), evidence("with_rep", { repSeatId: "S-2" }), "a second rep's visit is another visit");
  assert.notEqual(evidence("with_rep"), evidence("single_visit"), "his own visit never answers a rep's");
  assert.equal(evidence("with_rep", { repSeatId: null }), null, "a with-rep row with no rep shares nothing");
  assert.equal(evidence("admin"), null, "an admin half-day shares nothing");
  assert.equal(evidence("single_visit", { customerId: null, managerCustomerId: null }), null, "and neither does a single visit with no customer");

  assert.match(reportSource, /\{ \.\.\.countManagerOutcomes\(countRows\), unplanned: unplanned\.length \}/, "the report counts through the one pure function");
  assert.equal(/summary\.(planned|done|notDone) \+= 1/.test(stripComments(reportSource)), false, "and no longer counts rows by hand");
  assert.match(reportSource, /gone: row\.gone,/, "a customer who left the list is handed to it as gone");
  assert.match(reportSource, /name: row\.name,\s+own: row\.managerCustomerId !== null,/, "while every row is still listed");

  // ── A rep still in the OLD CRM: his plan on the board, and his week approved (owner, 2026-10-17) ───

  // The old plan names a day and no morning or afternoon, so a contact goes where his LIST puts him.
  assert.equal(oldCrmHalfOf({ matched: true, listType: "AM", speciality: "Cardiology" }), "AM", "an AM-list customer is the morning");
  assert.equal(oldCrmHalfOf({ matched: true, listType: "PM", speciality: "Cardiology" }), "PM", "a PM-list customer is the afternoon");
  assert.equal(oldCrmHalfOf({ matched: true, listType: "Pharmacy", speciality: "Pharmacy" }), null, "a pharmacy on the list is never planned with a rep");
  assert.equal(oldCrmHalfOf({ matched: false, listType: null, speciality: "Pharmacy" }), null, "an unmatched pharmacy is left out by its speciality");
  assert.equal(oldCrmHalfOf({ matched: false, listType: null, speciality: "Cardiology" }), "PM", "an unmatched customer shows in the afternoon, where the customers sit");

  // The plan a week stands on: the newest plan id, at the LOWEST status it carries.
  const oldEntries = [
    { crmPlanId: 27460, status: 1, id: "a" },
    { crmPlanId: 27500, status: 1, id: "b" },
    { crmPlanId: 27500, status: 0, id: "c" },
  ];
  const oldPlan = oldCrmPlanOf(oldEntries);
  assert.equal(oldPlan?.crmPlanId, 27500, "the newest plan of the week");
  assert.deepEqual(oldPlan?.entries.map((entry) => entry.id), ["b", "c"], "only its own rows");
  assert.equal(oldPlan?.status, 0, "a half-approved plan reads as waiting, never as signed");
  assert.equal(oldCrmPlanOf([]), null, "no rows, no plan");

  // What may be pressed is the vendor's own rule, so this screen and the admin board never disagree.
  assert.deepEqual(oldCrmApprovalOptions(0), { canApprove: true, canTakeBack: false }, "waiting: approve");
  assert.deepEqual(oldCrmApprovalOptions(1), { canApprove: false, canTakeBack: true }, "approved by the district manager: take it back");
  assert.deepEqual(oldCrmApprovalOptions(2), { canApprove: false, canTakeBack: false }, "an area manager's signature is never overwritten or cleared");
  assert.deepEqual(oldCrmApprovalOptions(null), { canApprove: false, canTakeBack: false }, "no status, nothing to press");
  assert.equal(oldCrmActionToVerification("approve"), "verify");
  assert.equal(oldCrmActionToVerification("take_back"), "unverify");
  assert.equal(isOldCrmPlanAction("approve") && isOldCrmPlanAction("take_back"), true);
  assert.equal(isOldCrmPlanAction("verify") || isOldCrmPlanAction("return") || isOldCrmPlanAction(undefined), false, "a typo is refused, never promoted into a write");
  for (const status of [0, 1, 2, null]) {
    assert.equal(/\b(he|his|him|doctors?|accounts?|verified|pending)\b/i.test(oldCrmStatusLabel(status)), false, `the label for ${status} is in Phoenix's words`);
  }

  const boardServer = source("src/lib/phoenix-crm/server/manager-plans.ts");
  const loadRepWeeksBody = functionBody(boardServer, "export async function loadRepWeeks(");
  assert.match(loadRepWeeksBody, /oldCrmReps\.filter\(\(rep\) => weeks\.get\(rep\.seatId\)\?\.state === "no_plan"\)/, "only a rep with NO Phoenix plan is read from the old CRM");
  assert.match(loadRepWeeksBody, /week\.state = "old_crm"/, "his week is marked as the old CRM's");
  assert.match(boardServer, /repWeekSent: repWeek\?\.state === "sent" \|\| repWeek\?\.state === "old_crm"/, "a plan filed in the old CRM is a filed plan, not a draft");
  assert.match(functionBody(boardServer, "async function assertOnTheRepsHalf("), /oldCrmRepsOf\(\[\{ seatId: input\.repSeatId, hrId: input\.repHrId \}\]\)/, "the server's tick check reads the old plan too");
  const oldWeeks = source("src/lib/phoenix-crm/server/manager-old-crm-weeks.ts");
  assert.match(oldWeeks, /if \(input\.isTest \|\| input\.reps\.length === 0\) return weeks;/, "the test world holds no vendor plan");
  assert.match(oldWeeks, /own_contact_crm_id\.in\.\(\$\{list\}\),reference_contact_crm_id\.in\.\(\$\{list\}\)/, "a contact is matched through either id the carry-over kept");
  assert.match(oldWeeks, /\.in\("seat_id", \[\.\.\.seatIds\]\)/, "only on the rep's own seat");
  assert.match(oldWeeks, /customerId: customer \? String\(customer\.id\) : null/, "an unmatched contact shows and cannot be ticked");
  const planBoardDoor = source("src/lib/crm/plan-board.ts");
  // 🔴 The old plan of a rep in a STARTED team is hidden by the unified view (it anti-joins him from his
  // `counted_from`), so the read must come from the vendor's own rows: on 2026-10-18 the mirror held 22 reps'
  // weeks for 17 Oct and the view let 0 through, and the board greyed every one of them out.
  const weekEntriesBody = functionBody(planBoardDoor, "export async function getAgentsWeekPlanEntries(");
  assert.match(weekEntriesBody, /\.from\(CRM_PLAN_ENTRIES_TABLE\)[\s\S]*\.eq\("plan_kind", "weekly"\)/, "a rep's old plan is read from the vendor's own rows, weekly only");
  assert.equal(weekEntriesBody.includes("CRM_PLAN_ENTRIES_UNIFIED_VIEW"), false, "never through the counting view — it drops every rep of a started team");
  assert.equal(weekEntriesBody.includes('"source"'), false, "the raw table has no source column and holds no Phoenix plan");

  const approval = source("src/lib/phoenix-crm/server/old-crm-plan-approval.ts");
  const decideBody = functionBody(approval, "export async function decideOldCrmPlan(");
  assert.match(decideBody, /viewer\.isSuperAdmin\) \{\s*throw forbiddenError/, "the Super Admin approves no rep's week");
  assert.match(decideBody, /canAccessPlanVerification\(viewer\.access\)[\s\S]*assertPermission\(viewer\.access, "crm_plans", "approve"\)/, "the admin board's role list and its crm_plans grant");
  assert.match(decideBody, /resolveVendorSyncStandDown\(\)/, "nothing is written into a retired vendor");
  assert.match(decideBody, /scope = await getPlanVerificationScope\(viewer\.access\)/, "the reach is resolved from the live access, never from the body");
  assert.match(decideBody, /action: oldCrmActionToVerification\(action\)/, "the one write is the vendor's own supervisor approval");
  assert.equal(/status:\s*1\b/.test(approval), false, "the status number is the vendor rule's to choose, never written here");
  assert.match(functionBody(source("src/lib/phoenix-crm/server/plans.ts"), "export async function loadPlanReviews("), /oldCrm: plan \? null : \(oldCrmPlans\.get\(seat\.seatId\) \?\? null\)/, "a rep's Phoenix week is never replaced by his old one");
  assert.match(source("src/lib/security/access-registry.ts"), /pattern: "\/api\/phoenix-crm\/plans\/old-crm\/decide"[^\n]*csrfRequired: true/, "the new route is declared, with CSRF");
  assert.match(source("app/api/phoenix-crm/plans/old-crm/decide/route.ts"), /assertSameOriginMutation\(request\)[\s\S]*assertPermission\(access, "phoenix_crm", "approve"\)/, "same-origin and the module grant first");
  const teamTab = source("src/components/phoenix-crm/team-tab.tsx");
  assert.match(teamTab, /if \(!row\.plan && row\.oldCrm\) \{\s*return <OldCrmActions/, "his old week is approved here, not opened as an empty Phoenix plan");
  const boardScreen = source("src/components/phoenix-crm/manager-plan-board.tsx");
  assert.match(boardScreen, /Not on the rep&apos;s Phoenix list/, "an unmatched customer says why it cannot be ticked");
  for (const text of [teamTab, boardScreen, approval]) {
    const oldCrmLines = text.split("\n").filter((line) => /old CRM/i.test(line));
    assert.equal(oldCrmLines.some((line) => /\bdoctors?\b/i.test(line)), false, "the old-CRM words say customers, never doctors");
  }

  // ── The words on his screens ─────────────────────────────────────────────────────────────────

  for (const screen of ["src/components/approvals-hub/manager-plan-request-detail.tsx", "src/components/approvals-hub/manager-plan-decision-actions.tsx"]) {
    assert.equal(/\b(doctors?|accounts?)\b/i.test(source(screen)), false, `${screen} says customers, never doctors or accounts`);
  }
  // ── A customer he adds: only the name, grades and an area are needed; the area → brick drop-lists cascade ─
  // Owner, 2026-10-17: "must enter his speciality, his name, his phone number, and either fill the address,
  // brick and area manually, or capture the location and the capture fills these fields" — then, the same
  // night: "make all optional … make the area and brick drop-list cascading … make everything we did now optional".

  const baseCustomer = { name: "Samir Adel", areaChosen: true, grade: "A", potentialGrade: "AA" };
  assert.equal(missingManagerCustomerField(baseCustomer), null, "a name, a grade, a potential grade and an area are enough — the rest is optional");
  for (const [broken, pattern] of [
    [{ ...baseCustomer, name: null }, /name/],
    [{ ...baseCustomer, grade: null }, /grade/],
    [{ ...baseCustomer, potentialGrade: "ZZ" }, /potential grade/],
    [{ ...baseCustomer, areaChosen: false }, /area/],
  ] as const) {
    const lacking = missingManagerCustomerField(broken);
    assert.match(lacking ?? "", pattern, `a customer short of ${pattern} is refused`);
    assert.equal(/\b(he|his|him|doctors?|accounts?)\b/i.test(lacking ?? ""), false, "the sentence says customer, never he or doctor");
  }
  const customerRules = source("src/lib/phoenix-crm/manager-plan-rules.ts");
  assert.equal(/Write the customer's (speciality|phone)|Write the (address|brick)/.test(customerRules), false, "no rule asks for the speciality, the phone, the address or the brick");

  const customerServer = source("src/lib/phoenix-crm/server/manager-customers.ts");
  const addBody = functionBody(customerServer, "export async function addManagerCustomer(");
  assert.match(addBody, /missingManagerCustomerField\(\{ name, areaChosen: true, grade: body\.grade, potentialGrade: body\.potentialGrade \}\)/, "the add asks for the name, the grades and the area — nothing else");
  assert.match(addBody, /if \(lacking\) throw validationError\(lacking\);/, "a customer short of those is refused");
  assert.match(addBody, /pin_address: address,\s*pin_brick_id: brick\?\.id \?\? null,\s*pin_brick_name: brick\?\.name \?\? null,/, "the address he saw and the brick he picked are what is saved — or nothing");
  assert.equal(/pin_address: geography|pin_brick_id: geography|pin_brick_name: geography/.test(addBody), false, "the resolver never overwrites what he saw");
  assert.match(addBody, /\(await activeBricksOfArea\(area\.areaCode\)\)\.find\(\(entry\) => entry\.id === brickId\)/, "a brick must be one of the chosen area's own");
  assert.match(addBody, /Choose a brick of the area you chose\./, "a brick of another area is refused in plain words");
  const bricksOfArea = functionBody(customerServer, "async function activeBricksOfArea(");
  assert.match(bricksOfArea, /await loadBrickCentroids\(\)/, "the bricks come from the index the capture resolver reads, so the two never disagree");
  assert.match(bricksOfArea, /brick\.areaCode === areaCode/, "the bricks of ONE area");
  const areaBricksBody = functionBody(customerServer, "export async function loadAreaBricks(");
  assert.match(areaBricksBody, /district\.find\(\(seat\) => seat\.seatId === raw\.area\)[\s\S]*throw forbiddenError\(outsideReach\(writer\)\)/, "only an area of his own reach lists its bricks");
  const locateBody = functionBody(customerServer, "export async function locateManagerCustomer(");
  assert.match(locateBody, /resolvePinGeography\(fix, territoryOfSeat\(chosen \?\? \{\}\)\)/, "the capture fills the fields from the same resolver the add uses");
  assert.match(locateBody, /const brickId = inReach && geography\.brickId \? geography\.brickId : null;/, "the capture offers a brick only when it sits in an area of his reach");
  assert.equal(/\.insert\(|\.update\(|\.delete\(/.test(locateBody), false, "locating a capture writes nothing");
  const locateRoute = source("app/api/phoenix-crm/manager-plans/customers/locate/route.ts");
  assert.match(locateRoute, /assertSameOriginMutation\(request\)[\s\S]*assertPermission\(access, "phoenix_crm", "read"\)[\s\S]*locateManagerCustomer\(viewer, body\)/, "same-origin, then the module grant, then the located fields");
  const bricksRoute = source("app/api/phoenix-crm/manager-plans/customers/bricks/route.ts");
  assert.match(bricksRoute, /export async function GET[\s\S]*assertPermission\(access, "phoenix_crm", "read"\)[\s\S]*loadAreaBricks\(viewer, \{ area: search\.get\("area"\) \}\)/, "the bricks of an area: the module grant, then his reach");

  const customerForm = source("src/components/phoenix-crm/manager-customer-form.tsx");
  assert.match(customerForm, /missingManagerCustomerField\(\{ name: name\.trim\(\) \|\| null, areaChosen: Boolean\(areaSeatId\), grade, potentialGrade \}\)/, "the form asks the same question before it sends");
  assert.match(customerForm, /\/api\/phoenix-crm\/manager-plans\/customers\/locate/, "Capture location fills the address, area and brick");
  assert.match(customerForm, /useCrmGet<ManagerAreaBricks>\(areaSeatId \? crmUrl\(BRICKS, \{ area: areaSeatId \}\) : null, "bricks"\)/, "the brick drop-list is read for the area chosen above it");
  assert.match(customerForm, /setAreaSeatId\(event\.target\.value\);\s*setBrickId\(""\);/, "a new area empties the brick: a brick belongs to one area");
  assert.match(customerForm, /setAreaSeatId\(found\.areaSeatId\);\s*setBrickId\(found\.brickId \?\? ""\);/, "the capture selects the area, then the brick in it");
  assert.match(customerForm, /<CrmSelect disabled=\{bricks\.loading \|\| brickList\.length === 0\} id=\{`\$\{idPrefix\}-brick`\}/, "the brick is a drop-list, not a typed word");
  assert.equal(/brickName/.test(customerForm), false, "the form no longer types a brick");
  assert.match(customerForm, /address: address\.trim\(\) \|\| null,\s*brickId: brickId \|\| null,/, "the address and the brick id go as they stand, or as nothing");
  for (const label of ["Speciality", "Phone", "Address", "Brick"]) {
    assert.match(customerForm, new RegExp(`label="${label}"`), `${label} carries no star: it is optional`);
  }
  assert.match(customerForm, /label="Area \*"/, "the area stays chosen");
  assert.equal(/areas\.length > 1/.test(customerForm), false, "the area drop-list is always shown: the brick cascades from it");
  assert.equal(/\b(doctors?|accounts?)\b/i.test(customerForm), false, "the form says customers, never doctors or accounts");
}
