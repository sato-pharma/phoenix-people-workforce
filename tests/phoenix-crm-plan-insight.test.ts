import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

import { followUpText, lastSeenText, plannerRowInsight, usualDaysText } from "../src/components/phoenix-crm/labels.ts";
import {
  buildPlannerInsights,
  followUpInWeek,
  LAST_SEEN_WINDOW_DAYS,
  laterDay,
  placesHaveDays,
  plannerInsightOf,
  USUAL_DAY_MIN_VISITS,
  USUAL_DAYS_WINDOW_DAYS,
  usualDayRank,
  usualDaysOf,
  usualWeekdaysOf,
} from "../src/lib/phoenix-crm/plan-insight.ts";
import { suggestDay, suggestWeek, type SuggestInput, type SuggestResult } from "../src/lib/phoenix-crm/plan-suggest.ts";
import type { PlanItemDraft } from "../src/lib/phoenix-crm/plan-rules.ts";
import type { DraftDay, DraftWeek } from "../src/lib/phoenix-crm/plan-week-draft.ts";
import type { PlannerCustomer, PlannerInsight } from "../src/lib/phoenix-crm/suggestions.ts";
import type { PhoenixCrmGrade, PhoenixCrmDoctorListType, PhoenixCrmTiming } from "../src/lib/phoenix-crm/types.ts";
import type { LastNextStepRow } from "../src/lib/phoenix-crm/visit-outcome.ts";

/**
 * Phoenix CRM — what the plan board tells the rep about each customer while he plans a day (owner,
 * 2026-10-02), three features in one place:
 *
 *   1. LAST SEEN on every row — the latest of his iReports360 history and his own Phoenix visits — and,
 *      for a VALIDATED customer only, his month beside it ("Last seen Tue 29 Sept · 1 of 3 visits this
 *      month"). Coverage counts validated customers only (owner, 2026-10-02): a customer not validated
 *      yet never reads a target he does not have.
 *   2. iReports360's USUAL DAYS while he has no saved days and hours — a weekday counts only when he
 *      was seen on it on at least TWO different days in the 13-week window: a quiet hint on his row,
 *      and Suggest offering him on those weekdays first — an ORDER, never a filter and never a refusal.
 *      One visit, or visits scattered one per weekday, give no hint and no preference. Once his place
 *      has days and hours, they win and the hint is gone.
 *   3. FOLLOW-UPS FIRST: a customer whose LATEST visit's next step is due inside the week being
 *      planned goes ahead of the normal order — still within the caps, in his own list, on a day he
 *      receives and never over his grade — and his row says "Follow-up due Tue 6 Oct".
 *
 * Real Phoenix visits are still 0 in production (2026-10-02), so all three are proven here on fixtures.
 * The rules reused rather than rewritten are pinned too: the weekday pattern is plan-pattern.ts's
 * `planWeekdays`, the follow-up is visit-outcome.ts's `pickLastNextStep`, and the reads sit in the
 * planners' existing wave.
 */

const CAPS = { amDailyCap: 5, pmDailyCap: 15 };
const TARGETS = { PM: { A: 3, B: 2, C: 1 }, AM: { A: 1, B: null, C: null } } as const;
const GRADE_TARGETS = TARGETS as unknown as SuggestInput["gradeTargets"];
const TODAY = "2026-10-02"; // a Friday
const WEEK_START = "2026-10-03"; // Saturday
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const MON = "2026-10-05";
const TUE = "2026-10-06";
const THU = "2026-10-08";
const FIELD_DAYS = [6, 0, 1, 2, 3, 4];

function timing(weekday: number, startMinute = 1080): PhoenixCrmTiming {
  return { weekday, startMinute, endMinute: startMinute + 120, season: "normal" };
}

function insightOf(partial: Partial<PlannerInsight>): PlannerInsight {
  return { lastSeenOn: null, usualWeekdays: null, followUpOn: null, ...partial };
}

