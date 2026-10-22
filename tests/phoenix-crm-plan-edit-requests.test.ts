import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { ApiError } from "../src/lib/http/api-errors.ts";
import {
  isPlanEditWaiting,
  nextPlanEditStatus,
  PHOENIX_CRM_ADMINISTRATOR_HR_ID,
  PLAN_EDIT_ASKS_PER_WEEK,
  planEditAsksLeft,
  planEditAsksLeftLine,
  planEditAsksNote,
  planEditDecisionsFor,
  planEditFirstStatus,
  planEditStageOf,
  type PlanEditStage,
} from "../src/lib/phoenix-crm/plan-edit-rules.ts";
import { assertPlanEditApprover, canAdminister, canDecidePlanEdit, canOverrideDecision, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";

/**
 * Phoenix CRM — asking to edit a week that is already sent (owner, 2026-10-01).
 *
 * "REQUEST TO EDIT FROM DISTRICT MANAGER APPROVAL THEN SFE THEN HR ACKNOWLEDGEMENT WITH EMAILS IN APP
 * AND TELEGRAM FOR EVERY STEP" — and HR is Omar Gawish himself, the week opens only after HR, the rep
 * gives no reason, any refusal ends it. What this file pins:
 *   1. the steps run in order, a vacant manager chain starts at SFE, and HR only acknowledges;
 *   2. WHO takes each step — the district manager, the SFE Manager, B-10 — and nobody else, in either
 *      world. HR's acknowledgement is one of the Super Admin's real-data acts, so it is B-10's alone;
 *   3. the database half: the plan's own lock, the order, the note on a refusal, the reopen inside the
 *      acknowledgement, and an expiry that is written rather than raised;
 *   4. the service half: the step is read from the row, never the body, and checked before the write;
 *   6. twice a week at most (owner, 2026-10-20): every request raised on the week counts, and the third
 *      is refused on the server before anything is written.
 */

const NSM: OrgSeat = {
  seatId: "SEAT-AIF-NSM",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "NSM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-NSM"],
  occupantHrId: "B-900",
  lineCode: "anti_infective",
  lineName: "Anti Infective",
  areaName: null,
  regionName: null,
  seatLabel: "AIF NSM",
};
const DM: OrgSeat = {
  ...NSM,
  seatId: "SEAT-AIF-DM-D1",
  parentSeatId: "SEAT-AIF-NSM",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-NSM", "SEAT-AIF-DM-D1"],
  occupantHrId: "B-12",
  regionName: "Delta (1)",
  seatLabel: "AIF Delta (1) DM",
};
const REP: OrgSeat = {
  ...DM,
  seatId: "SEAT-AIF-REP-D13",
  parentSeatId: "SEAT-AIF-DM-D1",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-AIF-NSM", "SEAT-AIF-DM-D1", "SEAT-AIF-REP-D13"],
  occupantHrId: "B-7",
  areaName: "Menoufia 2",
  seatLabel: "AIF D13 rep",
};

const org = buildOrgIndex([NSM, DM, REP]);

/** A viewer as resolvePhoenixCrmViewer builds it. */
function viewerFor(
  hrId: string,
  role: string,
  options: { superAdmin?: boolean; sfe?: boolean; testPersona?: boolean; canApprove?: boolean } = {},
): PhoenixCrmViewer {
  const company = options.superAdmin || options.sfe;
  const scope = company ? org.territories : territoriesInScope(org, hrId, "tree");
  return {
    hrId,
    role,
    isSuperAdmin: options.superAdmin ?? false,
    isSfeManager: options.sfe ?? false,
    isTestPersona: options.testPersona ?? false,
    basis: company ? "all" : "tree",
    canCreate: true,
    canApprove: options.canApprove ?? true,
    canUpdate: options.superAdmin ?? false,
    org,
    config: { lineRollout: [] },
    cairoToday: "2026-10-01",
    openLines: new Set(["anti_infective"]),
    ownTerritories: ownTerritories(org, hrId),
    waitingTerritories: [],
    scopeTerritories: scope,
    waitingScopeTerritories: [],
    managerSeats: heldManagerSeats(org, hrId),
  } as unknown as PhoenixCrmViewer;
}

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

