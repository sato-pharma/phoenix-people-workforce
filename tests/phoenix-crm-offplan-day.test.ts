import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  APPROVE_ALL_FROM,
  approveAllFailureText,
  approveAllNotice,
  approveAllTargets,
  groupOffPlanDays,
  movedDayReason,
  movedFromDays,
  offPlanDecisionBody,
  parseSentCopy,
  planOpenedAfter,
  plannedDaysAt,
  plannedForText,
  planStoodAt,
  sentCopyNeeded,
  sentDaysOfWeek,
  splitOffPlanDays,
  type OffPlanVisitFacts,
  type PlanEventFact,
} from "../src/lib/phoenix-crm/offplan-day.ts";
import type { PhoenixCrmPlanStatus } from "../src/lib/phoenix-crm/types.ts";
import { parseUnplannedReason, type UnplannedVisitStatus } from "../src/lib/phoenix-crm/unplanned-rules.ts";

/**
 * Phoenix CRM — the off-plan DAY and the MOVED day (owner, 2026-10-02, two of his picks).
 *
 *   A · "Off-plan day in one place: 8.9% of September's regular calls were off-plan. Each one needs the
 *       district manager, then SFE: about 48 a day for one SFE Manager. One screen per rep per day, and a
 *       person still decides each visit."
 *   B · "Moved-day reason pre-filled: 250 of those off-plan calls were a doctor planned for another day
 *       that week. The reason fills itself and the approver sees the original day."
 *
 * What is pinned, and why each half matters:
 *
 *   1. The grouping is one card per rep per visit day, OLDEST first — and only the visits waiting at
 *      the viewer's step are on his own half, so "Approve all" can never reach a visit whose own
 *      Approve he could not press.
 *   2. "Approve all" is the per-visit decision ONCE PER VISIT, through the one route that decides a
 *      visit, behind a confirm. A bulk route or a bulk RPC would skip the per-visit checks (the step
 *      read from the row, the reviewer or SFE gate, the version) — that is the thing that must never
 *      exist. One failure is named and the others stand.
 *   3. The moved day is the plan's own: the sent plan AS IT STOOD AT THE VISIT'S captured_at, the same
 *      field week (Saturday to Thursday, a Friday belongs to the week before it), never the visit's own
 *      day, never a day the plan had returned, never a plan sent after the visit, and never a passed day
 *      on which the customer was in fact seen.
 *   4. The rep's reason fills itself with that day and stays his to change — no step, no field — and
 *      the approver's line is computed by the server from the plan, never from the rep's text.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** The text of a function, from its declaration to its own closing brace at the start of a line. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must still exist`);
  const rest = text.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

/** `first` appears, `second` appears, and `first` comes before `second`. */
function assertBefore(text: string, first: string, second: string, message: string): void {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  assert.ok(a >= 0, `${message} — missing: ${first}`);
  assert.ok(b >= 0, `${message} — missing: ${second}`);
  assert.ok(a < b, message);
}

// The field week of Saturday 3 October 2026: Saturday to Wednesday, Thursday morning, never Friday.
const PREV_THU = "2026-10-01";
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const MON = "2026-10-05";
const TUE = "2026-10-06";
const WED = "2026-10-07";
const THU = "2026-10-08";
const FRI = "2026-10-09";
const NEXT_SAT = "2026-10-10";

const CUSTOMER = "c-hoda";
const OTHER = "c-karim";

function event(id: number, eventType: string, toStatus: PhoenixCrmPlanStatus | null, createdAt: string, returnedDay: string | null = null): PlanEventFact {
  return { id, eventType, toStatus, createdAt, returnedDay };
}

/** Sent on Thursday 1 October and approved on Friday 2 October: the ordinary week. */
const SENT_AND_APPROVED: PlanEventFact[] = [
  event(1, "created", "draft", "2026-09-30T08:00:00.000Z"),
  event(2, "submitted", "submitted", "2026-10-01T18:00:00.000Z"),
  event(3, "approved", "approved", "2026-10-02T08:00:00.000Z"),
];