function customer(
  customerId: string,
  listType: PhoenixCrmDoctorListType,
  options: {
    grade?: PhoenixCrmGrade | null;
    brick?: string | null;
    weekdays?: number[];
    pending?: boolean;
    visitsThisMonth?: number;
    insight?: PlannerInsight | null;
  } = {},
): PlannerCustomer {
  const places = options.pending
    ? []
    : [
        {
          placeId: `${customerId}-place`,
          label: null,
          address: null,
          lat: 0,
          lon: 0,
          brick: options.brick === undefined ? "D1" : options.brick,
          zone: null,
          timings: (options.weekdays ?? FIELD_DAYS).map((weekday) => timing(weekday)),
        },
      ];
  return {
    customerId,
    name: customerId,
    listType,
    grade: options.grade === undefined ? "C" : options.grade,
    speciality: null,
    visitsThisMonth: options.visitsThisMonth ?? 0,
    pending: options.pending ?? false,
    places,
    insight: options.insight === undefined ? null : options.insight,
  };
}

function day(date: string): DraftDay {
  return {
    date,
    listTypes: date === THU ? ["AM"] : ["AM", "PM"],
    ramadan: false,
    editable: true,
    activities: [],
    starts: { startAmMinute: null, startPmMinute: null },
    items: [],
  };
}

function week(): DraftWeek {
  return { weekStart: WEEK_START, plan: null, days: [SAT, SUN, MON, TUE, "2026-10-07", THU].map(day) };
}

function placed(date: string, customerId: string, placeId: string | null = `${customerId}-place`): PlanItemDraft {
  return { planDate: date, customerId, placeId, exceptionType: null, exceptionNote: null };
}

function input(customers: PlannerCustomer[], overrides: Partial<SuggestInput> = {}): SuggestInput {
  return {
    week: week(),
    items: [],
    activities: [],
    customers,
    caps: CAPS,
    gradeTargets: GRADE_TARGETS,
    placedThisMonth: new Map(),
    weeksLeft: 1,
    ...overrides,
  };
}

function ids(result: SuggestResult): string[] {
  return result.placements.map((placement) => placement.customerId);
}

function visit(customerId: string, visitDate: string, nextStep: string | null = null, nextStepOn: string | null = null, capturedAt = `${visitDate}T10:00:00Z`): LastNextStepRow {
  return { customerId, visitDate, capturedAt, nextStep, nextStepOn };
}

const read = (path: string) => stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));