/** One function's text in the comment-free migration, from its header to its closing `$$;`. */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is in the migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends in "$$;"`);
  return sql.slice(start, end);
}

const STAGES: readonly PlanEditStage[] = ["manager", "sfe"];

function stagesFor(viewer: PhoenixCrmViewer, isTest: boolean): PlanEditStage[] {
  return STAGES.filter((stage) => canDecidePlanEdit(viewer, REP, isTest, stage));
}

export function runPhoenixCrmPlanEditRequestTests(): void {
  // ── 1. The steps ────────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(planEditFirstStatus(true), "manager_pending", "a territory with a district manager starts with him");
    assert.equal(planEditFirstStatus(false), "sfe_pending", "a vacant chain starts at SFE, as an off-plan visit does");
    assert.equal(nextPlanEditStatus("manager"), "sfe_pending", "the manager's yes goes to SFE");
    assert.equal(nextPlanEditStatus("sfe"), "reopened", "SFE's yes opens the week — nothing waits for the Administrator (owner, 2026-10-08)");
    assert.equal(planEditStageOf("manager_pending"), "manager");
    assert.equal(planEditStageOf("sfe_pending"), "sfe");
    assert.equal(planEditStageOf("hr_pending" as never), null, "the retired HR step waits on nobody");
    for (const settled of ["reopened", "refused", "expired"] as const) {
      assert.equal(planEditStageOf(settled), null, `${settled} waits on nobody`);
      assert.equal(isPlanEditWaiting(settled), false);
    }
    assert.deepEqual(planEditDecisionsFor("manager"), ["approve", "refuse"]);
    assert.deepEqual(planEditDecisionsFor("sfe"), ["approve", "refuse"]);
    assert.equal(PHOENIX_CRM_ADMINISTRATOR_HR_ID, "B-10", "the Administrator is Omar Gawish himself");
  }

  // ── 2. Who takes each step ──────────────────────────────────────────────────────────────────────
  {
    const dm = viewerFor("B-12", "District Manager");
    const nsm = viewerFor("B-900", "National Sales Manager");
    const sfe = viewerFor("B-300", "SFE Manager", { sfe: true });
    const owner = viewerFor("B-10", "Super Admin", { superAdmin: true });
    const ownerConsole = viewerFor("PHX-1", "Super Admin", { superAdmin: true });
    const otherAdmin = viewerFor("B-55", "Super Admin", { superAdmin: true });
    const rep = viewerFor("B-7", "Medical Rep", { canApprove: false });
    const testDm = viewerFor("B-12", "District Manager", { testPersona: true });

    assert.deepEqual(stagesFor(dm, false), ["manager"], "the district manager takes the first step, and only it");
    assert.deepEqual(stagesFor(nsm, false), [], "the manager's manager reads the queue and decides nothing — scope is sight, not authority");
    assert.deepEqual(stagesFor(sfe, false), ["sfe"], "the SFE Manager takes the second step, and only it");
    assert.deepEqual(stagesFor(owner, false), [], "the Administrator is no step on a real request: nothing waits for him");
    assert.deepEqual(stagesFor(ownerConsole, false), [], "and his console login is the same person");
    assert.deepEqual(stagesFor(otherAdmin, false), [], "another Super Admin is no step either");
    assert.deepEqual(stagesFor(rep, false), [], "the rep asks; he never decides");

    assert.deepEqual(stagesFor(owner, true), ["manager", "sfe"], "in the test world the Super Admin takes every step");
    // Changed 2026-10-22 (owner: "Only my tab"): every test step is the Super Admin's, from his own tab.
    assert.deepEqual(stagesFor(testDm, true), [], "a test account no longer takes the manager's step of a test request");
    assert.deepEqual(stagesFor(testDm, false), [], "and never on a real request");

    // The Administrator may APPROVE or DECLINE any real decision (owner, 2026-10-14), never on a test entry,
    // and through the service's own branch: the step helpers below still answer him "no" because he is no step.
    assert.equal(canAdminister(owner), true);
    assert.equal(canAdminister(ownerConsole), true, "his console login is the same person (identity-aliases.ts)");
    assert.equal(canAdminister(otherAdmin), false, "another Super Admin is not the Administrator");
    assert.equal(canAdminister(viewerFor("B-10", "Super Admin", { superAdmin: true, canApprove: false })), false, "it needs the approve grant");
    assert.equal(canAdminister(viewerFor("B-10", "Super Admin", { superAdmin: true, testPersona: true })), false, "a test login is never the Administrator");
    assert.equal(canOverrideDecision(owner, false), true, "he may decide a real decision");
    assert.equal(canOverrideDecision(owner, true), false, "but a test entry is not his to decide");
    assert.equal(canOverrideDecision(dm, false), false, "a district manager is not the Administrator");

    const refused = (run: () => void, pattern: RegExp, message: string) =>
      assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === 403 && pattern.test(error.message), message);
    refused(() => assertPlanEditApprover(owner, REP, false, "manager"), /manager chain/, "the Administrator is not the manager's step");
    refused(() => assertPlanEditApprover(owner, REP, false, "sfe"), /manager chain/, "and not SFE's: he acts through the Administrator branch, never as a step");
    refused(() => assertPlanEditApprover(dm, REP, false, "sfe"), /SFE/, "the district manager cannot take SFE's step");
    refused(() => assertPlanEditApprover(testDm, REP, false, "manager"), /test login/, "a test login never touches a real request");
  }

  // ── 3. The database half ────────────────────────────────────────────────────────────────────────
  {
    const sql = readFileSync("supabase/migrations/20261002002251_phoenix_crm_plan_edit_requests.sql", "utf8").replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
    const raise = functionSql(sql, "phoenix_crm_raise_plan_edit_request");
    const decide = functionSql(sql, "phoenix_crm_decide_plan_edit_request");
    const lock = "perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));";
    assert.ok(raise.includes(lock), "a request takes the PLAN's own lock, so it never crosses a send or a decision");
    assert.ok(decide.includes(lock), "and so does each step, whose acknowledgement reopens the plan");
    assert.match(raise, /if v_plan\.status not in \('submitted', 'approved'\) then\s+raise exception 'phoenix_crm:plan_edit_not_sent';/, "only a sent week can be asked about");
    assert.match(raise, /raise exception 'phoenix_crm:plan_edit_already_open';/, "one request at a time");
    assert.match(sql, /create unique index if not exists phoenix_crm_plan_edit_requests_open_uniq\s+on public\.phoenix_crm_plan_edit_requests \(plan_id\)\s+where status in \('manager_pending', 'sfe_pending', 'hr_pending'\);/, "and the database holds that too");
    assert.match(decide, /or \(v_stage = 'hr' and v_decision <> 'acknowledge'\)/, "HR's step only acknowledges");
    assert.match(decide, /if v_decision = 'refuse' and v_note is null then\s+raise exception 'phoenix_crm:note_required';/, "a refusal needs a note the rep reads");
    assert.match(
      decide,
      /if \(v_stage = 'manager' and v_from <> 'manager_pending'\)\s+or \(v_stage = 'sfe' and v_from <> 'sfe_pending'\)\s+or \(v_stage = 'hr' and v_from <> 'hr_pending'\) then\s+raise exception 'phoenix_crm:plan_edit_wrong_stage';/,
      "no step is skipped and none is taken twice",
    );
    // The acknowledgement reopens the week in the same transaction, and only a week still sent.
    assert.match(decide, /if v_plan_from in \('submitted', 'approved'\) then\s+update public\.phoenix_crm_plans pl\s+set status = 'draft',/, "HR's acknowledgement makes the sent week a draft again");
    assert.match(
      decide,
      /insert into public\.phoenix_crm_plan_events \(plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details\)\s+values \(v_plan\.id, 'reopened', v_actor, 'hr', v_plan_from, v_plan\.status, v_plan\.version, null,\s+jsonb_build_object\('edit_request_id', v_request_id\)\);/,
      "and writes the plan's own 'reopened' event, with its status and the request that opened it",
    );
    // A week that has passed is closed as expired — WRITTEN, so it commits — not raised.
    const expiry = decide.slice(decide.indexOf("if v_request.week_start + 5 < v_today then"), decide.indexOf("if v_decision = 'refuse' then"));
    assert.ok(expiry.includes("set status = 'expired'"), "a request whose week has passed is closed as expired");
    assert.doesNotMatch(expiry, /raise exception/, "and that is written, never raised — a raise would roll it back");
    assert.match(expiry, /return jsonb_build_object\(/, "it returns the expired request");
  }

  // ── 4. The service half ─────────────────────────────────────────────────────────────────────────
  {
    const edits = source("src/lib/phoenix-crm/server/plan-edits.ts");
    const decide = edits.slice(edits.indexOf("export async function decidePlanEdit("));
    const stageAt = decide.indexOf("const stage = planEditStageOf(status);");
    const assertAt = decide.indexOf("assertPlanEditApprover(viewer, seat, isTest, stage);");
    const writeAt = decide.indexOf('callPhoenixCrm<Row>("phoenix_crm_decide_plan_edit_request"');
    assert.ok(stageAt > 0 && assertAt > stageAt && writeAt > assertAt, "the step is read from the row, checked, and only then written");
    assert.doesNotMatch(decide, /body\.stage/, "the body never names its own step");

    const raise = edits.slice(edits.indexOf("export async function raisePlanEdit("), edits.indexOf("export async function decidePlanEdit("));
    assert.match(
      raise,
      /if \(territoryForRepWrite\(viewer, seat\.seatId, isTest\)\.isTest !== isTest\) \{\s*throw notFoundError/,
      "a test login asking about a REAL plan by its id is told it is not there",
    );
    assert.match(raise, /first_status: planEditFirstStatus\(reviewer !== null\),/, "the first step follows the territory's own chain");
    assert.doesNotMatch(raise, /reason/, "no reason is asked of the rep — one button (owner)");

    // Every step tells the next person, the rep, the district manager and SFE — by email, in-app and Telegram.
    const notify = source("src/lib/phoenix-crm/server/notifications.ts");
    const branch = notify.slice(notify.indexOf("async function describePlanEdit("), notify.indexOf("async function describe(notice"));
    assert.doesNotMatch(branch, /hr_pending/, "no step tells the Administrator to act: nothing waits for him");
    assert.match(branch, /The Administrator/, "when he declines, the notice names him by his title");
    assert.match(branch, /\.\.\.\(reviewer \? \[reviewer\.hrId\] : \[\]\), \.\.\.sfe\]/, "every step tells the district manager and SFE");
    assert.match(branch, /key !== actorKey/, "nobody is told about his own press");
    assert.match(branch, /tab: "plan", idempotencyKey: `\$\{key\}:rep`/, "the rep is told on his Plan, under a key of his own");
    assert.match(branch, /const key = `phoenix_crm:plan_edit:\$\{notice\.requestId\}:v\$\{notice\.version\}:\$\{status\}`;/, "each step's notice is its own");

    // The queue is in Team, for each person whose step it is.
    const team = source("src/components/phoenix-crm/team-tab.tsx");
    assert.match(team, /current === "edits" && team\.data \?/, "the Team tab has its Plan edits section");
    const card = source("src/components/phoenix-crm/plan-edit-card.tsx");
    assert.match(card, /"\/api\/phoenix-crm\/plans\/edit-requests\/decide"/, "the card posts each step");
    assert.doesNotMatch(card, /Acknowledge/, "there is no acknowledge button any more");
    assert.match(card, /AdministratorStepNote/, "the Administrator decides from the card, and the card says whose step he is taking");
    assert.match(card, /const administratorDecides = !edit\.canDecide && edit\.canOverride/, "and he never appears in the card's own canDecide");
    assert.doesNotMatch(card, /\bHR\b/, "and the card never calls him HR");

    // 5. The migration that took HR's step out.
    const mig = readFileSync("supabase/migrations/20261008160000_phoenix_crm_administrator_not_hr.sql", "utf8").replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
    const fn = functionSql(mig, "phoenix_crm_decide_plan_edit_request");
    assert.match(mig, /status = 'hr_pending'\) then\s+raise exception/, "it refuses to run while a request still waits at HR");
    assert.match(fn, /v_stage not in \('manager', 'sfe', 'administrator'\)/, "the steps are manager, SFE and the Administrator");
    assert.match(fn, /v_stage = 'administrator' and v_decision <> 'refuse'/, "the Administrator only declines");
    assert.doesNotMatch(fn, /v_to := 'hr_pending'/, "SFE's yes no longer goes to HR");
    assert.match(fn, /v_to := 'reopened';\s+v_event := 'approved';/, "SFE's yes opens the week");
  }

  // ── 6. Twice a week at most (owner, 2026-10-20) ─────────────────────────────────────────────────
  // "for reps cap weekly plan edit requests + plan it self to 2 to be the rep makes the plan and send s to manager after the approval he have only 2 times to request edit per week"
  {
    assert.equal(PLAN_EDIT_ASKS_PER_WEEK, 2, "🔴 a rep asks to edit one week twice at most — the owner's number");
    assert.deepEqual([0, 1, 2, 3].map(planEditAsksLeft), [2, 1, 0, 0], "every request raised counts, and the count never runs below none");
    assert.match(planEditAsksNote(0), /twice/, "a rep who has spent both asks reads why the button is gone");
    assert.match(planEditAsksNote(1), /last ask/, "and is told before pressing the last one");
    assert.equal(planEditAsksLeftLine(1), "1 ask left this week");
    assert.equal(planEditAsksLeftLine(2), "2 asks left this week");

    const edits = source("src/lib/phoenix-crm/server/plan-edits.ts");
    const raise = edits.slice(edits.indexOf("export async function raisePlanEdit("), edits.indexOf("export async function decidePlanEdit("));
    const countAt = raise.indexOf('.from("phoenix_crm_plan_edit_requests")');
    const refuseAt = raise.indexOf("if (planEditAsksLeft(asked ?? 0) === 0) throw conflictError(PLAN_EDIT_ASKS_USED_UP);");
    const writeAt = raise.indexOf('callPhoenixCrm<Row>("phoenix_crm_raise_plan_edit_request"');
    assert.ok(countAt > 0 && refuseAt > countAt && writeAt > refuseAt, "🔴 the third ask is refused on the server, before anything is written");
    const count = raise.slice(countAt, refuseAt);
    assert.match(count, /\.eq\("plan_id", planId\)/, "the asks are counted on this week's own plan");
    assert.doesNotMatch(count, /"status"/, "and every request counts, whatever became of it — a refused one included");

    const state = edits.slice(edits.indexOf("export async function loadPlanEditState("), edits.indexOf("export function editAcknowledgedAt("));
    assert.match(state, /entry\.asked \+= 1;\s+if \(!entry\.latest\)/, "the week's own count takes every request it reads, before any status is looked at");

    const monthly = source("src/lib/phoenix-crm/server/monthly-plans.ts");
    assert.match(monthly, /const editAsksLeft = planEditAsksLeft\(edit\?\.asked \?\? 0\);/, "the week reads its asks from that same count");
    assert.match(monthly, /canAskToEdit: repState === "sent" && weekPlan !== null && editAsksLeft > 0,/, "🔴 the button is gone once both asks are spent");

    const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.match(panel, /week\.repState === "sent" && week\.editAsksLeft === 0 \?/, "and the week says why it is gone");
    assert.match(panel, /planEditAsksLeftLine\(week\.editAsksLeft\)/, "the count left sits under the button");
    assert.match(panel, /planEditAsksNote\(week\.editAsksLeft\)/, "and the confirmation says when it is the last one");
  }

  console.log("phoenix-crm plan edit requests: OK");
}