/** Monday's visit, logged at 10:00 Cairo. */
const MONDAY_VISIT_AT = "2026-10-05T07:00:00.000Z";

type Visit = OffPlanVisitFacts & { customerName: string; version: number };

function visit(overrides: Partial<Visit> & Pick<Visit, "visitId">): Visit {
  return {
    seatId: "gz6",
    repHrId: "MR-1",
    repName: "Mona Adel",
    territoryName: "Faisal",
    visitDate: MON,
    raisedAt: "2026-10-05T07:00:00.000Z",
    status: "manager_pending" as UnplannedVisitStatus,
    canDecide: true,
    customerName: "Hoda Samir",
    version: 1,
    ...overrides,
  };
}

export function runPhoenixCrmOffplanDayTests(): void {
  // ── A1 · One card per rep per visit day, the oldest day first ────────────────────────────────────
  {
    const visits: Visit[] = [
      visit({ visitId: "v-tue-mona-2", visitDate: TUE, raisedAt: "2026-10-06T11:00:00.000Z", customerName: "Second on Tuesday" }),
      visit({ visitId: "v-mon-sara", seatId: "gz7", repHrId: "MR-2", repName: "Sara Nabil", territoryName: "Haram", raisedAt: "2026-10-05T09:00:00.000Z" }),
      visit({ visitId: "v-tue-mona-1", visitDate: TUE, raisedAt: "2026-10-06T08:00:00.000Z", customerName: "First on Tuesday" }),
      visit({ visitId: "v-mon-mona", raisedAt: "2026-10-05T08:00:00.000Z" }),
    ];
    const days = groupOffPlanDays(visits);
    assert.deepEqual(
      days.map((day) => [day.repName, day.visitDate, day.visits.map((entry) => entry.visitId)]),
      [
        ["Mona Adel", MON, ["v-mon-mona"]],
        ["Sara Nabil", MON, ["v-mon-sara"]],
        ["Mona Adel", TUE, ["v-tue-mona-1", "v-tue-mona-2"]],
      ],
      "one card per rep per visit day, the OLDEST day first; on one day, the rep who logged first; inside a card, the order he logged them",
    );
    assert.equal(days[2].territoryName, "Faisal", "a card names its territory");
    assert.notEqual(days[0].key, days[2].key, "the same rep on two days is two cards");
    assert.notEqual(days[0].key, days[1].key, "two reps on one day are two cards");

    // The viewer's own half holds only what waits at HIS step; the rest is read on the other half.
    const mixed: Visit[] = [
      visit({ visitId: "with-sfe", status: "sfe_pending", canDecide: false }),
      visit({ visitId: "with-me-1" }),
      visit({ visitId: "with-me-2", raisedAt: "2026-10-05T09:30:00.000Z" }),
    ];
    const { forYou, others } = splitOffPlanDays(mixed);
    assert.equal(forYou.length, 1, "his half: one card for the rep's day");
    assert.deepEqual(forYou[0].visits.map((entry) => entry.visitId), ["with-me-1", "with-me-2"], "holding only the visits at his step");
    assert.deepEqual(others[0].visits.map((entry) => entry.visitId), ["with-sfe"], "the visit waiting on SFE sits on the other half, on its own card");
  }

  // ── A2 · "Approve all" is the per-visit decision, once per visit ─────────────────────────────────
  {
    const day = groupOffPlanDays([
      visit({ visitId: "a", version: 3 }),
      visit({ visitId: "b", raisedAt: "2026-10-05T08:00:00.000Z", version: 1 }),
      visit({ visitId: "not-mine", raisedAt: "2026-10-05T09:00:00.000Z", canDecide: false }),
      visit({ visitId: "settled", raisedAt: "2026-10-05T10:00:00.000Z", status: "approved" }),
    ])[0];
    assert.deepEqual(
      approveAllTargets(day).map((entry) => entry.visitId),
      ["a", "b"],
      "Approve all decides exactly the visits whose own Approve this viewer may press — never one at another step, never a settled one",
    );
    assert.equal(APPROVE_ALL_FROM, 2, "offered from two visits up: for one, its own Approve is the same press");
    assert.deepEqual(
      offPlanDecisionBody({ visitId: "a", version: 3 }, "approve", null),
      { visitId: "a", decision: "approve", note: null, expectedVersion: 3 },
      "each decision carries the version THAT visit was read at, exactly as its own Approve does — so one that moved on is refused, not decided",
    );

    // One failure is named, the others stand.
    assert.equal(approveAllFailureText("phoenix_crm_unplanned_decided", "x"), "it was already decided");
    assert.equal(approveAllFailureText("phoenix_crm_unplanned_wrong_stage", "x"), "it has moved on to the next step");
    assert.equal(approveAllFailureText("phoenix_crm_version_conflict", "x"), "it changed on another screen");
    assert.equal(approveAllFailureText("phoenix_crm_unplanned_not_found", "x"), "it is no longer waiting for a decision");
    assert.equal(approveAllFailureText("offline", "No connection. Check the phone's internet and try again."), "No connection. Check the phone's internet and try again.");

    const all = approveAllNotice({ repName: "Mona Adel", visitDate: TUE, outcomes: [{ customerName: "A", ok: true }, { customerName: "B", ok: true }] });
    assert.deepEqual(all, { tone: "info", title: "Approved: 2 off-plan visits of Mona Adel on Tuesday 6 Oct.", failures: [] });
    const some = approveAllNotice({
      repName: "Mona Adel",
      visitDate: TUE,
      outcomes: [{ customerName: "A", ok: true }, { customerName: "Hoda Samir", ok: false, why: "it was already decided" }, { customerName: "C", ok: true }],
    });
    assert.equal(some.tone, "warn");
    assert.equal(some.title, "Approved 2 of the 3 off-plan visits of Mona Adel on Tuesday 6 Oct.", "how many went through");
    assert.deepEqual(some.failures, ["Hoda Samir: it was already decided."], "and, by name, which did not and why");
    const none = approveAllNotice({ repName: "Mona Adel", visitDate: TUE, outcomes: [{ customerName: "A", ok: false, why: "it changed on another screen" }] });
    assert.equal(none.tone, "bad");
    assert.equal(none.title, "None of the 1 off-plan visit of Mona Adel on Tuesday 6 Oct was approved.");

    // The card: ONE post, to the ONE route that decides a visit, used by both buttons.
    const card = source("src/components/phoenix-crm/unplanned-visit-card.tsx");
    assert.equal([...card.matchAll(/crmPost\(/g)].length, 1, "the card posts from one place and one place only");
    assert.ok(
      card.includes('return crmPost("/api/phoenix-crm/visits/unplanned", offPlanDecisionBody(visit, decision, note), "visit");'),
      "that one place is the existing per-visit decide route, with the per-visit body",
    );
    assert.match(card, /await postOffPlanDecision\(visit, decision, trimmed \|\| null\);/, "a visit's own Approve and Refuse go through it");
    const approveAll = functionBody(card, "  async function approveAll() {").split("\n  }\n")[0];
    assert.match(
      approveAll,
      /for \(const visit of visits\) \{\s*try \{\s*await postOffPlanDecision\(visit, "approve", null\);/,
      "and Approve all is that same call, once per visit, one at a time",
    );
    assert.doesNotMatch(approveAll, /Promise\.all|crmPost|\/api\//, "never a bulk post, never a route of its own");
    assert.match(approveAll, /catch \(error\) \{\s*outcomes\.push\(\{ customerName: visit\.customerName, ok: false,/, "a failure is recorded and the loop goes on");
    // Behind a confirm: the first press only asks; the confirm's own button is the one that runs it.
    assert.ok(card.includes("onClick={() => setConfirming(true)}"), "Approve all opens a confirm first");
    assert.equal([...card.matchAll(/void approveAll\(\)/g)].length, 1, "and only the confirm runs it");
    assertBefore(card, "confirming ? (", "onClick={() => void approveAll()}", "the run sits inside the confirm");

    // No bulk route was added beside the per-visit one, and the per-visit one still decides ONE visit.
    assert.deepEqual(readdirSync(new URL("app/api/phoenix-crm/visits/unplanned/", ROOT)), ["route.ts"], "no second route under the decide route");
    assert.ok(source("app/api/phoenix-crm/visits/unplanned/route.ts").includes("decideUnplannedVisit(viewer, body)"), "the route decides the one visit it is sent");
    const service = source("src/lib/phoenix-crm/server/unplanned.ts");
    assert.match(service, /assertUnplannedVisitApprover\(viewer, seat, isTest, stage\)/, "and asserts this person at that visit's own step, every time");

    // The Team tab draws the cards from the split, and hands a batch's result to the notice at its top.
    const tab = source("src/components/phoenix-crm/team-tab.tsx");
    assert.ok(tab.includes("const { forYou, others } = splitOffPlanDays(visits);"), "the Team tab groups through the one rule");
    assert.ok(tab.includes("<OffPlanDayCard day={day} key={day.key} onBatchDone={onBatchDone} onChanged={onChanged} />"), "one card per rep's day");
    assert.ok(tab.includes("onBatchDone={showNotice}"), "a batch's result reaches the notice the Team tab already shows");
  }

  // ── B1 · The plan as it stood at the visit's instant ─────────────────────────────────────────────
  {
    const approved = planStoodAt({ events: SENT_AND_APPROVED, acknowledgedAt: [], at: MONDAY_VISIT_AT });
    assert.deepEqual(approved, { status: "approved", returnedDay: null });
    assert.deepEqual(sentDaysOfWeek(SAT, approved), [SAT, SUN, MON, TUE, WED, THU], "an approved week is sent Saturday to Thursday — never Friday");

    // Sent AFTER the visit: at the visit's own instant there was no sent plan, so nothing was planned.
    const lateSend = [event(1, "created", "draft", "2026-10-03T08:00:00.000Z"), event(2, "submitted", "submitted", "2026-10-05T09:00:00.000Z")];
    assert.deepEqual(sentDaysOfWeek(SAT, planStoodAt({ events: lateSend, acknowledgedAt: [], at: MONDAY_VISIT_AT })), [], "a plan sent after the visit was not his plan when he went");

    // ONE day returned before the visit: every other day still stands as sent ("Still planned").
    const oneDay = [...SENT_AND_APPROVED, event(4, "returned", "returned", "2026-10-04T10:00:00.000Z", TUE)];
    assert.deepEqual(
      sentDaysOfWeek(SAT, planStoodAt({ events: oneDay, acknowledgedAt: [], at: MONDAY_VISIT_AT })),
      [SAT, SUN, MON, WED, THU],
      "the returned day alone is not sent",
    );
    // His save of the returned day writes a 'saved' event to 'returned' with no day in it. A save sets
    // no status, so it must not hide the day and turn the whole week into a whole-week return.
    const savedAfter = [...oneDay, event(5, "saved", "returned", "2026-10-04T11:00:00.000Z")];
    assert.deepEqual(
      sentDaysOfWeek(SAT, planStoodAt({ events: savedAfter, acknowledgedAt: [], at: MONDAY_VISIT_AT })),
      [SAT, SUN, MON, WED, THU],
      "saving the returned day keeps the other days sent (owner's 'Still planned' ruling)",
    );
    // An acknowledged edit after the return and before the visit opens the whole week: nothing is sent.
    assert.deepEqual(sentDaysOfWeek(SAT, planStoodAt({ events: oneDay, acknowledgedAt: ["2026-10-04T12:00:00.000Z"], at: MONDAY_VISIT_AT })), []);
    // …but one acknowledged after the visit changes nothing about the visit.
    assert.deepEqual(
      sentDaysOfWeek(SAT, planStoodAt({ events: oneDay, acknowledgedAt: ["2026-10-05T12:00:00.000Z"], at: MONDAY_VISIT_AT })),
      [SAT, SUN, MON, WED, THU],
    );
    // A whole-week return, a reopened week and a draft are his to change, so none of them is a plan.
    for (const last of [event(4, "returned", "returned", "2026-10-04T10:00:00.000Z"), event(4, "reopened", "draft", "2026-10-04T10:00:00.000Z")]) {
      assert.deepEqual(sentDaysOfWeek(SAT, planStoodAt({ events: [...SENT_AND_APPROVED, last], acknowledgedAt: [], at: MONDAY_VISIT_AT })), [], `${last.eventType}: nothing sent`);
    }
    // Two events at one instant: the database breaks the tie on the event's id, and so does this.
    const tie = [event(7, "submitted", "submitted", "2026-10-04T10:00:00.000Z"), event(8, "returned", "returned", "2026-10-04T10:00:00.000Z")];
    assert.equal(planStoodAt({ events: tie, acknowledgedAt: [], at: MONDAY_VISIT_AT }).status, "returned", "the higher id is the later event");
  }

  // ── B2 · The copy a send kept, read only when the plan was opened again after the visit ───────────
  {
    const reopenedLater = [...SENT_AND_APPROVED, event(4, "returned", "returned", "2026-10-05T12:00:00.000Z")];
    assert.equal(planOpenedAfter({ events: SENT_AND_APPROVED, acknowledgedAt: [], at: MONDAY_VISIT_AT }), false, "a week nobody opened since: its items are as they were");
    assert.equal(planOpenedAfter({ events: reopenedLater, acknowledgedAt: [], at: MONDAY_VISIT_AT }), true, "returned after the visit: its items may have moved");
    assert.equal(planOpenedAfter({ events: SENT_AND_APPROVED, acknowledgedAt: ["2026-10-05T12:00:00.000Z"], at: MONDAY_VISIT_AT }), true, "an acknowledged edit after it opens it too");
    assert.equal(
      planOpenedAfter({ events: [...SENT_AND_APPROVED, event(9, "saved", "approved", "2026-10-05T12:00:00.000Z")], acknowledgedAt: [], at: MONDAY_VISIT_AT }),
      false,
      "a save opens nothing",
    );
    assert.equal(sentCopyNeeded({ events: reopenedLater, acknowledgedAt: [], at: MONDAY_VISIT_AT }), 2, "the copy is the last SEND up to the visit");
    assert.equal(sentCopyNeeded({ events: SENT_AND_APPROVED, acknowledgedAt: [], at: MONDAY_VISIT_AT }), null, "and is not read when the items cannot have moved");

    // After the visit the week came back and he moved this customer from Tuesday to Wednesday. The
    // approver is shown Tuesday — the plan when he went — not the plan as it is now.
    const now = [{ date: WED, customerId: CUSTOMER }];
    const copy = parseSentCopy([{ plan_date: TUE, customer_id: CUSTOMER, list_type: "PM", name: "Hoda Samir" }]);
    assert.deepEqual(copy, [{ date: TUE, customerId: CUSTOMER }]);
    const facts = { weekStart: SAT, at: MONDAY_VISIT_AT, customerId: CUSTOMER, events: reopenedLater, acknowledgedAt: [] };
    assert.deepEqual(plannedDaysAt({ ...facts, items: now, sentCopy: copy }), [TUE], "the copy of what was sent is the plan as it stood");
    assert.deepEqual(plannedDaysAt({ ...facts, items: now, sentCopy: null }), [WED], "with no copy kept, the items as they are — the best there is");
    assert.deepEqual(
      plannedDaysAt({ ...facts, events: SENT_AND_APPROVED, items: [{ date: TUE, customerId: CUSTOMER }, { date: WED, customerId: OTHER }], sentCopy: null }),
      [TUE],
      "only this customer's days",
    );
    // A save's details hold a COUNT of items, never a copy; anything that is not a list of days reads as no copy.
    assert.equal(parseSentCopy(42), null);
    assert.equal(parseSentCopy(null), null);
    assert.equal(parseSentCopy([{ plan_date: "Tuesday", customer_id: CUSTOMER }]), null);
  }

  // ── B3 · The day a visit was moved from ──────────────────────────────────────────────────────────
  {
    assert.deepEqual(movedFromDays({ visitDate: MON, plannedDays: [TUE], seenDays: [] }), [TUE], "planned for Tuesday, seen on Monday");
    assert.deepEqual(movedFromDays({ visitDate: MON, plannedDays: [MON], seenDays: [] }), [], "the visit's own day is never a day it was moved from");
    // Week boundaries: Saturday starts the week, so last Thursday is another week's plan.
    assert.deepEqual(movedFromDays({ visitDate: SAT, plannedDays: [PREV_THU, TUE], seenDays: [] }), [TUE], "last week's Thursday is not this week");
    assert.deepEqual(movedFromDays({ visitDate: THU, plannedDays: [NEXT_SAT], seenDays: [] }), [], "next week's Saturday is not this week either");
    // Thursday reaches back over the whole week.
    assert.deepEqual(movedFromDays({ visitDate: THU, plannedDays: [SAT, WED], seenDays: [] }), [SAT, WED]);
    // A Friday belongs to the week before it.
    assert.deepEqual(movedFromDays({ visitDate: FRI, plannedDays: [WED], seenDays: [] }), [WED], "a Friday visit is the week of the Saturday before it");
    assert.deepEqual(movedFromDays({ visitDate: MON, plannedDays: [FRI], seenDays: [] }), [], "a Friday holds nothing, so it is never a planned day");
    // A passed planned day on which he WAS seen: today's visit is another one, not that one moved.
    assert.deepEqual(movedFromDays({ visitDate: THU, plannedDays: [SAT], seenDays: [SAT] }), [], "seen on the day he was planned for");
    assert.deepEqual(movedFromDays({ visitDate: MON, plannedDays: [TUE], seenDays: [TUE] }), [TUE], "a day still ahead is never 'seen' already");
    assert.deepEqual(movedFromDays({ visitDate: MON, plannedDays: [TUE, SAT, TUE], seenDays: [] }), [SAT, TUE], "each day once, in order");
  }

  // ── B4 · The words: the rep's reason, and the approver's line ────────────────────────────────────
  {
    assert.equal(movedDayReason([TUE]), "Planned for Tuesday 6 Oct; seen today instead.", "the plan's own day label, the module's words");
    assert.equal(movedDayReason([SAT, TUE]), "Planned for Saturday 3 Oct and Tuesday 6 Oct; seen today instead.");
    assert.equal(movedDayReason([SAT, MON, TUE]), "Planned for Saturday 3 Oct, Monday 5 Oct and Tuesday 6 Oct; seen today instead.");
    assert.equal(movedDayReason([]), null, "no planned day: the box starts empty as it always has");
    assert.equal(plannedForText([TUE]), "Planned for Tuesday 6 Oct", "what the approver reads under the customer's name");
    assert.equal(plannedForText([]), null);

    // It removes the typing: the sentence is a reason the save itself accepts, unchanged.
    const parsed = parseUnplannedReason(movedDayReason([SAT, MON, TUE]));
    assert.ok(parsed.ok, "the filled-in reason passes the reason's own ceiling");
    assert.equal(parsed.ok && parsed.value, "Planned for Saturday 3 Oct, Monday 5 Oct and Tuesday 6 Oct; seen today instead.");
    // His own plan, in his own module's words — never a check on him, never "doctor".
    for (const text of [movedDayReason([TUE]) ?? "", plannedForText([TUE]) ?? "", "Filled in from your plan. Change it if you went for another reason."]) {
      assert.doesNotMatch(text, /\b(doctor|doctors|account|accounts)\b/i, "the rep's words say customer, AM and PM");
      assert.doesNotMatch(text, /integrity|flag|mock|spoof|fraud|cheat|check|distance/i, "nothing that judges him");
    }
  }

  // ── B5 · The rep's side: the reason fills itself, with no step and no field added ────────────────
  {
    const visits = source("src/lib/phoenix-crm/server/visits.ts");
    const form = functionBody(visits, "export async function loadVisitForm(");
    assertBefore(form, "loadPlannedOtherDays(seat.seatId, isTest, today),", "await ensured;", "the other planned days are one more read of the form's own wave");
    assert.ok(form.includes("plannedOtherDays: plannedOtherDays.get(customerId) ?? [],"), "and ride on each customer the form already sends");

    const reader = source("src/lib/phoenix-crm/server/offplan-day.ts");
    const otherDays = functionBody(reader, "export async function loadPlannedOtherDays(");
    assert.match(otherDays, /loadPlanDayFacts\(\[plan\], isTest\)/, "the week is read through the plan's own day-by-day facts");
    assert.match(otherDays, /sentDaysOfWeek\(weekStart, stood\)/, "and only its SENT days count — the module's one rule, day by day");

    const tab = source("src/components/phoenix-crm/visits-tab.tsx");
    const route = tab.slice(tab.indexOf("function routeFor("), tab.indexOf("\n}", tab.indexOf("function routeFor(")));
    assert.ok(route.includes('return { name: "reason", customerId: customer.customerId, reason: filledReason(customer), back: null };'), "Today's tap lands on the reason, filled in");
    assert.ok(
      tab.includes('onPick={(customerId) => onStep({ name: "reason", customerId, reason: filledReason(find(customerId)), back: { name: "out_of_plan" } })}'),
      "and so does picking the customer under Out of plan",
    );
    assert.match(functionBody(tab, "function filledReason("), /movedDayReason\(customer\.plannedOtherDays\)/, "from the days the server sent, in the one sentence");
    // No step is added for the moved day: Add visit's screens are the ones it had, plus the Pharmacy
    // visit picker (owner, 2026-10-03: a pharmacy visit is logged normally — no plan, no reason) and
    // Add a pharmacy beside it (the same night: "he can also add a pharmacy without any approval").
    const steps = /type AddStep =([\s\S]*?);\n/.exec(tab)?.[1] ?? "";
    assert.deepEqual(
      [...steps.matchAll(/name: "([a-z_]+)"/g)].map((match) => match[1]),
      ["start", "open", "planned", "unplanned", "out_of_plan", "out_of_list", "pharmacy", "pharmacy_new", "pharmacy_details", "reason", "form"],
      "Add visit has the same screens it had, the Pharmacy visit picker, Add a pharmacy, and the pharmacy's own details beside it",
    );
    // `pharmacy_details` (owner, 2026-10-09) is a SIDE screen, not a step: it is reached from a
    // pharmacy's own row in the picker and leads back to that row, so the walk from Add visit to a
    // logged visit is the one it has always been. That is what the next two assertions hold — the
    // path INTO it is the pharmacy row, and the path OUT of it is the pharmacy picker, never the form.
    assert.ok(
      tab.includes('{ name: "pharmacy_details", customerId }'),
      "the pharmacy's details are opened on one named pharmacy",
    );
    // The RENDER case, not the one that names the title — `case "pharmacy_details": {`, with its brace.
    const detailsCase = /case "pharmacy_details": \{([\s\S]*?)\n    \}/.exec(tab)?.[1] ?? "";
    assert.ok(detailsCase.includes("<PharmacyDetailsScreen"), "the pharmacy's details screen is what that step draws");
    assert.equal(
      [...detailsCase.matchAll(/onStep\(\{ name: "([a-z_]+)"/g)].map((match) => match[1]).join(","),
      "pharmacy,pharmacy,pharmacy",
      "every way out of it — Back, Save and the shell's own dismiss — returns to the Pharmacy visit picker, never into the form",
    );
    // No field is added: the reason screen still holds one box, and it is his to change.
    const picker = source("src/components/phoenix-crm/visit-customer-picker.tsx");
    const reasonScreen = functionBody(picker, "export function OutOfPlanReason(");
    assert.equal([...reasonScreen.matchAll(/<textarea/g)].length, 1, "one box");
    assert.doesNotMatch(reasonScreen, /<input|readOnly|disabled=\{true\}/, "and nothing else to fill, and nothing locked");
    assert.match(reasonScreen, /const \[reason, setReason\] = useState\(initialReason\);/, "the filled-in sentence is only where the box starts");
  }

  // ── B6 · The approver's side: the day comes from the plan, computed by the server ────────────────
  {
    const team = source("src/lib/phoenix-crm/server/team.ts");
    assert.match(team, /loadMovedFromDays\(unplannedRows\.map\(unplannedVisitRef\), isTest\)/, "the Team view reads the moved day for every waiting visit, in one batched read");
    assert.match(team, /plannedFor: movedFrom\.get\(view\.visitId\) \?\? \[\],/, "and each visit carries the server's answer");

    const service = source("src/lib/phoenix-crm/server/unplanned.ts");
    // 🔴 A BOUNDARY EACH SIDE, AND THE LEFT ONE OPTIONAL. Closing the regex on `captured_at\)` also
    // demanded that it be the LAST column inside the join, and it went red on 2026-10-12 the moment
    // the companion columns were added after it. That the column is SELECTED is the rule; where it
    // sits in the list is nobody's. A longer name merely ending in it is still refused — that is what
    // the right-hand `\b` does, because `photo_captured_at` carries no boundary on the left.
    assert.match(service, /visit:phoenix_crm_visits!visit_id\(([^)]*[,\s])?captured_at\b/, "the visit's own captured_at rides on the row");
    const ref = functionBody(service, "export function unplannedVisitRef(");
    assert.ok(ref.includes("capturedAt: textOrNull(visit.captured_at),"), "the instant the plan is read at is the visit's own");
    assert.doesNotMatch(ref, /clarification/, "and the rep's reason is not handed to the read at all");

    const reader = source("src/lib/phoenix-crm/server/offplan-day.ts");
    assert.doesNotMatch(reader, /clarification|unplanned_reason/, "the planned day is read from the plan — never from what the rep wrote");
    assert.doesNotMatch(reader, /\.(insert|update|upsert|delete|rpc)\(/, "and the read writes nothing");
    const moved = functionBody(reader, "async function movedFromDaysOfBatch(");
    assert.match(moved, /\.neq\("event_type", "saved"\)/, "the events that set a status, saves left out at the source");
    assert.match(moved, /plannedDaysAt\(\{/, "the plan as it stood at the visit's instant");
    assert.match(moved, /movedFromDays\(\{ visitDate: visit\.visitDate, plannedDays,/, "then the one rule for a moved day");
    for (const table of ["phoenix_crm_plans", "phoenix_crm_plan_events", "phoenix_crm_plan_edit_requests", "phoenix_crm_plan_items", "phoenix_crm_visits"]) {
      assert.ok(moved.includes(`from("${table}")`), `${table} is read in the batch`);
    }
    assert.doesNotMatch(moved, /for \(const visit of visits\)[\s\S]{0,200}await /, "never one query per visit");

    // On the card, under the customer's name, in the module's words.
    const card = source("src/components/phoenix-crm/unplanned-visit-card.tsx");
    assert.match(card, /const plannedFor = plannedForText\(visit\.plannedFor\);/, "the card prints the server's days");
    assert.doesNotMatch(card, /plannedForText\(visit\.clarification|movedDayReason/, "and never re-reads them out of the reason");
    assert.match(card, /<CrmPill>\{listText\(visit\.customerListType\)\}<\/CrmPill>/, "each visit says AM or PM");
    assert.match(card, /<span className="font-black text-slate-800">Why they went: <\/span>/, "and what they wrote");
    assert.doesNotMatch(card, /rounded-(?!none)/, "square corners");
    assert.doesNotMatch(card, /\btruncate\b|line-clamp|text-ellipsis/, "nothing cut short");
  }

  console.log("phoenix-crm off-plan day: OK");
}