/** A top-level function's text, from its declaration to the first column-0 closing brace. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must still exist`);
  const rest = text.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

export function runPhoenixCrmPlanInsightTests(): void {
  // ── 1. Last seen ───────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(laterDay("2026-09-29", "2026-08-14"), "2026-09-29");
    assert.equal(laterDay("2026-08-14", "2026-09-29"), "2026-09-29", "whichever side holds it");
    assert.equal(laterDay(null, "2026-08-14"), "2026-08-14");
    assert.equal(laterDay("not-a-day", undefined), null, "a malformed day is skipped, never compared as text");

    // 🔴 THE LATEST OF THE TWO HISTORIES — iReports360 while it is the newer, Phoenix once it is.
    const both = plannerInsightOf({ savedDays: false, phoenixLastOn: "2026-09-21", reference: { lastVisitedOn: "2026-09-29" }, followUpOn: null });
    assert.equal(both.lastSeenOn, "2026-09-29", "iReports360 saw him after Phoenix did: the iReports360 day is when he was last seen");
    const phoenixNewer = plannerInsightOf({ savedDays: true, phoenixLastOn: "2026-10-01", reference: { lastVisitedOn: "2026-09-29" }, followUpOn: null });
    assert.equal(phoenixNewer.lastSeenOn, "2026-10-01", "and the Phoenix day once Phoenix is the newer");
    assert.equal(
      plannerInsightOf({ savedDays: false, phoenixLastOn: null, reference: null, followUpOn: null }).lastSeenOn,
      null,
      "neither holds a visit: null, never a made-up day",
    );

    // The builder: the NEWEST Phoenix visit, whatever order the rows came in; a customer the rep added
    // himself has no reference contact and reads Phoenix alone.
    const built = buildPlannerInsights({
      customers: [
        { customerId: "carried", savedDays: false, referenceContactCrmId: 501 },
        { customerId: "added", savedDays: true, referenceContactCrmId: null },
        { customerId: "never", savedDays: false, referenceContactCrmId: 502 },
      ],
      visits: [visit("added", "2026-09-30"), visit("added", "2026-09-17"), visit("carried", "2026-09-10")],
      history: new Map([[501, { lastVisitedOn: "2026-09-24" }]]),
    });
    assert.equal(built.get("carried")?.lastSeenOn, "2026-09-24", "iReports360's 24 Sept beats Phoenix's 10 Sept");
    assert.equal(built.get("added")?.lastSeenOn, "2026-09-30", "the newest of his Phoenix visits, not the first row");
    assert.equal(built.get("never")?.lastSeenOn, null, "nothing in either: null");
    assert.equal(built.size, 3, "every customer on the list gets an insight once both reads answered");

    // ── The row's words ──
    const lastSept = insightOf({ lastSeenOn: "2026-09-29" });
    const context = { target: 3, today: TODAY, weekStart: WEEK_START };
    const validated = customer("validated", "PM", { grade: "A", visitsThisMonth: 1, insight: lastSept });
    const notValidated = customer("pending", "PM", { grade: "A", pending: true, visitsThisMonth: 1, insight: lastSept });
    assert.equal(
      plannerRowInsight(validated, context).lastSeen,
      "Last seen Tue 29 Sept · 1 of 3 visits this month",
      "a VALIDATED customer reads when he was last seen and how far through his month he is, in the module's one month sentence",
    );
    // 🔴 THE HEADLINE OF THE OWNER'S 2026-10-02 RULING: coverage counts validated customers only.
    assert.equal(
      plannerRowInsight(notValidated, context).lastSeen,
      "Last seen Tue 29 Sept",
      "a customer NOT validated yet reads the day alone — never a target he does not have",
    );
    assert.equal(
      plannerRowInsight(customer("am-b", "AM", { grade: "B", visitsThisMonth: 2, insight: lastSept }), { ...context, target: null }).lastSeen,
      "Last seen Tue 29 Sept · 2 visits this month",
      "a grade with no number reads his visits, never 'of null'",
    );
    assert.equal(
      plannerRowInsight(customer("unseen", "PM", { grade: "C", insight: insightOf({}) }), { ...context, target: 1 }).lastSeen,
      "No visit recorded · 0 of 1 visits this month",
      "read, and nothing found: it says so",
    );
    assert.equal(
      plannerRowInsight(customer("unread", "PM", { insight: null }), context).lastSeen,
      null,
      "the reads did not answer: the row says NOTHING — 'No visit recorded' would be a guess",
    );
    assert.equal(lastSeenText("2025-12-30", TODAY), "Last seen Tue 30 Dec 2025", "another year carries its year, so last winter never reads as this one");
    assert.equal(lastSeenText("2026-09-29", TODAY), "Last seen Tue 29 Sept");
  }

  // ── 2. iReports360's usual days, while he has none of his own ──────────────────────────────────
  {
    // The weekdays are read by planWeekdays (plan-pattern.ts) over visit days; the threshold is this
    // path's own: a weekday is usual only when he was seen on it on at least TWO different days.
    assert.equal(USUAL_DAY_MIN_VISITS, 2);
    assert.deepEqual(usualWeekdaysOf(["2026-09-08", "2026-09-15", "2026-09-13", "2026-09-27"]), [0, 2], "Sundays and Tuesdays, Sunday first");
    assert.deepEqual(usualWeekdaysOf(["2026-09-06", "2026-09-20", "2026-09-09"]), [0], "the one-off Wednesday is not a habit");
    assert.deepEqual(usualWeekdaysOf(["2026-09-12", "2026-09-19", "2026-09-08", "2026-09-22"]), [6, 2], "Saturday first — the field week's own order");
    assert.equal(usualWeekdaysOf([]), null, "no visit in the window: nothing is invented");
    // 🔴 THE THRESHOLD (coordinator, 2026-10-02): one visit is not "usually", and visits scattered one per
    // weekday are not a pattern — planWeekdays's fall-back to every day is the List's, never this path's.
    assert.equal(usualWeekdaysOf(["2026-09-09"]), null, "ONE visit is not 'usually': no hint, no preference");
    assert.equal(
      usualWeekdaysOf(["2026-09-05", "2026-09-13", "2026-09-21", "2026-09-29", "2026-09-16", "2026-09-24"]),
      null,
      "six visits on six different weekdays read NOTHING — never 'Usually seen Sat, Sun, Mon, Tue, Wed, Thu'",
    );
    assert.equal(usualWeekdaysOf(["2026-09-09", "2026-09-09"]), null, "the same day recorded twice is one visit, not two");

    assert.deepEqual(
      plannerInsightOf({ savedDays: false, phoenixLastOn: null, reference: { lastVisitedOn: "2026-09-27", days: ["2026-09-27", "2026-09-13"] }, followUpOn: null }).usualWeekdays,
      [0],
      "read off the days the read door handed back",
    );
    assert.equal(
      plannerInsightOf({ savedDays: true, phoenixLastOn: null, reference: { lastVisitedOn: "2026-09-27", days: ["2026-09-27", "2026-09-13"] }, followUpOn: null }).usualWeekdays,
      null,
      "a customer whose places carry days and hours is never read for them — his own days win",
    );
    assert.equal(placesHaveDays([{ timings: [] }]), false, "a place with no hours is not days and hours");
    assert.equal(placesHaveDays([{ timings: [] }, { timings: [timing(0)] }]), true);

    // On the board: the hint and the order read the same answer.
    const usualSun = customer("usual-sun", "PM", { pending: true, insight: insightOf({ usualWeekdays: [0] }) });
    assert.deepEqual(usualDaysOf(usualSun), [0]);
    assert.equal(usualDayRank(usualSun, 0), 0, "his usual day ranks first");
    assert.equal(usualDayRank(usualSun, 2), 2, "another day ranks last");
    assert.equal(usualDayRank(customer("nothing-known", "PM", { pending: true, insight: insightOf({}) }), 0), 1, "nothing known sits in between");
    const nowValidated = customer("validated-now", "PM", { weekdays: [1], insight: insightOf({ usualWeekdays: [0] }) });
    assert.equal(usualDaysOf(nowValidated), null, "🔴 once his place has real days and hours they win — an old pattern still on the wire is ignored");
    assert.equal(usualDayRank(nowValidated, 0), 1, "and it moves nothing in the order");

    assert.equal(usualDaysText([0, 2]), "Usually seen Sun, Tue (iReports360)", "the quiet hint, naming where it comes from");
    assert.equal(plannerRowInsight(usualSun, { target: null, today: TODAY, weekStart: WEEK_START }).usual, "Usually seen Sun (iReports360)");
    assert.equal(plannerRowInsight(nowValidated, { target: 1, today: TODAY, weekStart: WEEK_START }).usual, null, "and the hint is gone with them");

    // ── Suggest prefers his usual day — an ORDER, never a filter ──
    const usualTue = customer("a-usual-tue", "PM", { pending: true, insight: insightOf({ usualWeekdays: [2] }) });
    const unknown = customer("b-nothing-known", "PM", { pending: true, insight: insightOf({}) });
    const sunFirst = customer("c-usual-sun", "PM", { pending: true, insight: insightOf({ usualWeekdays: [0] }) });
    const three = [usualTue, unknown, sunFirst];
    const oneRoom = { caps: { amDailyCap: 5, pmDailyCap: 1 } };
    assert.deepEqual(
      ids(suggestDay({ ...input(three, oneRoom), date: SUN })),
      ["c-usual-sun"],
      "on a Sunday the customer iReports360 usually saw on Sundays takes the one place — whatever his name sorts as",
    );
    assert.deepEqual(ids(suggestDay({ ...input(three, oneRoom), date: TUE })), ["a-usual-tue"], "and on a Tuesday the Tuesday one");
    assert.deepEqual(
      ids(suggestDay({ ...input(three, { caps: { amDailyCap: 5, pmDailyCap: 2 } }), date: SUN })),
      ["c-usual-sun", "b-nothing-known"],
      "then the one nothing is known about, before the one usually seen on another day",
    );
    assert.deepEqual(
      ids(suggestDay({ ...input(three), date: SUN })).sort(),
      ["a-usual-tue", "b-nothing-known", "c-usual-sun"],
      "🔴 with room, EVERY one is offered — the usual days are an order, never a filter and never a refusal",
    );
    // A customer the day is KNOWN to suit still beats every customer with no days and hours (rule 6).
    assert.deepEqual(
      ids(suggestDay({ ...input([sunFirst, customer("z-receives", "PM")], oneRoom), date: SUN })),
      ["z-receives"],
      "his real hours still come before iReports360's habits",
    );

    // 🔴 The threshold reaches Suggest through the builder: a customer seen ONCE, on a Sunday, has no
    // usual day at all — so the weekday changes nothing about where he stands. Since the role walk
    // (2026-10-28) the one never seen goes first on every day: longest unseen first.
    const fromHistory = buildPlannerInsights({
      customers: [
        { customerId: "a-one-sunday-visit", savedDays: false, referenceContactCrmId: 701 },
        { customerId: "z-nothing-known", savedDays: false, referenceContactCrmId: 702 },
      ],
      visits: [],
      history: new Map([[701, { lastVisitedOn: "2026-09-27", days: ["2026-09-27"] }]]),
    });
    assert.equal(fromHistory.get("a-one-sunday-visit")?.usualWeekdays, null, "one Sunday visit in thirteen weeks: no usual day");
    const once = customer("a-one-sunday-visit", "PM", { pending: true, insight: fromHistory.get("a-one-sunday-visit") ?? null });
    const none = customer("z-nothing-known", "PM", { pending: true, insight: fromHistory.get("z-nothing-known") ?? null });
    assert.equal(plannerRowInsight(once, { target: null, today: TODAY, weekStart: WEEK_START }).usual, null, "so no hint on his row");
    const onMonday = ids(suggestDay({ ...input([once, none], oneRoom), date: MON }));
    assert.deepEqual(onMonday, ["z-nothing-known"], "the one never seen goes first: longest unseen first");
    assert.deepEqual(
      ids(suggestDay({ ...input([once, none], oneRoom), date: SUN })),
      onMonday,
      "and no order preference: his one Sunday visit does not put him first on a Sunday either",
    );

    // Across the week each lands on his own day (names sort the other way, so the order is the rule's).
    const spread = suggestWeek(
      input(
        [
          customer("a-usual-mon", "PM", { pending: true, insight: insightOf({ usualWeekdays: [1] }) }),
          customer("b-usual-sun", "PM", { pending: true, insight: insightOf({ usualWeekdays: [0] }) }),
          customer("c-usual-sat", "PM", { pending: true, insight: insightOf({ usualWeekdays: [6] }) }),
        ],
        oneRoom,
      ),
    );
    assert.deepEqual(
      spread.placements.map((placement) => `${placement.planDate} ${placement.customerId}`),
      [`${SAT} c-usual-sat`, `${SUN} b-usual-sun`, `${MON} a-usual-mon`],
      "Suggest the week puts each customer not validated yet on the weekday iReports360 usually saw him",
    );
  }

  // ── 3. Follow-ups first ────────────────────────────────────────────────────────────────────────
  {
    const dueTue = insightOf({ followUpOn: TUE });
    assert.equal(followUpInWeek({ insight: dueTue }, WEEK_START), TUE, "due Tuesday 6 Oct: inside the week of Saturday 3 Oct");
    assert.equal(followUpInWeek({ insight: insightOf({ followUpOn: "2026-10-09" }) }, WEEK_START), "2026-10-09", "a Friday belongs to the week before it — Phoenix's own week model");
    assert.equal(followUpInWeek({ insight: insightOf({ followUpOn: "2026-10-02" }) }, WEEK_START), null, "the Friday before the Saturday belongs to the week before");
    assert.equal(followUpInWeek({ insight: insightOf({ followUpOn: "2026-10-10" }) }, WEEK_START), null, "next Saturday opens the next week");
    assert.equal(followUpInWeek({ insight: null }, WEEK_START), null);

    // 🔴 THE LATEST VISIT'S next step — `pickLastNextStep`, the visit form's own rule, never a copy.
    const followed = buildPlannerInsights({
      customers: [
        { customerId: "due", savedDays: true, referenceContactCrmId: null },
        { customerId: "closed", savedDays: true, referenceContactCrmId: null },
        { customerId: "silent", savedDays: true, referenceContactCrmId: null },
        { customerId: "same-day", savedDays: true, referenceContactCrmId: null },
        { customerId: "no-date", savedDays: true, referenceContactCrmId: null },
      ],
      visits: [
        visit("due", "2026-09-22", "send_data", TUE),
        visit("closed", "2026-09-20", "follow_up", TUE),
        visit("closed", "2026-09-29", "none"),
        visit("silent", "2026-09-20", "follow_up", TUE),
        visit("silent", "2026-09-29"),
        visit("same-day", "2026-09-29", "follow_up", MON, "2026-09-29T09:00:00Z"),
        visit("same-day", "2026-09-29", "send_data", TUE, "2026-09-29T15:00:00Z"),
        visit("no-date", "2026-09-29", "follow_up"),
      ],
      history: new Map(),
    });
    assert.equal(followed.get("due")?.followUpOn, TUE, "his latest visit left a next step due on Tuesday");
    assert.equal(followed.get("closed")?.followUpOn, null, "a later 'Nothing to follow' closes the older one");
    assert.equal(followed.get("silent")?.followUpOn, null, "and a later visit with no next step is the newest answer too — never the visit before it");
    assert.equal(followed.get("same-day")?.followUpOn, TUE, "two on one day: the one captured last");
    assert.equal(followed.get("no-date")?.followUpOn, null, "a next step with no date has no day to be due on");

    assert.equal(followUpText(TUE), "Follow-up due Tue 6 Oct");
    const row = (followUpOn: string) => plannerRowInsight(customer("f", "PM", { insight: insightOf({ followUpOn }) }), { target: 1, today: TODAY, weekStart: WEEK_START }).followUp;
    assert.equal(row(TUE), "Follow-up due Tue 6 Oct", "his row says it in the week it is due");
    assert.equal(row("2026-10-13"), null, "and not in a week it is not");

    // ── Suggest: ahead of the normal order ──
    const bigBrick = ["b1", "b2", "b3"].map((id) => customer(id, "PM", { brick: "Haram" }));
    const followUp = customer("z-follow-up", "PM", { brick: "Dokki", insight: dueTue });
    const oneRoom = { caps: { amDailyCap: 5, pmDailyCap: 1 } };
    // 🔴 THE HEADLINE: one place left, and his commitment takes it over the brick with the most candidates.
    assert.deepEqual(ids(suggestDay({ ...input([...bigBrick, followUp], oneRoom), date: SAT })), ["z-follow-up"], "a follow-up due this week goes FIRST, ahead of the bricks and the names");
    assert.deepEqual(
      ids(suggestDay({ ...input([...bigBrick, followUp], { caps: { amDailyCap: 5, pmDailyCap: 2 } }), date: SAT })),
      ["z-follow-up", "b1"],
      "and the rest of the day keeps its normal order behind him",
    );
    assert.deepEqual(
      ids(suggestDay({ ...input([customer("a-receives", "PM"), customer("z-not-validated", "PM", { pending: true, insight: dueTue })], oneRoom), date: SAT })),
      ["z-not-validated"],
      "a customer not validated yet with a follow-up due goes ahead of one the day is known to suit",
    );
    assert.deepEqual(
      ids(
        suggestDay({
          ...input([customer("later", "PM", { insight: insightOf({ followUpOn: "2026-10-07" }) }), customer("sooner", "PM", { insight: insightOf({ followUpOn: MON }) })], oneRoom),
          date: SAT,
        }),
      ),
      ["sooner"],
      "two due: the earliest first",
    );
    assert.deepEqual(
      ids(suggestDay({ ...input([...bigBrick, customer("z-next-week", "PM", { brick: "Dokki", insight: insightOf({ followUpOn: "2026-10-13" }) })], oneRoom), date: SAT })),
      ["b1"],
      "due next week: the normal order",
    );

    // Still every rule a suggestion keeps.
    assert.deepEqual(
      ids(suggestDay({ ...input([followUp], { items: [placed(SAT, "b1")], customers: [...bigBrick, followUp], caps: { amDailyCap: 5, pmDailyCap: 1 } }), date: SAT })),
      [],
      "within the day's caps: a full PM list takes nobody, follow-up or not",
    );
    assert.deepEqual(ids(suggestDay({ ...input([followUp]), date: THU })), [], "in his own list: Thursday is a morning, and a PM follow-up is never put on it");
    assert.deepEqual(
      ids(suggestDay({ ...input([customer("off-saturday", "PM", { weekdays: [1], insight: dueTue })]), date: SAT })),
      [],
      "on a day he receives: a validated customer off that day still needs the rep's own tick",
    );
    assert.deepEqual(
      ids(suggestDay({ ...input([...bigBrick, followUp], { ...oneRoom, placedThisMonth: new Map([["z-follow-up", 1]]) }), date: SAT })),
      ["b1"],
      "never over his grade: a grade-C customer already placed this month is not proposed — the rep may tick him himself",
    );
    // Grade A owes three this month, so he is still a candidate once on the week — only as a repeat.
    const followUpGradeA = customer("z-follow-up-a", "PM", { grade: "A", brick: "Dokki", insight: dueTue });
    assert.deepEqual(
      ids(
        suggestDay({
          ...input([...bigBrick, followUpGradeA], { ...oneRoom, items: [placed(MON, "z-follow-up-a")], placedThisMonth: new Map([["z-follow-up-a", 1]]) }),
          date: SAT,
        }),
      ),
      ["b1"],
      "once he is on the week the follow-up is planned: he is not pushed ahead onto a second day for it",
    );
    const weekWithFollowUp = suggestWeek(input([...bigBrick, followUp], oneRoom));
    assert.equal(weekWithFollowUp.placements[0]?.customerId, "z-follow-up", "Suggest the week places him on the first day it fills");
    assert.equal(weekWithFollowUp.placements.filter((placement) => placement.customerId === "z-follow-up").length, 1, "once");
  }

  // ── The reads: in the planners' existing wave, never a wave of their own ────────────────────────
  {
    assert.equal(USUAL_DAYS_WINDOW_DAYS, 91, "thirteen whole weeks — every weekday gets the same number of chances");
    assert.equal(LAST_SEEN_WINDOW_DAYS % 7, 0, "and the Phoenix window is whole weeks too");

    for (const [path, declaration] of [
      ["src/lib/phoenix-crm/server/plans.ts", "export async function loadPlanner("],
      ["src/lib/phoenix-crm/server/monthly-plans.ts", "export async function loadMonthlyPlanner("],
    ] as const) {
      const planner = functionBody(read(path), declaration);
      const waveAt = planner.indexOf("const wave = Promise.all([");
      const insightAt = planner.indexOf("loadPlannerInsights(seat.seatId, isTest, today, customersRead)");
      assert.ok(insightAt > waveAt && waveAt >= 0, `${declaration} reads the insights INSIDE its one wave`);
      assert.ok(insightAt < planner.indexOf("await ensured;"), `${declaration} starts them before the mint is awaited`);
      assert.match(
        planner,
        /canWriteAsRep\(viewer, seat, isTest\) \? loadPlannerInsights\(seat\.seatId, isTest, today, customersRead\) : Promise\.resolve\(new Map<string, PlannerInsight>\(\)\),/,
        `${declaration} reads them for the rep alone — a reviewer's board never ticks, so it pays for none`,
      );
      // Taken from the same wave — the day-off rule's leave days now sit beside them.
      assert.match(planner, /\n\s*insights,\n(?:\s*\w+,\n)*\s*\] = await wave;/, `${declaration} takes them from the wave`);
      assert.match(planner, /insight: insights\.get\(customerId\) \?\? null,/, `${declaration} hands each customer his own, or none`);
    }

    const server = read("src/lib/phoenix-crm/server/plan-insight.ts");
    const loader = functionBody(server, "export async function loadPlannerInsights(");
    assert.ok(
      loader.indexOf('.from("phoenix_crm_visits")') >= 0 && loader.indexOf('.from("phoenix_crm_visits")') < loader.indexOf("await customersRead"),
      "the Phoenix visits are asked for BEFORE the customer list is awaited — they name no customer minted a moment ago",
    );
    assert.match(loader, /\.select\("id, customer_id, visit_date, captured_at, next_step, next_step_on"\)/, "one read serves last seen and the follow-up");
    assert.match(loader, /\.gte\("visit_date", addDaysIso\(today, -LAST_SEEN_WINDOW_DAYS\)\)/, "within its window");
    assert.match(loader, /\.eq\("is_test", isTest\)/, "and never across the test world's line");
    assert.match(loader, /visitsRead\.catch\(\(\) => undefined\);/, "a read started early is handled the moment it starts");
    assert.match(
      loader,
      /options\.visitsRead\.then\(\(rows\) => rows\.filter\(\(row\) => String\(row\.visit_date \?\? ""\) >= lastSeenSince\)\)/,
      "rows a caller hands over (call prep) are cut back to this read's own window",
    );
    assert.match(loader, /const lastSeenSince = addDaysIso\(today, -LAST_SEEN_WINDOW_DAYS\);/, "the same window");
    assert.match(
      loader,
      /loadVisitHistoryFor\(contactIds, \{ daysSince: addDaysIso\(today, -USUAL_DAYS_WINDOW_DAYS\) \}\)/,
      "iReports360 is read through the List's own door, the same read, asked for the recent days too",
    );
    assert.match(loader, /logError\([\s\S]*?return new Map\(\);/, "🔴 a failed read is logged and answers NO insight — never a half-read one");
    assert.match(read("src/lib/phoenix-crm/plan-insight.ts"), /import \{ planWeekdays \} from "@\/lib\/phoenix-crm\/plan-pattern";/, "the usual days are planWeekdays's rule, not a second one");
    assert.match(read("src/lib/phoenix-crm/plan-insight.ts"), /pickLastNextStep\(input\.visits\)/, "the follow-up is pickLastNextStep's rule, not a second one");

    const door = functionBody(read("src/lib/crm/reads.ts"), "export async function readContactVisitHistory(");
    assert.match(door, /options: \{ daysSince\?: string \} = \{\}/, "the read door takes the window as an option");
    // Since 2026-10-16 the door counts in the database (phx_crm_contact_visit_history) and keeps the page
    // walk only for a database the function has not reached; both hand back days only when asked.
    assert.match(door, /return await readContactVisitHistoryCounted\(ids, daysSince\);/, "the door asks the database for the counts");
    assert.match(door, /return readContactVisitHistoryPaged\(ids, daysSince\);/, "and walks the pages only when the function is missing");
    const counted = functionBody(read("src/lib/crm/reads.ts"), "async function readContactVisitHistoryCounted(");
    assert.match(counted, /p_days_since: daysSince/, "the window travels to the database as it is");
    assert.match(
      counted,
      /if \(daysSince !== null && Array\.isArray\(row\.days\) && row\.days\.length > 0\) found\.days = row\.days;/,
      "and days come back only when asked, never as an empty list",
    );
    assert.match(
      functionBody(read("src/lib/crm/reads.ts"), "async function readContactVisitHistoryPaged("),
      /if \(daysSince !== null && row\.visit_date && row\.visit_date >= daysSince\) \(found\.days \?\?= \[\]\)\.push\(row\.visit_date\);/,
      "and the page walk the same",
    );
    const historySql = stripSqlComments(
      readFileSync("supabase/migrations/20261016180202_crm_contact_history_and_plan_dates_counted_in_sql.sql", "utf8").replace(/\r\n/g, "\n"),
    );
    assert.match(
      historySql,
      /when p_days_since is null then null\s+else array_agg\(v\.visit_date order by v\.visit_date desc\) filter \(where v\.visit_date >= p_days_since\)/,
      "the database hands back the days on or after the window, newest first, and none when not asked",
    );
    assert.match(read("src/lib/phoenix-crm/server/list.ts"), /loadVisitHistoryFor\(sharedKeys\),/, "the List asks for none, so its answer to the phone is unchanged");
  }

  // ── The screens ────────────────────────────────────────────────────────────────────────────────
  {
    const panel = read("src/components/phoenix-crm/plan-day-panel.tsx");
    assert.match(
      panel,
      /const insight = plannerRowInsight\(customer, \{ target: gradeTarget\(\{ gradeTargets \}, customer\.listType, customer\.grade\), today, weekStart \}\);/,
      "each row reads its words from the one helper, against the grade's own number",
    );
    assert.match(panel, /const weekStart = fieldWeekStart\(day\.date\);/, "the week a follow-up must fall in is the day's own field week");
    assert.equal((panel.match(/<SeenLine lastSeen=\{row\.lastSeen\} \/>/g) ?? []).length, 2, "last seen on the phone's card AND the desktop's row");
    assert.equal((panel.match(/<UsualLine usual=\{row\.usual\} \/>/g) ?? []).length, 2, "the usual days on both too");
    assert.match(panel, /\{row\.followUp \? <CrmPill tone="info">\{row\.followUp\}<\/CrmPill> : null\}/, "the follow-up as a pill on both, through RowPills");
    for (const banned of [/\btruncate\b/, /\bline-clamp-/, /\boverflow-x-auto\b/, /\brounded-(?!none\b)/]) {
      assert.doesNotMatch(panel, banned, "the module's look: no ellipsis, no sideways scroll, no rounded corner");
    }
    assert.match(read("src/components/phoenix-crm/plan-week-panel.tsx"), /gradeTargets=\{gradeTargets\}/, "the week panel hands the day the grade numbers");
    assert.match(read("src/components/phoenix-crm/plan-board.tsx"), /gradeTargets=\{view\.rules\.gradeTargets\}/, "from the Settings the planner already carries");

    // The words a rep reads: customer, never doctor; nothing that judges him.
    for (const words of [lastSeenText("2026-09-29", TODAY), lastSeenText(null, TODAY), usualDaysText([0, 2]), followUpText(TUE)]) {
      assert.doesNotMatch(words, /\b(doctor|account|flag|late|missed|behind)\b/i, `"${words}" — his own history, said plainly`);
    }
  }

  console.log("phoenix-crm plan insight: OK");
}
