import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { addDaysIso } from "../src/lib/crm/dates.ts";
import { ApiError } from "../src/lib/http/api-errors.ts";
import { editablePlanDays, fieldWeekDays } from "../src/lib/phoenix-crm/calendar.ts";
import { gradeTarget } from "../src/lib/phoenix-crm/coverage.ts";
import {
  changedDaysOf,
  diffSentSnapshots,
  parseSentSnapshot,
  planReviewCoverage,
  returnableDays,
  reviewPlacements,
  sentChangesOf,
  summarizeReviewCoverage,
  type ReviewCustomer,
  type ReviewWeek,
  type SentSnapshot,
} from "../src/lib/phoenix-crm/plan-review-rules.ts";
import {
  isPlanDaySent,
  isPlanSentForReview,
  onlyReturnedDayEditable,
  planDayLabel,
  planDayStatus,
  planStatusLine,
  planStatusLabel,
  planTurnSentence,
  repChangeableDays,
  repWeekState,
  standingReturnedDay,
} from "../src/lib/phoenix-crm/plan-rules.ts";
import { assertCanReturnPlan, canReturnTerritoryPlan, canReviewTerritory, type PhoenixCrmViewer } from "../src/lib/phoenix-crm/server/access.ts";
import { buildOrgIndex, heldManagerSeats, ownTerritories, territoriesInScope, type OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { PHOENIX_CRM_DEFAULT_SETTINGS, type PhoenixCrmGrade, type PhoenixCrmDoctorListType, type PhoenixCrmPlanStatus } from "../src/lib/phoenix-crm/types.ts";

/**
 * Phoenix CRM — the manager's review of a sent week (owner, 2026-10-02).
 *
 * On 1 October district managers approved 13 weeks of 51–94 customers each in a median of two minutes.
 * Four rulings followed, and each one goes wrong QUIETLY, so each is pinned here:
 *
 *   1. THE REVIEW AS STEPS — a reviewer opening a week waiting for his decision gets the rep's step form:
 *      Week (summary, what changed, coverage) → Day → Customers (AM, then PM, read only) → Decide. The
 *      rep's own form is untouched; a manager reading a week he does not decide keeps the whole board.
 *   2. COVERAGE ON THE REVIEW — VALIDATED customers only, per list (AM and PM never added together) and
 *      grade: how many of the month's target visits the sent and approved weeks plus this one cover,
 *      and who is left out. The target is tallyDoctorMonth's — the ONE target rule. With nobody
 *      validated yet (every customer is pending today) it says so in words, never a zero.
 *   3. WHAT CHANGED — each send keeps what was sent on its own 'submitted' event; a re-sent week shows,
 *      day by day, the customers and activities added and removed since the send before.
 *   4. RETURN ONE DAY — "Only that day" reopens: the rep may change that day alone, every other day is
 *      refused by the server, and sending the week again clears it. An acknowledged edit AFTER the
 *      return opens the whole week.
 *   5. STILL PLANNED — after a one-day return the rep's visits on the OTHER days still count as planned;
 *      only the returned day waits for the week to be sent again. ONE rule (plan-rules.ts
 *      `planDayStatus`) for every reader, and the same one in phoenix_crm_save_visit (migration
 *      20261002125244), which also carries phoenix_crm_plan_transition with BOTH changes made to it
 *      from one base — the one-day return here and the 23:55 deadline — so neither drops the other.
 */

const ROOT = new URL("../", import.meta.url);

function raw(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

function source(path: string): string {
  return stripComments(raw(path));
}

/** A migration without its comments. */
function sqlOf(path: string): string {
  return raw(path).replace(/--.*$/gm, "");
}

/** One function's text in a comment-free migration, from its header to its closing `$$;`. */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is in the migration`);
  const end = sql.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} ends in "$$;"`);
  return sql.slice(start, end);
}

const MIGRATION = "supabase/migrations/20261002120049_phoenix_crm_plan_review.sql";

// ── The org the access matrix runs on (the shape tests/phoenix-crm-plan-edit-requests.test.ts uses) ──

const NSM: OrgSeat = {
  seatId: "SEAT-PEDIA-NSM",
  parentSeatId: "SEAT-ROOT-CEO",
  tier: "NSM",
  path: ["SEAT-ROOT-CEO", "SEAT-PEDIA-NSM"],
  occupantHrId: "B-900",
  lineCode: "pedia",
  lineName: "Pedia",
  areaName: null,
  regionName: null,
  seatLabel: "Pedia NSM",
};
const DM: OrgSeat = {
  ...NSM,
  seatId: "SEAT-PEDIA-DM-D1",
  parentSeatId: "SEAT-PEDIA-NSM",
  tier: "DM",
  path: ["SEAT-ROOT-CEO", "SEAT-PEDIA-NSM", "SEAT-PEDIA-DM-D1"],
  occupantHrId: "B-12",
  regionName: "Delta (1)",
  seatLabel: "Pedia Delta (1) DM",
};
const REP: OrgSeat = {
  ...DM,
  seatId: "SEAT-PEDIA-REP-D13",
  parentSeatId: "SEAT-PEDIA-DM-D1",
  tier: "REP",
  path: ["SEAT-ROOT-CEO", "SEAT-PEDIA-NSM", "SEAT-PEDIA-DM-D1", "SEAT-PEDIA-REP-D13"],
  occupantHrId: "B-7",
  areaName: "Menoufia 2",
  seatLabel: "Pedia D13 rep",
};
const org = buildOrgIndex([NSM, DM, REP]);

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
    cairoToday: "2026-10-05",
    openLines: new Set(["pedia"]),
    ownTerritories: ownTerritories(org, hrId),
    waitingTerritories: [],
    scopeTerritories: scope,
    waitingScopeTerritories: [],
    managerSeats: heldManagerSeats(org, hrId),
  } as unknown as PhoenixCrmViewer;
}

// ── Fixtures for the pure rules ─────────────────────────────────────────────────────────────────

function customer(customerId: string, listType: PhoenixCrmDoctorListType, grade: PhoenixCrmGrade | null, pending = false): ReviewCustomer {
  return { customerId, name: customerId, listType, grade, pending };
}

/** A week whose days carry the given customers — one customer a day, from its Saturday on. */
function week(weekStart: string, status: PhoenixCrmPlanStatus | null, customerIds: string[], leading = false, returnedDay: string | null = null): ReviewWeek {
  return {
    weekStart,
    leading,
    status,
    returnedDay,
    days: customerIds.map((customerId, index) => ({ date: addDaysIso(weekStart, index), items: [{ customerId }] })),
  };
}

function snapshot(items: Array<[string, string, PhoenixCrmDoctorListType, string]>, activities: Array<[string, string, boolean]> = []): unknown {
  return {
    items: items.map(([plan_date, customer_id, list_type, name]) => ({ plan_date, customer_id, list_type, name })),
    activities: activities.map(([plan_date, activity_type, half_day]) => ({ plan_date, activity_type, half_day })),
  };
}

export function runPhoenixCrmPlanReviewTests(): void {
  // ── 4a. Return ONE day: what still stands, and which days the rep may change ─────────────────────
  {
    const returned = { status: "returned" as const, returnedDay: "2026-10-06", decidedAt: "2026-10-04T10:00:00.123456+00:00", editAcknowledgedAt: null };
    assert.equal(standingReturnedDay(returned), "2026-10-06", "a week returned for one day opens that day");
    assert.equal(standingReturnedDay({ ...returned, status: "submitted" }), null, "a sent week has no returned day, whatever a stray column says");
    assert.equal(standingReturnedDay({ ...returned, status: "draft" }), null, "nor a draft");
    assert.equal(standingReturnedDay({ ...returned, returnedDay: null }), null, "a week returned WHOLE opens every day");
    assert.equal(
      standingReturnedDay({ ...returned, editAcknowledgedAt: "2026-10-04T12:30:00+00:00" }),
      null,
      "HR acknowledging an edit AFTER the one-day return opens the whole week — he asked to edit the week and all three agreed",
    );
    assert.equal(
      standingReturnedDay({ ...returned, editAcknowledgedAt: "2026-10-03T08:00:00+00:00" }),
      "2026-10-06",
      "an acknowledgement from BEFORE the return is history: the one day stands",
    );
    assert.equal(
      standingReturnedDay({ ...returned, decidedAt: null, editAcknowledgedAt: "2026-10-04T12:30:00+00:00" }),
      "2026-10-06",
      "when the order cannot be read, the one-day return stands — the narrower reading is never widened by a guess",
    );

    // Saturday 3 October 2026's week, read on Monday the 5th.
    assert.deepEqual(editablePlanDays("2026-10-03", "2026-10-05"), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    assert.deepEqual(
      repChangeableDays({ weekStart: "2026-10-03", cairoToday: "2026-10-05", returnedDay: null }),
      ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"],
      "no day returned: every day from today on",
    );
    assert.deepEqual(
      repChangeableDays({ weekStart: "2026-10-03", cairoToday: "2026-10-05", returnedDay: "2026-10-06" }),
      ["2026-10-06"],
      "one day returned: that day ALONE — the only list of days a save may touch",
    );
    assert.deepEqual(
      repChangeableDays({ weekStart: "2026-10-03", cairoToday: "2026-10-07", returnedDay: "2026-10-06" }),
      [],
      "once the returned day has passed, nothing changes — he sends the week again as it is",
    );

    const days = ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((date) => ({ date, editable: date >= "2026-10-05" }));
    assert.deepEqual(
      onlyReturnedDayEditable(days, "2026-10-06").filter((day) => day.editable).map((day) => day.date),
      ["2026-10-06"],
      "every other day reads as fixed — greyed on his board and out of every draft and save",
    );
    assert.deepEqual(onlyReturnedDayEditable(days, null), days, "no day returned: the week is untouched");
    assert.equal(
      onlyReturnedDayEditable(days, "2026-10-04").some((day) => day.editable),
      false,
      "a returned day that has passed opens nothing, and a passed day never reopens",
    );

    // The rep's state is unchanged by it: a returned week is his to change and send.
    assert.equal(
      repWeekState({ weekStart: "2026-10-03", open: true, status: "returned", repWeek: "2026-10-10", runningWeek: "2026-10-03", editAsked: false, editReopened: false }),
      "plan",
      "a week returned for one day is a returned week: his to change, and to send again",
    );

    assert.equal(planDayLabel("2026-10-06"), "Tuesday 6 Oct", 'the day is named the way he reads it: "Your manager returned Tuesday 6 Oct"');

    // The days a reviewer is offered: working days that have not passed — never a holiday.
    const reviewDays = [
      { date: "2026-10-03", listTypes: ["AM", "PM"] as PhoenixCrmDoctorListType[] },
      { date: "2026-10-05", listTypes: ["AM", "PM"] as PhoenixCrmDoctorListType[] },
      { date: "2026-10-06", listTypes: [] as PhoenixCrmDoctorListType[] },
      { date: "2026-10-08", listTypes: ["AM"] as PhoenixCrmDoctorListType[] },
    ];
    assert.deepEqual(
      returnableDays(reviewDays, "2026-10-05").map((day) => day.date),
      ["2026-10-05", "2026-10-08"],
      "today and later, Thursday's morning included; a passed day and a public holiday are not offered",
    );
  }

  // ── 3. What changed since the last send ─────────────────────────────────────────────────────────
  {
    const UUID_A = "AAAAAAAA-0000-4000-8000-000000000001";
    const parsed = parseSentSnapshot(
      snapshot(
        [
          ["2026-10-04", UUID_A, "PM", "Dr One"],
          ["2026-10-05", "bbbbbbbb-0000-4000-8000-000000000002", "AM", "  "],
        ],
        [
          ["2026-10-05", "meeting", true],
          ["2026-10-05", "not_a_kind", false],
        ],
      ),
    );
    assert.ok(parsed, "a send that kept its snapshot parses");
    assert.equal(parsed.items[0].customerId, UUID_A.toLowerCase(), "customer ids compare lower-case");
    assert.equal(parsed.items[1].name, null, "a blank name is no name");
    assert.deepEqual(parsed.activities, [{ planDate: "2026-10-05", activityType: "meeting", halfDay: true }], "an unknown activity kind is dropped");
    assert.equal(parseSentSnapshot({}), null, "a send before 2 October kept nothing — that is 'not known', never 'empty'");
    assert.equal(parseSentSnapshot({ items: [] }), null, "half a snapshot is not a snapshot");
    assert.equal(parseSentSnapshot(null), null);

    const before = parseSentSnapshot(
      snapshot(
        [
          ["2026-10-04", "c1", "PM", "Dr One"],
          ["2026-10-04", "c2", "PM", "Dr Two"],
          ["2026-10-06", "c3", "AM", "Al Salam"],
        ],
        [["2026-10-05", "meeting", true]],
      ),
    ) as SentSnapshot;
    const after = parseSentSnapshot(
      snapshot(
        [
          ["2026-10-04", "c1", "PM", "Dr One"],
          ["2026-10-06", "c3", "AM", "Al Salam"],
          ["2026-10-06", "c4", "PM", "Dr Four"],
          ["2026-10-07", "c2", "PM", "Dr Two"],
        ],
        [
          ["2026-10-05", "meeting", false],
          ["2026-10-07", "travel", false],
        ],
      ),
    ) as SentSnapshot;
    const diff = diffSentSnapshots(before, after);
    assert.deepEqual(
      diff.map((day) => day.date),
      ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"],
      "only the days that changed, in day order",
    );
    assert.deepEqual(diff[0].removed.map((item) => item.customerId), ["c2"], "Sunday lost Dr Two");
    assert.deepEqual(diff[0].added, [], "and gained nobody");
    assert.deepEqual(
      [diff[1].activitiesRemoved.map((entry) => `${entry.activityType}:${entry.halfDay}`), diff[1].activitiesAdded.map((entry) => `${entry.activityType}:${entry.halfDay}`)],
      [["meeting:true"], ["meeting:false"]],
      "a half-day meeting made whole reads as the one taken off and the other put on",
    );
    assert.deepEqual(diff[2].added.map((item) => item.customerId), ["c4"], "Tuesday gained Dr Four");
    assert.deepEqual(diff[2].removed, [], "and kept Al Salam");
    assert.deepEqual(diff[3].added.map((item) => item.customerId), ["c2"], "Dr Two moved to Wednesday: added there");
    assert.deepEqual(diff[3].activitiesAdded.map((entry) => entry.activityType), ["travel"]);
    assert.deepEqual(diffSentSnapshots(after, after), [], "the same week sent again: nothing changed");

    assert.equal(sentChangesOf([]), null, "a week never sent has nothing to show");
    assert.deepEqual(sentChangesOf([{ sentAt: "2026-10-04T09:00:00+00:00", details: snapshot([["2026-10-04", "c1", "PM", "Dr One"]]) }]), { kind: "first" });
    assert.deepEqual(
      sentChangesOf([
        { sentAt: "2026-10-05T09:00:00+00:00", details: snapshot([["2026-10-04", "c1", "PM", "Dr One"]]) },
        { sentAt: "2026-10-02T09:00:00+00:00", details: {} },
      ]),
      { kind: "unknown", previousSentAt: "2026-10-02T09:00:00+00:00" },
      "the send before kept no snapshot: what changed is not known, and the screen says so",
    );
    const compared = sentChangesOf([
      { sentAt: "2026-10-05T09:00:00+00:00", details: snapshot([["2026-10-04", "c1", "PM", "Dr One"], ["2026-10-05", "c9", "PM", "Dr Nine"]]) },
      { sentAt: "2026-10-04T09:00:00+00:00", details: snapshot([["2026-10-04", "c1", "PM", "Dr One"]]) },
      { sentAt: "2026-10-03T09:00:00+00:00", details: snapshot([]) },
    ]);
    assert.equal(compared?.kind, "compared", "newest first: the last send is compared with the one before it, never an older one");
    assert.deepEqual(compared?.kind === "compared" ? compared.days.map((day) => day.date) : null, ["2026-10-05"]);
    assert.deepEqual([...changedDaysOf(compared)], ["2026-10-05"], "the changed days are marked on the day chooser");
    assert.deepEqual([...changedDaysOf({ kind: "first" })], []);
  }

  // ── 2. Coverage on the review ───────────────────────────────────────────────────────────────────
  {
    const settings = { gradeTargets: PHOENIX_CRM_DEFAULT_SETTINGS.gradeTargets };
    const customers: ReviewCustomer[] = [
      customer("pm-a1", "PM", "A"),
      customer("pm-a2", "PM", "A"),
      customer("pm-b1", "PM", "B"),
      customer("pm-c1", "PM", "C"),
      customer("pm-none", "PM", null),
      customer("pm-pending", "PM", "A", true),
      customer("am-a1", "AM", "A"),
      customer("am-b1", "AM", "B"),
    ];
    const weeks: ReviewWeek[] = [
      week("2026-09-26", "submitted", ["pm-a2"], true),
      week("2026-10-03", "approved", ["pm-a1", "pm-a1", "pm-b1", "am-a1"]),
      week("2026-10-10", "submitted", ["pm-a1", "pm-a1", "pm-pending", "pm-c1"]),
      week("2026-10-17", "draft", ["pm-a2"]),
      week("2026-10-24", "returned", ["pm-b1"]),
    ];
    const placements = reviewPlacements(weeks, "2026-10-10");
    assert.deepEqual(
      Object.fromEntries([...placements].sort()),
      { "am-a1": 1, "pm-a1": 4, "pm-b1": 1, "pm-c1": 1, "pm-pending": 1 },
      "the month's sent and approved weeks plus this one — never a draft, a returned week, or the week the month opens with",
    );
    // The week under review counts even before it is sent (a guard, not a path: review is of a sent week).
    assert.equal(reviewPlacements([week("2026-10-10", "draft", ["pm-a1"])], "2026-10-10").get("pm-a1"), 1);

    const coverage = planReviewCoverage({ weeks, reviewedWeekStart: "2026-10-10", customers, settings });
    assert.ok(coverage);
    assert.equal(coverage.validated, 7, "validated customers only — the pending one is left out entirely");
    const pm = coverage.lists.PM;
    const am = coverage.lists.AM;
    assert.equal(pm.validated, 5);
    assert.equal(am.validated, 2, "AM and PM are counted apart, never added together");
    assert.deepEqual(
      pm.grades.map((row) => [row.grade, row.customers, row.targetVisits, row.coveredVisits, row.placedVisits, row.coveragePct, row.leftOut]),
      [
        ["A", 2, 6, 3, 4, 50, 1],
        ["B", 1, 2, 1, 1, 50, 0],
        ["C", 1, 1, 1, 1, 100, 0],
      ],
      "PM per grade: Dr A1 planned four times covers his own three and never Dr A2's",
    );
    assert.deepEqual(
      am.grades.map((row) => [row.grade, row.customers, row.targetVisits, row.coveredVisits, row.placedVisits, row.coveragePct, row.leftOut]),
      [
        ["A", 1, 1, 1, 1, 100, 0],
        ["B", 1, null, 0, 0, null, 1],
        ["C", 0, null, 0, 0, null, 0],
      ],
      "a grade with no number has no target visits — shown as such, never as a zero target",
    );
    assert.equal(pm.ungraded, 1, "a validated customer with no grade has no target, and is counted apart");
    assert.deepEqual(
      pm.leftOut.map((entry) => entry.customerId),
      ["pm-a2", "pm-none"],
      "the validated customers left out of the month so far — grade A first — named; the pending one is not among them",
    );
    assert.deepEqual(am.leftOut.map((entry) => entry.customerId), ["am-b1"]);

    // The ONE target rule: each grade's target visits are gradeTarget × its customers, nothing else.
    for (const list of ["AM", "PM"] as const) {
      for (const row of coverage.lists[list].grades) {
        const target = gradeTarget(settings, list, row.grade);
        assert.equal(row.targetVisits, row.customers === 0 || target === null ? null : target * row.customers, `${list} grade ${row.grade} reads the one target rule`);
      }
    }

    assert.equal(
      planReviewCoverage({ weeks, reviewedWeekStart: "2026-09-26", customers, settings }),
      null,
      "the week a month opens with is counted on its own month's board, never mixed into this one",
    );
    const nobody = planReviewCoverage({ weeks, reviewedWeekStart: "2026-10-10", customers: customers.map((entry) => ({ ...entry, pending: true })), settings });
    assert.equal(nobody?.validated, 0, "every customer pending — today's real state — is ZERO validated, which the screen says in words");
    assert.deepEqual(nobody?.lists.PM.leftOut, [], "and names nobody as left out");
    const total = summarizeReviewCoverage({ customers, placements: new Map(), settings });
    assert.equal(total.lists.PM.leftOut.length, 5, "a month with nothing sent leaves every validated customer out");
  }

  // ── 4b. Who may return one day: exactly who may return the week ────────────────────────────────
  {
    const dm = viewerFor("B-12", "District Manager");
    const nsm = viewerFor("B-900", "National Sales Manager");
    const sfe = viewerFor("B-300", "SFE Manager", { sfe: true });
    const owner = viewerFor("B-10", "Super Admin", { superAdmin: true });
    const rep = viewerFor("B-7", "Medical Rep", { canApprove: false });
    const testDm = viewerFor("B-12", "District Manager", { testPersona: true });
    const refused = (run: () => unknown, message: string) => assert.throws(run, (error: unknown) => error instanceof ApiError && error.status === 403, message);

    assert.equal(assertCanReturnPlan(dm, REP, false), "reviewer", "the district manager returns a week, or a day of it");
    assert.equal(assertCanReturnPlan(sfe, REP, false), "sfe", "the SFE Manager returns, never approves");
    refused(() => assertCanReturnPlan(nsm, REP, false), "the manager's manager reads and decides nothing");
    refused(() => assertCanReturnPlan(rep, REP, false), "the rep never returns his own week");
    assert.equal(assertCanReturnPlan(owner, REP, false), "administrator", "the Administrator may return a week with a comment — he is no step");
    assert.equal(assertCanReturnPlan(owner, REP, true), "reviewer", "on a test plan he takes the reviewer's place");
    // Changed 2026-10-22 (owner: "Only my tab"): a test week is returned from the Super Admin's own tab.
    refused(() => assertCanReturnPlan(testDm, REP, true), "a test account no longer returns a test week");
    refused(() => assertCanReturnPlan(testDm, REP, false), "and never a real one");

    // The steps open for exactly who decides: approves, or returns.
    const decides = (viewer: PhoenixCrmViewer, isTest: boolean) => canReviewTerritory(viewer, REP, isTest) || canReturnTerritoryPlan(viewer, REP, isTest);
    assert.deepEqual(
      [decides(dm, false), decides(sfe, false), decides(nsm, false), decides(rep, false), decides(owner, false), decides(owner, true)],
      [true, true, false, false, true, true],
      "who reads a week as review steps — and so who is shown what changed since the last send",
    );
  }

  // ── The database half ───────────────────────────────────────────────────────────────────────────
  {
    const sql = sqlOf(MIGRATION);
    assert.match(sql, /alter table public\.phoenix_crm_plans add column if not exists returned_day date;/, "the one returned day is a column on the plan");
    assert.match(
      sql,
      /add constraint phoenix_crm_plans_returned_day\s+check \(returned_day is null or \(status = 'returned' and returned_day between week_start and week_start \+ 5\)\);/,
      "a returned day exists only on a returned plan, and only inside its own week",
    );
    const transition = functionSql(sql, "phoenix_crm_plan_transition");
    assert.match(transition, /\n\s*v_day date := nullif\(p ->> 'day', ''\)::date;\n/, "a return may name a day");
    assert.match(transition, /if v_day is not null and v_action <> 'return' then\s+raise exception 'phoenix_crm:bad_input';/, "and nothing but a return may");
    assert.match(
      transition,
      /if v_day is not null and \(v_day < v_plan\.week_start or v_day > v_plan\.week_start \+ 5 or v_day < v_today\) then\s+raise exception 'phoenix_crm:day_not_returnable';/,
      "the day is a working day of the week — Saturday to Thursday — that has not passed on the Cairo calendar",
    );
    assert.match(transition, /\n\s*v_today date := \(now\(\) at time zone 'Africa\/Cairo'\)::date;\n/, "the Cairo day, never current_date");
    const submit = transition.slice(transition.indexOf("if v_action = 'submit' then"), transition.indexOf("elsif v_action = 'reopen' then"));
    const reopen = transition.slice(transition.indexOf("elsif v_action = 'reopen' then"), transition.indexOf("elsif v_action = 'approve' then"));
    const returning = transition.slice(transition.lastIndexOf("\n  else\n"), transition.indexOf("insert into public.phoenix_crm_plan_events"));
    assert.match(submit, /submitted_via = 'week',\s+returned_day = null,/, "sending the week again clears the one-day return");
    assert.match(reopen, /set status = 'draft',\s+returned_day = null,/, "and so does a reopen");
    assert.match(returning, /set status = 'returned',\s+returned_day = v_day,/, "a return keeps the day it names — null when the week goes back whole");
    assert.match(returning, /v_details := jsonb_build_object\('returned_day', v_day\);/, "the returned event says which day");
    // What was sent, kept on the send's own event.
    assert.match(submit, /v_details := jsonb_build_object\(\s*'items', coalesce\(\(/, "a send keeps its customers");
    assert.match(submit, /jsonb_build_object\('plan_date', i\.plan_date, 'customer_id', i\.customer_id, 'list_type', i\.list_type, 'name', c\.name\)/, "by day, list and name as it stood");
    assert.match(submit, /from public\.phoenix_crm_plan_items i\s+left join public\.phoenix_crm_customers c on c\.id = i\.customer_id\s+where i\.plan_id = v_plan\.id/);
    assert.match(submit, /'activities', coalesce\(\(\s*select jsonb_agg\(\s*jsonb_build_object\('plan_date', a\.plan_date, 'activity_type', a\.activity_type, 'half_day', a\.half_day\)/, "and its activities");
    assert.match(submit, /from public\.phoenix_crm_plan_activities a\s+where a\.plan_id = v_plan\.id/);
    const inserts = transition.match(/insert into public\.phoenix_crm_plan_events \([^)]*\)/g) ?? [];
    assert.deepEqual(
      inserts,
      ["insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note, details)"],
      "still ONE plan-event insert, carrying its status and now its details",
    );
    assert.match(transition, /values \(v_plan\.id, v_event, v_actor, v_role, v_from, v_plan\.status, v_plan\.version, v_note, v_details\);/);
    assert.match(transition, /'returned_day', v_plan\.returned_day\n\s*\);/, "the answer carries the day");
    // The live body the file replaces stays: the due date in one place, the kept late verdict, the week check first.
    assert.match(transition, /due_on = public\.phoenix_crm_week_due_on\(pl\.week_start\),/);
    assert.match(
      transition,
      /submitted_late = case\s+when exists \(\s+select 1 from public\.phoenix_crm_plan_edit_requests r where r\.plan_id = pl\.id and r\.status = 'reopened'\s+\) then pl\.submitted_late\s+else v_today > public\.phoenix_crm_week_due_on\(pl\.week_start\)\s+end,/,
      "a week sent again after an agreed edit is still never stamped late for it",
    );
    const weekCheck = transition.search(/if v_action <> 'approve' and v_plan\.week_start \+ 5 < v_today then\s+raise exception 'phoenix_crm:week_passed';/);
    assert.ok(weekCheck >= 0 && weekCheck < transition.indexOf("if v_action = 'submit' then"), "a week that is over is refused before any action");
    assert.match(sql, /^revoke execute on function public\.phoenix_crm_plan_transition\(jsonb\) from public, anon, authenticated;$/m);
    assert.match(sql, /^grant execute on function public\.phoenix_crm_plan_transition\(jsonb\) to service_role;$/m);

    // The transition the database RUNS is the last migration that defines it — and it must carry all of this.
    const definers = readdirSync(new URL("supabase/migrations/", ROOT))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .filter((name) => sqlOf(`supabase/migrations/${name}`).includes("create or replace function public.phoenix_crm_plan_transition("));
    const live = functionSql(sqlOf(`supabase/migrations/${definers[definers.length - 1]}`), "phoenix_crm_plan_transition");
    for (const piece of ["returned_day = v_day", "returned_day = null", "phoenix_crm:day_not_returnable", "'activities', coalesce", "v_details"]) {
      assert.ok(live.includes(piece), `the live phoenix_crm_plan_transition (${definers[definers.length - 1]}) still carries ${piece} — a later replacement must keep the one-day return and the snapshot`);
    }

    const db = source("src/lib/phoenix-crm/server/db.ts");
    assert.match(db, /\n\s*day_not_returnable: \{\s*status: 409,\s*message: "[^"]+",?\s*\},/, "the database's day_not_returnable reads as a sentence");
  }

  // ── The server half ─────────────────────────────────────────────────────────────────────────────
  {
    const plans = raw("src/lib/phoenix-crm/server/plans.ts");
    const save = plans.slice(plans.indexOf("export async function savePlan("), plans.indexOf("// ── Sending, reopening and deciding"));
    const guardAt = save.indexOf("const access = await assertRepMayChangeWeek(viewer, seat, isTest, weekStart);");
    assert.ok(guardAt > 0, "a save asks the guard which days it may touch");
    assert.ok(save.indexOf("const editableDays = access.editableDays;") > guardAt, "and touches those days only");
    assert.ok(save.includes("editable_days: editableDays,"), "they are the days the database is handed");
    assert.match(save, /Only \$\{planDayLabel\(access\.returnedDay\)\} was returned to you\. The other days stay as you sent them\./, "a change to another day is refused in words");
    assert.match(save, /editableDays,\s+activities: parsePlanActivities\(body\.activities, open\),/, "and the day's activities follow the same days");
    assert.doesNotMatch(save, /const editableDays = editablePlanDays\(/, "never every open day while one day is returned");

    const transition = plans.slice(plans.indexOf("export async function transitionPlan("), plans.indexOf("// ── The managers' review list"));
    assert.match(transition, /if \(day !== null && action !== "return"\) throw validationError\(/, "only a return names a day");
    const gate = transition.indexOf("decidedAs = assertCanReturnPlan(viewer, seat, isTest);");
    const dayCheck = transition.indexOf("if (day !== null) {");
    const write = transition.indexOf('callPhoenixCrm<Row>("phoenix_crm_plan_transition"');
    assert.ok(gate > 0 && dayCheck > gate && write > dayCheck, "a one-day return is gated exactly as a whole-week return, its day checked, and only then written");
    assert.match(transition, /day: action === "return" \? day : null,/);
    assert.match(transition, /const changeable = new Set\(access\.editableDays\);/, "a send checks for stale customers on the days he could change only");
    assert.match(
      transition,
      /returnedDay: action === "return" \? textOrNull\(result\.returned_day\) : null,/,
      "the returned notice is told the day the DATABASE recorded — never a day it did not keep",
    );

    const edits = raw("src/lib/phoenix-crm/server/plan-edits.ts");
    const guard = edits.slice(edits.indexOf("export async function assertRepMayChangeWeek("), edits.indexOf("// ── The rep asks"));
    assert.match(guard, /\.select\("id, status, returned_day, decided_at"\)/);
    assert.match(guard, /return \{ editableDays: repChangeableDays\(\{ weekStart, cairoToday: viewer\.cairoToday, returnedDay \}\), returnedDay \};/);
    assert.match(guard, /editAcknowledgedAt: editAcknowledgedAt\(edit\),/, "an acknowledged edit after the return is read, so it can open the whole week");

    const monthly = raw("src/lib/phoenix-crm/server/monthly-plans.ts");
    assert.match(
      monthly,
      /const builtDays = buildDays\(\{[^\n]*\}\);\n\s*const days = onlyReturnedDayEditable\(builtDays, returnedDay\);/,
      "the board's days are the days the server accepts",
    );
    assert.match(monthly, /const decidesWeeks = canReviewTerritory\(viewer, seat, isTest\) \|\| canReturnTerritoryPlan\(viewer, seat, isTest\);/);
    assert.match(monthly, /const reviewIds = decidesWeeks\s+\?/, "what each send kept is read for the people who decide the week, and nobody else — the rep's own board never reads it");
    assert.match(monthly, /sentChanges: decidesWeeks && weekStatus === "submitted" && planRow \? sentChangesOf\(/);

    const reviewServer = source("src/lib/phoenix-crm/server/plan-review.ts");
    assert.match(reviewServer, /\.from\("phoenix_crm_plan_events"\)\s*\.select\("id, plan_id, details, created_at"\)/);
    assert.match(reviewServer, /\.eq\("event_type", "submitted"\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/, "newest send first");

    const notify = raw("src/lib/phoenix-crm/server/notifications.ts");
    assert.match(notify, /eventType: approved \? "plan_approved" : "plan_returned",/, "the rep is told through the existing plan_returned notice — in-app and Telegram, never email");
    assert.match(notify, /`Weekly plan returned: \$\{oneDay\} only`/, "naming the day");
  }

  // ── 1. The screens ──────────────────────────────────────────────────────────────────────────────
  {
    const board = source("src/components/phoenix-crm/plan-board.tsx");
    assert.match(
      board,
      /const reviewing =\s+!repBoard && selected !== null && selected\.week\.status === "submitted" && \(selected\.week\.canApprove \|\| selected\.week\.canReturn\);/,
      "the steps are for a week WAITING FOR REVIEW that this viewer decides, opened from Team — never the rep's own Plan",
    );
    assert.ok(board.includes("{reviewElement ?? weekPanelElement}"), "any other week, and a week he only reads, keeps the whole board");
    assert.match(board, /\{repBoard \? \(\s*<div[^>]*ref=\{stepRef\}>\s*<CrmStepForm/, "the rep's own step form is where it was");
    assert.equal((board.match(/onDecide=\{onDecideWeek\}/g) ?? []).length, 2, "the whole board's decision and the review steps share the ONE way a week is decided");
    assert.ok(board.includes("onOpenMonth={chooseMonth}"), "reviewing a month stays in reach");
    assert.match(board, /\{onBack \? <CrmBackBar backLabel=\{onBack\.label\} onBack=\{requestBack\}/, "and so does Back to Team");

    const steps = source("src/components/phoenix-crm/plan-review-steps.tsx");
    assert.match(steps, /export const REVIEW_STEP_LABELS = \["Week", "Day", "Customers", "Decide"\] as const;/, "four steps, in the owner's order");
    assert.match(steps, /function openDay\(date: string\) \{\s*setDay\(date\);\s*setSession\("AM"\);\s*goStep\(3\);\s*\}/, "a tap on a day moves him on — its AM list first");
    assert.ok(steps.includes("onDay: openDay,"), "every day the panel offers goes through that tap");
    assert.match(steps, /setSession\("PM"\);\s*goStep\(3\);\s*\}\}\s*>\s*Next: PM/, "AM, then PM");
    assert.ok(steps.includes('reviewList={session} section="day"'), "the day is read one list at a time");
    assert.ok(steps.includes("editable: false,"), "read only — the reviewer never ticks a rep's plan");
    assert.ok(steps.includes("viewerIsRep: false,"), "and never reads it as the rep");
    assert.doesNotMatch(steps, /crmPost|\/api\/|useEffect\(/, "it sends nothing itself, and nothing from an effect: every decision is a press in PlanDecision");
    assert.match(steps, /<SentChangesBlock changes=\{changes\} onOpenDay=\{openDay\} \/>/, "step 1 shows what changed");
    assert.equal((steps.match(/\{coverageBlock\}/g) ?? []).length, 2, "the coverage is on step 1 and step 4");
    assert.ok(steps.includes('title="No validated customers yet"'), "with nobody validated it says so in words");
    assert.ok(steps.includes("Coverage starts as customers are validated at the door."));
    assert.doesNotMatch(steps, /\b(location|distance|accuracy|mock|integrity|gps|far apart)\b/i, "never an integrity signal on a review");
    for (const [name, text] of [
      ["plan-review-steps.tsx", steps],
      ["plan-decision.tsx", source("src/components/phoenix-crm/plan-decision.tsx")],
    ] as const) {
      const rounded = [...text.matchAll(/(?<![\w-])rounded(?:-[\w./[\]-]+)?(?![\w-])/g)].map((match) => match[0]).filter((token) => token !== "rounded-none");
      assert.deepEqual(rounded, [], `${name} is square`);
      assert.equal(/\b(truncate|text-ellipsis|line-clamp-\d)\b/.test(text), false, `${name} never cuts a word short`);
    }

    const decision = source("src/components/phoenix-crm/plan-decision.tsx");
    assert.ok(decision.includes("Return one day"), "the reviewer can return ONE day");
    assert.match(decision, /onClick=\{\(\) => \{\s*if \(chosenDay\) void decide\("return", chosenDay\);\s*\}\}/, "and its own press names the day — never a day chosen by default");
    assert.match(decision, /if \(action === "return" && !trimmed\)/, "a one-day return needs its note like any return");
    assert.match(decision, /const days = subject === "week" && canReturn \? \(returnDays \?\? \[\]\) : \[\];/, "a week only, and only for who may return it");

    const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.match(panel, /const asSent = viewerIsRep && editable && week\.returnedDay !== null && day\.date !== week\.returnedDay;/, "on his own week every other day is greyed");
    assert.match(panel, /disabled: asSent \|\| undefined,/);
    assert.ok(panel.includes('`${decidedBySfe ? "SFE" : "Your manager"} returned ${name}`'), 'he reads "Your manager returned Tuesday 6 Oct: <note>"');
    assert.match(panel, /returnDays=\{week\.canReturn \? returnableDays\(week\.days, today\)\.map\(\(day\) => day\.date\) : undefined\}/, "the whole board offers the one-day return too");

    const day = source("src/components/phoenix-crm/plan-day-panel.tsx");
    assert.ok(day.includes("only={reviewList}"), "the read-only day shows the one list the reviewer's step is on");
  }

  runWhoseTurnTests();

  runNamedStatusTests();

  runStillPlannedTests();

  console.log("phoenix-crm plan review: OK");
}

// ── 6. WHOSE TURN IT IS (owner ruling, 2026-10-07) ──────────────────────────────────────────────────
//
// "No buttons, but SAY whose turn it is." A week this viewer can neither approve nor return draws no
// decision block at all — PlanDecision returns null — so the district manager who had just returned
// 10 October read a screen with the buttons missing and reported the plan screen as broken. The rule
// stays exactly as it was (the rep answers a return first); the page now names who holds the week.
function runWhoseTurnTests(): void {
  const base = {
    deciderName: "Ahmed Samir",
    decidedStamp: "7 Oct 2026, 8:36 PM",
    repName: "Mostafa Galal",
    reviewerName: "Ahmed Samir",
    dueLabel: "Thursday 8 October",
  };

  // A week returned whole, and the one-day return: both say the rep holds it and what brings it back.
  const whole = planTurnSentence({ ...base, status: "returned", returnedDay: null });
  assert.equal(
    whole,
    "This week went back to Mostafa Galal 7 Oct 2026, 8:36 PM by Ahmed Samir. It is with Mostafa Galal now — it comes back here for review when they send it again.",
  );
  const oneDay = planTurnSentence({ ...base, status: "returned", returnedDay: "2026-10-10" });
  assert.ok(oneDay.startsWith(`${planDayLabel("2026-10-10")} went back to Mostafa Galal`), "the one-day return names its day, never the whole week");
  assert.ok(oneDay.includes("when they send it again"), "and still says what brings it back");

  // The other three states, and the one thing the sentence must never do: claim nothing is waiting on a
  // week that is still with someone.
  assert.equal(planTurnSentence({ ...base, status: "submitted", returnedDay: null }), "Sent for review. Ahmed Samir approves it.");
  assert.equal(
    planTurnSentence({ ...base, reviewerName: null, status: "submitted", returnedDay: null }),
    "Sent for review. The manager above this territory approves it.",
  );
  assert.equal(planTurnSentence({ ...base, status: "approved", returnedDay: null }), "Approved 7 Oct 2026, 8:36 PM by Ahmed Samir. Nothing is waiting on this week.");
  assert.equal(planTurnSentence({ ...base, status: null, returnedDay: null }), "Not sent yet. Mostafa Galal sends it by Thursday 8 October.");
  assert.equal(planTurnSentence({ ...base, status: "draft", returnedDay: null }), "Not sent yet. Mostafa Galal sends it by Thursday 8 October.");
  for (const status of ["returned", "submitted", "draft", null] as const) {
    assert.doesNotMatch(
      planTurnSentence({ ...base, status, returnedDay: null }),
      /Nothing is waiting/,
      `a ${status ?? "never sent"} week never reads as finished`,
    );
  }

  // A vacant seat and a plan nobody has decided yet: the sentence still reads as a sentence.
  const vacant = planTurnSentence({ ...base, deciderName: null, decidedStamp: null, repName: null, status: "returned", returnedDay: null });
  assert.equal(vacant, "This week went back to the rep. It is with the rep now — it comes back here for review when they send it again.");

  // It is drawn exactly where the buttons would have been, and only when there are none.
  const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
  assert.match(
    panel,
    /\{showClose && turnSentence && !week\.canApprove && !week\.canReturn \? \(\s*<CrmBlock className="border-t border-slate-100" title="Where this week stands">/,
    "the sentence shows only when this viewer has no decision to make",
  );
  assert.ok(
    panel.indexOf("turnSentence && !week.canApprove") < panel.indexOf("<PlanDecision"),
    "and sits where PlanDecision would have been",
  );

  // The Team side only: the rep's own board says it in its send step already.
  const board = source("src/components/phoenix-crm/plan-board.tsx");
  assert.match(board, /turnSentence=\{repBoard \? null : turnSentence\}/, "his own board is left alone");
  assert.match(board, /status: selected\.week\.status,\s*returnedDay: selected\.week\.returnedDay,/, "the sentence reads the week's STANDING returned day");
  assert.match(board, /decidedStamp: selected\.week\.plan\?\.decidedAt \? cairoStamp\(selected\.week\.plan\.decidedAt\) : null,/, "the stamp is Cairo local, like every other stamp on the board");
}

// ── 7. THE STATUS NAMES ITS PERSON (owner ruling, 2026-10-08) ───────────────────────────────────────
//
// "Make the plan status be appearing ex drafted by Mostafa Galal, waiting Dr Taha approval, waiting
// Mostafa to edit and resend and so on." The pill used to say what STATE the row was in — "Waiting for
// review" on nine territories at once, with three different managers above them, and "Returned for
// changes" with no hint of who had to act. It now says WHOSE it is, in the same four states and the
// same tones: only the words changed.
function runNamedStatusTests(): void {
  const people = { repName: "Mostafa Galal", reviewerName: "Dr Taha", deciderName: "Dr Taha" };

  assert.equal(planStatusLine({ ...people, status: "draft" }), "Drafted by Mostafa Galal");
  assert.equal(planStatusLine({ ...people, status: "submitted" }), "Waiting for Dr Taha to approve");
  assert.equal(planStatusLine({ ...people, status: "returned" }), "Waiting for Mostafa Galal to edit and resend");
  assert.equal(planStatusLine({ ...people, status: "approved" }), "Approved by Dr Taha");
  assert.equal(planStatusLine({ ...people, status: null }), "Not started — Mostafa Galal drafts it");

  // Who APPROVED it is who the approved week names — not whoever reviews the territory today, because a
  // manager can change and the week was still approved by the person who approved it.
  assert.equal(planStatusLine({ ...people, deciderName: "Ahmed Samir", status: "approved" }), "Approved by Ahmed Samir");
  // With no decider recorded it falls back to the reviewer rather than to the bare word.
  assert.equal(planStatusLine({ ...people, deciderName: null, status: "approved" }), "Approved by Dr Taha");

  // His own screen says "you", never his own name (owner walk, 2026-10-28).
  assert.equal(planStatusLine({ ...people, self: true, status: "draft" }), "Drafted by you");
  assert.equal(planStatusLine({ ...people, self: true, status: "returned" }), "Waiting for you to edit and resend");
  assert.equal(planStatusLine({ ...people, self: true, status: null }), "Not started — you draft it");
  assert.equal(planStatusLine({ ...people, self: true, status: "submitted" }), "Waiting for Dr Taha to approve", "the reviewer is still named");
  assert.ok(source("src/lib/phoenix-crm/server/plans.ts").includes("self: selfReader"), "the board tells the composer when the reader is the rep");

  // 🔴 NO NAME, NO INVENTION. A vacant seat, an empty manager chain and a blank string each fall back to
  // `planStatusLabel`'s own word — the one thing this must never print is "waiting for null", and a name
  // is never guessed from another field.
  assert.equal(planStatusLine({ status: "draft" }), planStatusLabel("draft"));
  assert.equal(planStatusLine({ status: "submitted", reviewerName: null }), planStatusLabel("submitted"));
  assert.equal(planStatusLine({ status: "returned", repName: "   " }), planStatusLabel("returned"));
  assert.equal(planStatusLine({ status: "approved", deciderName: "", reviewerName: "" }), planStatusLabel("approved"));
  assert.equal(planStatusLine({ status: null }), planStatusLabel(null));
  for (const status of ["draft", "submitted", "returned", "approved", null] as const) {
    assert.doesNotMatch(planStatusLine({ status }), /null|undefined|\bNaN\b/, `a nameless ${status ?? "never sent"} week prints no placeholder`);
  }

  // It is ONE composer: the month wears the same words as its weeks, and nothing re-implements them.
  const plans = source("src/lib/phoenix-crm/server/plans.ts");
  const monthly = source("src/lib/phoenix-crm/server/monthly-plans.ts");
  for (const [name, body] of [["plans.ts", plans], ["monthly-plans.ts", monthly]] as const) {
    assert.ok(body.includes("planStatusLine({"), `${name} composes the status through the shared rule`);
    assert.equal(/\bplanStatusLabel\(/.test(body), false, `${name} holds no second copy of the status words`);
  }
  assert.equal(/\bmonthlyPlanStatusLabel\(/.test(monthly), false, "the month no longer has its own status words either");

  // Every status a screen reads is composed WITH the territory's people — a mapper called without them
  // is the silent half of this defect, because it still returns a perfectly valid bare word.
  assert.match(plans, /export function mapPlan\(row: Row, names: PeopleNames, people\?: \{ repName: string \| null; reviewerName: string \| null; self\?: boolean \}\)/);
  assert.match(plans, /const plan = planRow \? mapPlan\(planRow, names, territory\) : null;/, "the board's own week");
  assert.match(plans, /const plan = planRow \? mapPlan\(planRow, names, territory\) : null;[\s\S]*?territory,/, "and every row of the Team tab");
  assert.equal(/mapPlan\(planRow, names\)/.test(plans), false, "no caller is left on the nameless mapper");
  assert.equal(/mapPlan\(planRow, names\)/.test(monthly), false);
  assert.match(monthly, /mapMonthlyPlan\(headerRow, names, rowTerritory\)/, "the monthly review rows too");

  // The week and month PICKERS read the same words as the pill they open: one status, one voice.
  assert.match(plans, /statusLabel: planStatusLine\(\{\s*status: weekStatus,\s*repName: territory\.repName,\s*reviewerName: territory\.reviewerName,/);
  assert.match(monthly, /statusLabel: planStatusLine\(\{ status: monthStatus, repName: territory\.repName, reviewerName: territory\.reviewerName \}\)/);

  // A territory with NO plan row has no server-composed label at all, so the Team tab names its rep
  // itself rather than printing a bare "Not started" beside eight named ones.
  const team = source("src/components/phoenix-crm/team-tab.tsx");
  // The week's card and table row take their pill from `rowPill` (which also reads a week filed in the old CRM), so
  // the week's named "Not started" is composed once there, and once more on the monthly card.
  assert.equal((team.match(/planStatusLine\(\{ status: null, repName: row\.territory\.repName \}\)/g) ?? []).length, 2, "the week's pill rule and the monthly card");
  assert.equal((team.match(/\browPill\(row\)/g) ?? []).length, 2, "the week's card and table row both take their pill from that one rule");
  assert.equal(team.includes('statusLabel ?? "Not started"'), false, "and the bare fallback is gone from all three");
}

// ── 5. STILL PLANNED (owner ruling, 2026-10-02) ─────────────────────────────────────────────────────
//
// After a ONE-DAY return the rep's visits on the OTHER days of that week still count as planned; only
// the returned day waits for him to send the week again. One rule, asked everywhere: plan-rules.ts
// `planDayStatus` on the screens and reports, `v_on_sent_plan` in phoenix_crm_save_visit.

const STILL_PLANNED = "supabase/migrations/20261002125244_phoenix_crm_still_planned_after_one_day_return.sql";
/**
 * The migration that defines `phoenix_crm_save_visit` LAST — the body the database actually runs.
 *
 * It is not {@link STILL_PLANNED} any more, and it is no longer 20261002205436 or 20261002222403
 * either. Each of those replacers PATCHED the body in place rather than retyping it — 20261002205436
 * added `product_manager_hr_id` in five surgical edits, 20261002222403 inserted one block that stops a
 * photo slot dating a visit onto an earlier visit day, 20261003175653 lets a pharmacy be visited with
 * no validation and links the pharmacy a doctor's visit names, 20261003202903 files one pharmacy visit
 * for each pharmacy that box names, 20261004005543 checks a new pharmacy again under one lock,
 * 20261006234611 lets a chain visit take a product manager as its second person, and
 * 20261010180118 files a visit under the AM or PM session of the building it was made at, and
 * 20261027185332 takes any mix of companions on one visit — so the
 * "Still planned" branch below is byte-identical in all nine and the rule is unchanged. **Move this constant with every later
 * migration that recreates the function** — that is the whole point of the assertion it feeds, which
 * is what tells the next session where the live definition lives.
 */
const SAVE_VISIT_DEFINER = "supabase/migrations/20261027185332_phoenix_crm_visit_any_companions.sql";
const ONE_TAP_VISIT = "supabase/migrations/20260929235553_phoenix_crm_one_tap_visit.sql";
const EDIT_REQUESTS = "supabase/migrations/20261002002251_phoenix_crm_plan_edit_requests.sql";
const DEADLINE = "supabase/migrations/20261002122000_phoenix_crm_plan_deadline_2355.sql";

/** One function's body exactly as the file holds it — comments and all — between its two `$$`. */
function bodyIn(path: string, name: string): string {
  const text = raw(path);
  const at = text.indexOf(`create or replace function public.${name}(`);
  assert.ok(at >= 0, `${name} is defined in ${path}`);
  const open = text.indexOf("$$", at);
  const close = text.indexOf("$$", open + 2);
  return text.slice(open + 2, close);
}

/** The migrations that define a function, in the order they apply — the last one is what the database runs. */
function definersOf(name: string): string[] {
  return readdirSync(new URL("supabase/migrations/", ROOT))
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .filter((file) => sqlOf(`supabase/migrations/${file}`).includes(`create or replace function public.${name}(`));
}

function runStillPlannedTests(): void {
  // ── 5a. The rule, pure ─────────────────────────────────────────────────────────────────────────
  {
    const oneDay = { status: "returned" as const, returnedDay: "2026-10-06" };
    assert.equal(planDayStatus({ ...oneDay, date: "2026-10-06" }), "returned", "the returned day is back with the rep");
    assert.equal(planDayStatus({ ...oneDay, date: "2026-10-05" }), "submitted", "every other day stands as it was sent");
    assert.equal(planDayStatus({ ...oneDay, returnedFrom: "approved", date: "2026-10-08" }), "approved", "and as approved, when the week was approved before the day went back");
    assert.equal(planDayStatus({ ...oneDay, returnedFrom: "submitted", date: "2026-10-08" }), "submitted");
    assert.equal(planDayStatus({ ...oneDay, returnedFrom: null, date: "2026-10-08" }), "submitted", "an unknown 'before' reads as sent — never as approved");
    assert.equal(isPlanDaySent({ ...oneDay, date: "2026-10-05" }), true, "visits on the other days still count as PLANNED");
    assert.equal(isPlanDaySent({ ...oneDay, date: "2026-10-06" }), false, "visits on the returned day wait for the week to be sent again");

    assert.equal(isPlanDaySent({ status: "returned", returnedDay: null, date: "2026-10-05" }), false, "a week returned WHOLE is authority on no day");
    assert.equal(planDayStatus({ status: "submitted", returnedDay: "2026-10-06", date: "2026-10-06" }), "submitted", "a day only counts as returned on a returned week");
    const lifted = standingReturnedDay({
      status: "returned",
      returnedDay: "2026-10-06",
      decidedAt: "2026-10-04T10:00:00.123456+00:00",
      editAcknowledgedAt: "2026-10-04T12:00:00+00:00",
    });
    assert.equal(lifted, null);
    assert.equal(
      isPlanDaySent({ status: "returned", returnedDay: lifted, date: "2026-10-05" }),
      false,
      "an edit acknowledged AFTER the return opens the whole week — and a day the rep can change is never authority",
    );

    // Every status on every day of the week: the week's own answer, except the other days of a standing one-day return.
    for (const status of ["draft", "submitted", "approved", "returned", null] as const) {
      for (const date of fieldWeekDays("2026-10-03")) {
        const expected = status === "returned" ? date !== "2026-10-06" : isPlanSentForReview(status);
        assert.equal(isPlanDaySent({ status, returnedDay: status === "returned" ? "2026-10-06" : null, date }), expected, `${status ?? "no plan"} on ${date}`);
      }
    }
  }

  // ── 5b. The review's coverage counts the days a one-day return left as sent ──────────────────────
  {
    const weeks: ReviewWeek[] = [
      // Saturday 3 Oct carries pm-a1, Sunday 4 Oct (the returned day) pm-b1, Monday 5 Oct pm-c1.
      week("2026-10-03", "returned", ["pm-a1", "pm-b1", "pm-c1"], false, "2026-10-04"),
      week("2026-10-10", "submitted", ["am-a1"]),
      week("2026-10-17", "returned", ["pm-a2"]),
    ];
    assert.deepEqual(
      Object.fromEntries([...reviewPlacements(weeks, "2026-10-10")].sort()),
      { "am-a1": 1, "pm-a1": 1, "pm-c1": 1 },
      "the other days of a week returned for one day count, its returned day does not, and a week returned whole counts on no day",
    );
  }

  // ── 5c. phoenix_crm_save_visit: the live body, and the one branch beside the test that was there ────
  {
    const before = bodyIn(ONE_TAP_VISIT, "phoenix_crm_save_visit");
    const after = bodyIn(STILL_PLANNED, "phoenix_crm_save_visit");
    const noteAt = after.indexOf("  --\n  -- STILL PLANNED (owner, 2026-10-02).");
    const checkAt = after.indexOf("  v_on_sent_plan := v_rep is null or exists (");
    assert.ok(noteAt > 0 && checkAt > noteAt, "the ruling is written into WAS HE PLANNED?, right above the check it changes");
    const withoutNote = after.slice(0, noteAt) + after.slice(checkAt);
    const branchAt = withoutNote.indexOf("  ) or exists (\n");
    const branchEnd = withoutNote.indexOf("\n  );\n", branchAt);
    assert.ok(branchAt > 0 && branchEnd > branchAt, "the second branch closes v_on_sent_plan");
    const branch = withoutNote.slice(branchAt, branchEnd + 1);
    assert.equal(
      withoutNote.slice(0, branchAt) + withoutNote.slice(branchEnd + 1),
      before,
      "take the ruling's note and its branch out, and phoenix_crm_save_visit is its live body (20260929235553) to the byte — nothing else changed",
    );
    assert.ok(after.includes("      ) in ('submitted', 'approved')\n  ) or exists ("), "the test that was there stays word for word: a sent or approved plan is authority");
    assert.match(
      branch,
      /where pl\.seat_id = v_seat\s+and pl\.is_test = v_is_test\s+and i\.plan_date = v_date\s+and i\.customer_id = v_customer\.id\s+and v_date <> \(/,
      "the same plan row on the same day for the same customer — and the visit's day is NOT the returned one",
    );
    assert.match(
      branch,
      /select case\s+when e\.to_status = 'returned'[\s\S]*then nullif\(e\.details ->> 'returned_day', ''\)::date\s+end/,
      "a one-day return is the latest event to 'returned' carrying the day it returned",
    );
    assert.match(
      branch,
      /not exists \(\s+select 1\s+from public\.phoenix_crm_plan_edit_requests r\s+where r\.plan_id = pl\.id\s+and r\.hr_acknowledged_at > e\.created_at\s+and r\.hr_acknowledged_at <= v_captured_at\s+\)/,
      "and stops counting once an edit is acknowledged after it — the week is then the rep's to change, whole",
    );
    assert.match(
      branch,
      /where e\.plan_id = pl\.id\s+and e\.to_status is not null\s+and e\.created_at <= v_captured_at\s+order by e\.created_at desc, e\.id desc\s+limit 1/,
      "the LATEST event as of the visit's own captured_at — the shape the check beside it uses",
    );
    assert.equal(/exists \(\s*select 1\s*from public\.phoenix_crm_plan_events/.test(branch), false, "never an exists() over the events, which a later reopen or send cannot defeat");

    const saveDefiners = definersOf("phoenix_crm_save_visit");
    assert.equal(saveDefiners[saveDefiners.length - 1], SAVE_VISIT_DEFINER.split("/").pop(), "this is the save_visit the database runs: the last migration to define it");
    // And the rule this block tests survives into it unchanged — the patch touched five lines, none of
    // them this branch, so the LIVE body still carries it rather than only the file above.
    assert.ok(sqlOf(SAVE_VISIT_DEFINER).includes(branch), "the one-day-return branch is byte-identical in the live definer");
  }

  // ── 5d. phoenix_crm_plan_transition: the one-day return AND the 23:55 deadline, from one base ─────
  {
    const review = bodyIn(MIGRATION, "phoenix_crm_plan_transition");
    const both = bodyIn(STILL_PLANNED, "phoenix_crm_plan_transition");
    const deadlineNote =
      "    -- Sent on its own, the week is judged against its own deadline — 23:55 Cairo on its due date, from\n" +
      "    -- the server's clock, and accepted whenever it arrives (owner, 2026-09-29; the hour, 2026-10-02).\n" +
      "    -- A week sent AGAIN after an acknowledged edit keeps the verdict its first send earned (owner,\n" +
      "    -- 2026-10-01): the change was agreed by his manager, SFE and HR, and must not read as lateness.\n";
    const oneDayLine = "    -- A one-day return is answered by this send, so the week is whole again (owner, 2026-10-02).\n";
    const reviewNote =
      "    -- Sent on its own, the week is judged against its own due date — from the server's clock, and\n" +
      "    -- accepted whenever it arrives (owner, 2026-09-29). A week sent AGAIN after an acknowledged edit\n" +
      "    -- keeps the verdict its first send earned (owner, 2026-10-01): the change was agreed by his\n" +
      "    -- manager, SFE and HR, and must not read as lateness. A one-day return is answered by this send,\n" +
      "    -- so the week is whole again (owner, 2026-10-02).\n";
    const deadlineLine = "          else now() > public.phoenix_crm_week_deadline_at(pl.week_start)\n";
    const dueDateLine = "          else v_today > public.phoenix_crm_week_due_on(pl.week_start)\n";
    assert.ok(both.includes(deadlineNote + oneDayLine), "the deadline's own words, then the one-day return's");
    assert.ok(both.includes(deadlineLine), "lateness is the server's clock against the 23:55 instant");
    assert.ok(!both.includes(dueDateLine), "and the midnight test is gone, not left beside it");
    assert.equal(
      both.replace(deadlineNote + oneDayLine, reviewNote).replace(deadlineLine, dueDateLine),
      review,
      "put the deadline's two lines back as they were and it is 20261002120049's body to the byte: the merge added the deadline and nothing else",
    );
    // On a branch that carries the deadline file, it is that file's change to the byte, made from the same base.
    if (readdirSync(new URL("supabase/migrations/", ROOT)).includes(DEADLINE.split("/").pop() ?? "")) {
      const base = bodyIn(EDIT_REQUESTS, "phoenix_crm_plan_transition");
      const baseNote =
        "    -- Sent on its own, the week is judged against its own due date — from the server's clock, and\n" +
        "    -- accepted whenever it arrives (owner, 2026-09-29). A week sent AGAIN after an acknowledged edit\n" +
        "    -- keeps the verdict its first send earned (owner, 2026-10-01): the change was agreed by his\n" +
        "    -- manager, SFE and HR, and must not read as lateness.\n";
      assert.equal(
        base.replace(baseNote, deadlineNote).replace(dueDateLine, deadlineLine),
        bodyIn(DEADLINE, "phoenix_crm_plan_transition"),
        "20261002122000 is the same base with the deadline — so this file carries both changes and drops neither",
      );
    }
    const transitionDefiners = definersOf("phoenix_crm_plan_transition");
    assert.equal(transitionDefiners[transitionDefiners.length - 1], STILL_PLANNED.split("/").pop(), "and it is the transition the database runs: it sorts after both");

    const sql = sqlOf(STILL_PLANNED);
    assert.match(sql, /^begin;\nset local lock_timeout = '5s';/m, "one transaction, a short lock wait");
    assert.match(sql, /^commit;$/m);
    for (const fn of ["phoenix_crm_save_visit", "phoenix_crm_plan_transition"]) {
      assert.match(sql, new RegExp(`^revoke execute on function public\\.${fn}\\(jsonb\\) from public, anon, authenticated;$`, "m"), `${fn} stays out of the browser's reach`);
      assert.match(sql, new RegExp(`^grant execute on function public\\.${fn}\\(jsonb\\) to service_role;$`, "m"));
    }
    assert.ok(
      !sql.includes("create or replace function public.phoenix_crm_report_plan_vs_actual("),
      "this file does not replace the report — 20261002221947 does, and for a different reason (5e)",
    );
  }

  // ── 🔴 5e. PLAN AGAINST ACTUAL ASKS THE SAME DAY-BY-DAY RULE AS THE DOOR ──────────────────────────
  //
  // This section used to assert the OPPOSITE, and in doing so it pinned a defect. `sent_days` asked
  // whether the plan's latest status by the end of that Cairo day was in
  // ('submitted', 'approved', **'returned'**) — and that third value is wrong twice over:
  //
  //   * a week returned WHOLE is back with the rep and is authority on NO day, yet every customer on
  //     it counted as PLANNED and, unvisited, as MISSED;
  //   * the RETURNED DAY of a one-day return is back with him too, and counted the same way.
  //
  // `phoenix_crm_save_visit` has never agreed: it stamps a visit on such a day `is_unplanned`. So the
  // rep's own screen read "off the plan, waiting for your manager" while his manager's report read
  // "missed" — about the same customer, on the same day. Measured on production 2026-10-02, before
  // Delta (1) started: 0 returned plans, so nothing was wrong YET, which is exactly why it had to
  // ship before Saturday 3 October rather than after the first return.
  //
  // 🔴 The header of 20261002125244 says replacing this report "would change nothing". It is right
  // about the one-day return's OTHER days and wrong about the two cases above.
  {
    // 🔴 THE LAST DEFINER IS THE ONLY BODY THE DATABASE RUNS, which is why this section reads it and
    // not the file that first wrote the rule. 20261006121846 took that place from
    // 20261002221947_phoenix_crm_plan_vs_actual_sent_days.sql on 2026-10-06: it carries that body
    // forward VERBATIM and adds one thing — a customer handed to another rep is out of the old seat's
    // denominator from the day he moved, which is the dropped-customer refusal below in its other
    // shape. Every assertion that follows is about text 20261002221947 wrote and this file kept, so a
    // later definer that quietly dropped any of it fails here. That is the point of reading the last.
    // 20261016161248 took the place in turn on 2026-10-16, carrying 20261006121846's body forward
    // VERBATIM plus one rule: a recorded visit counts only once the Administrator has approved it.
    const definers = definersOf("phoenix_crm_report_plan_vs_actual");
    assert.equal(
      definers[definers.length - 1],
      "20261016161248_phoenix_crm_recorded_visit_waits_for_the_administrator.sql",
      "the fix is the LAST definer, so it is the body the database runs",
    );
    const report = functionSql(sqlOf(`supabase/migrations/${definers[definers.length - 1]}`), "phoenix_crm_report_plan_vs_actual");
    const sentDays = report.slice(report.indexOf("sent_days as ("), report.indexOf("planned as ("));

    // The Cairo-day boundary is unchanged — it is the one half that was already right.
    assert.match(
      sentDays,
      /e\.created_at < \(\(d\.plan_date \+ 1\)::timestamp at time zone 'Africa\/Cairo'\)/,
      "still the status the plan held when that Cairo day ENDED",
    );
    // 🔴 'returned' is no longer a sent status on its own.
    assert.doesNotMatch(sentDays, /in \('submitted', 'approved', 'returned'\)/, "a returned week is not authority by its status alone");
    assert.match(sentDays, /latest\.to_status in \('submitted', 'approved'\)/, "sent means submitted or approved");
    // The ONE exception, written the way `v_on_sent_plan` writes it.
    assert.match(sentDays, /latest\.to_status = 'returned'/, "a one-day return is the exception");
    assert.match(sentDays, /nullif\(latest\.details ->> 'returned_day', ''\)::date <> d\.plan_date/, "and it stands on every day but the returned one");
    assert.match(sentDays, /phoenix_crm_plan_edit_requests r/, "until an acknowledged edit opens the whole week");
    assert.match(sentDays, /r\.hr_acknowledged_at > latest\.created_at/, "which is read from the two times, never assumed");

    // 🔴 AND A CUSTOMER DROPPED MID-WEEK IS OUT OF THE DENOMINATOR FROM THE DAY HE LEFT. His later
    // planned days counted as MISSED, while `phoenix_crm_save_visit` raises `customer_dropped` for
    // him — so the rep was refused the very visit the report blamed him for not making.
    const planned = report.slice(report.indexOf("planned as ("), report.indexOf("visited as ("));
    assert.match(planned, /c\.status <> 'dropped'/, "a dropped customer is tested");
    assert.match(
      planned,
      /i\.plan_date <= \(\(c\.status_changed_at at time zone 'Africa\/Cairo'\)::date\)/,
      "and his days up to the drop still count — read as the CAIRO day, never `status_changed_at::date`",
    );
    assert.match(planned, /c\.validated_at is not null/, "the validation filter is untouched");

    // The rest of the function is the live text: nothing about the aggregates or the join moved.
    assert.match(report, /full join visited vd/, "the full join stands");
    assert.match(report, /as unplanned_refused/, "and every column it returned before");

    // Out of the browser's reach, like every other reporting function. Asked of the file that wrote
    // this rule AND of the one that is the last definer today — `create or replace` keeps whatever
    // privileges the function already had, so a later definer that left these two lines out would
    // pass a check made on the first file alone while being the body that actually runs. (Only these
    // two: the definers OLDER than the fix predate the rule and are not re-litigated here.)
    for (const definer of new Set(["20261002221947_phoenix_crm_plan_vs_actual_sent_days.sql", definers[definers.length - 1]])) {
      const fixSql = sqlOf(`supabase/migrations/${definer}`);
      assert.match(
        fixSql,
        /^revoke execute on function public\.phoenix_crm_report_plan_vs_actual\(text\[\], date, date, boolean\) from public, anon, authenticated;$/m,
        `${definer}: revoked from PUBLIC, which is what anon and authenticated inherit through`,
      );
      assert.match(fixSql, /^grant execute on function public\.phoenix_crm_report_plan_vs_actual\(text\[\], date, date, boolean\) to service_role;$/m, definer);
    }
  }

  // ── 5f. Every reader asks the one rule ────────────────────────────────────────────────────────────
  {
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    const reader = visits.slice(visits.indexOf("export async function plannedCustomersOn("), visits.indexOf("export async function loadVisitForm("));
    assert.match(reader, /\.select\(`id, \$\{PLAN_DAY_COLUMNS\}`\)/, "the plan row with what the rule reads");
    assert.match(reader, /loadPlanDayFacts\(\[plan as Row\], isTest\)/);
    assert.match(reader, /status: day \? planDayStatus\(\{ \.\.\.day, date \}\) : null,/, "it hands back THIS DAY's status — so Planned visit, Today and the missed record ask one rule");
    assert.match(visits, /isPlanSentForReview\(planDay\.status\) \? planDay\.customerIds : \[\]/, "Planned visit offers the day's sent set");
    assert.ok(source("src/lib/phoenix-crm/server/today.ts").includes('const approvedIds = planned.status === "approved" ? planned.customerIds : [];'), "Today: the day's APPROVED plan only");

    const missed = source("src/lib/phoenix-crm/server/missed-records.ts");
    assert.match(missed, /const planSent = isPlanSentForReview\(plan\.status\);/, "the missed record starts from the same day's answer");
    assert.doesNotMatch(missed, /plan\.status === "submitted"/, "never a hand-rolled copy of the rule");

    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.match(team, /\.in\("status", \[\.\.\.PLAN_STATUSES_WITH_SENT_DAYS\]\)/, "the Team tab reads every plan that can hold a sent day");
    assert.match(team, /if \(!plan \|\| !isPlanDaySent\(\{ \.\.\.plan, date \}\)\) continue;/, "and keeps the ones sent ON the day");

    const reports = source("src/lib/phoenix-crm/server/reports.ts");
    const planned = reports.slice(reports.indexOf("async function plannedDaysByCustomer("), reports.indexOf("async function listedCustomers("));
    assert.match(planned, /\.in\("status", \[\.\.\.PLAN_STATUSES_WITH_SENT_DAYS\]\)/, "the frequency report reads the same plans");
    assert.match(planned, /isPlanDaySent\(\{ \.\.\.plan, date: day \}\)/, "and counts a planning only on a day it was sent");

    const facts = source("src/lib/phoenix-crm/server/plan-day-status.ts");
    assert.match(facts, /PLAN_STATUSES_WITH_SENT_DAYS: ReadonlyArray<PhoenixCrmPlanStatus> = \["submitted", "approved", "returned"\];/);
    assert.match(facts, /const returnedDay = standingReturnedDay\(\{/, "the STANDING day — an acknowledged edit after the return lifts it");
    assert.match(facts, /editAcknowledgedAt: editAcknowledgedAt\(edits\.get\(id\) \?\? null\),/);
    assert.match(
      facts,
      /\.select\("plan_id, from_status"\)\s*\.in\("plan_id", batch\)\s*\.eq\("event_type", "returned"\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/,
      "what the week was when the day went back: the latest RETURN event's own from_status",
    );
    assert.doesNotMatch(
      facts,
      /\.eq\("to_status", "returned"\)/,
      "never the latest row with to_status 'returned': a plan save writes one that reads 'returned from returned'",
    );

    // A save on a week returned for ONE day keeps naming the day (found 2026-10-02, before any plan was
    // returned on production): phoenix_crm_save_visit's Still planned test reads the LATEST event with a
    // to_status, and a save is one.
    const keeps = readFileSync(
      new URL("supabase/migrations/20261002142625_phoenix_crm_saved_event_keeps_the_returned_day.sql", ROOT),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .replace(/--.*$/gm, "");
    assert.match(keeps, /create or replace function public\.phoenix_crm_save_plan\(p jsonb\)/, "the plan save is the one function replaced");
    assert.match(
      keeps,
      /v_plan\.id, 'saved', v_actor, v_plan\.status, v_plan\.status, v_plan\.version,\s*jsonb_build_object\('items', v_count, 'days', to_jsonb\(v_days\)\)\s*\|\| case\s*when v_plan\.status = 'returned' and v_plan\.returned_day is not null\s*then jsonb_build_object\('returned_day', v_plan\.returned_day\)\s*else '\{\}'::jsonb\s*end/,
      "the 'saved' event carries returned_day while the week stands returned for one day",
    );
    assert.match(keeps, /returning pl\.\* into v_plan;\s*insert into public\.phoenix_crm_plan_events/, "read from the row the save just wrote");
    assert.equal((keeps.match(/insert into public\.phoenix_crm_plan_events/g) ?? []).length, 2, "still the two plan-event inserts the save always had");

    // ONE rule: no server reader decides "sent" with a list of its own any more.
    for (const file of readdirSync(new URL("src/lib/phoenix-crm/server/", ROOT)).filter((name) => name.endsWith(".ts"))) {
      assert.doesNotMatch(
        source(`src/lib/phoenix-crm/server/${file}`),
        /\.in\("status", \["submitted", "approved"\]\)/,
        `${file} reads a sent plan through PLAN_STATUSES_WITH_SENT_DAYS and isPlanDaySent, never a list of its own`,
      );
    }
  }

  // ── 5g. The rep and the reviewer are told ───────────────────────────────────────────────────────
  {
    const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
    const note = panel.slice(panel.indexOf("export function ReturnedDayNote("), panel.indexOf("export function ChoiceLabel("));
    assert.ok(note.includes("The other days stay as you sent them, and your visits on them still count as planned."), "the rep reads that his other days still count as planned");
    assert.ok(note.includes("Until you send the week again, your visits on ${name} count as off-plan."), "and that only the returned day's visits wait");
    assert.doesNotMatch(note, /visits this week count as off-plan/, "never the whole week's, after one day went back");
    assert.ok(note.includes("their visits on those days still count as planned."), "the reviewer reads it too");
    assert.ok(
      source("src/components/phoenix-crm/plan-decision.tsx").includes("their visits on those days still count as"),
      "and is told before he presses Return",
    );
  }
}
