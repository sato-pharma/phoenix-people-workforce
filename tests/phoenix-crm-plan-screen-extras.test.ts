import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { withSavedBoards } from "../src/lib/phoenix-crm/plan-board-answer.ts";
import { buildWeekCopyPlacements } from "../src/lib/phoenix-crm/plan-copy.ts";
import { dayOffPhrase, planDayOff, resolvePlanItems, type PlanItemDraft, type PlanRuleCustomer } from "../src/lib/phoenix-crm/plan-rules.ts";
import { suggestWeek, type SuggestInput } from "../src/lib/phoenix-crm/plan-suggest.ts";
import {
  buildWeekSavePayload,
  canSaveItself,
  copyWeekOf,
  dayOffOf,
  draftFits,
  emptyDayText,
  emptyPlanDays,
  firstDayToPlan,
  indexCustomers,
  isWeekDirty,
  markWeekSaved,
  placeCustomer,
  PLAN_AUTOSAVE_DELAY_MS,
  saveStatusLine,
  selfSaveKey,
  setPlannedActivity,
  settleSavedDraft,
  startDraft,
  weekProblems,
  weekScope,
  type DraftDay,
  type DraftWeek,
  type WeekDraft,
} from "../src/lib/phoenix-crm/plan-week-draft.ts";
import type { PlannerCustomer } from "../src/lib/phoenix-crm/suggestions.ts";
import type { PhoenixCrmDoctorListType, PhoenixCrmTiming } from "../src/lib/phoenix-crm/types.ts";
import { spreadApprovedLeave } from "../src/lib/vacation/approved-leave-days.ts";

/**
 * Phoenix CRM — three things on the rep's weekly plan screen (owner, 2026-10-02).
 *
 *   1. APPROVED LEAVE IS A DAY OFF. A full day HR approved for the rep reads on his plan exactly like a
 *      public holiday — "Day off · Annual Vacation", greyed, empty `listTypes` so Suggest and every copy
 *      skip it, never the day the board opens on, stepped over by "Next day", and a save naming it is
 *      refused with a sentence. One day-off path carries both (`planDayOff`). A half day (AM only / PM
 *      only) is NOT a day off, and a leave read that fails leaves the day plannable.
 *   2. THE EMPTY DAYS ARE NAMED AT SEND. On 1 October 15 working days went out empty across 14 sent
 *      weeks. Step 4 and the Send confirmation now say "Tuesday 6 Oct has no customers and no activity."
 *      for each such day — a note he can read and still press Send past, never a refusal.
 *   3. THE REP'S BOARD SAVES ITSELF. On 1 October one rep pressed Save 16 times, several 9 or 10. His
 *      board now saves about 1.5 seconds after his last change, through the very save the button used;
 *      the button and its "Unsaved changes" bar give way to one line — Saving…, Saved, Not saved — and
 *      the leave guard asks only about work that cannot save itself. Managers keep their Save button.
 *
 * The rules are driven with values; the wiring is pinned in the source, comments stripped.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/**
 * The body of one function in a source file: from its declaration to its own closing brace — the first
 * line holding only `}` at the declaration's own indentation (everything inside sits deeper).
 */
function bodyOf(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is in the file`);
  const indent = /^ */.exec(text.slice(text.lastIndexOf("\n", start) + 1, start))?.[0] ?? "";
  const close = text.slice(start).search(new RegExp(`\\n${indent}\\}(?:\\r?\\n|$)`));
  assert.ok(close > 0, `${declaration} closes`);
  return text.slice(start, start + close + indent.length + 2);
}

const CAPS = { amDailyCap: 5, pmDailyCap: 15, sharedPlaceDailyCap: 3 };
// The week of Saturday 3 October 2026 — the Delta reps' first Phoenix week.
const WEEK = "2026-10-03";
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const MON = "2026-10-05";
const TUE = "2026-10-06";
const WED = "2026-10-07";
const THU = "2026-10-08";
const FIELD_DAYS = [6, 0, 1, 2, 3, 4];

function timing(weekday: number, startMinute = 1080): PhoenixCrmTiming {
  return { weekday, startMinute, endMinute: startMinute + 120, season: "normal" };
}

/** A validated customer who receives on every field day. */
function customer(customerId: string, listType: PhoenixCrmDoctorListType): PlannerCustomer {
  return {
    customerId,
    name: customerId,
    listType,
    grade: "C",
    speciality: null,
    visitsThisMonth: 0,
    pending: false,
    places: [
      {
        placeId: `${customerId}-place`,
        label: null,
        address: null,
        lat: 0,
        lon: 0,
        brick: "D1",
        zone: null,
        timings: FIELD_DAYS.map((weekday) => timing(weekday)),
      },
    ],
  };
}

function day(date: string, overrides: Partial<DraftDay> = {}): DraftDay {
  return {
    date,
    listTypes: date === THU ? ["AM"] : ["AM", "PM"],
    ramadan: false,
    editable: true,
    activities: [],
    starts: { startAmMinute: null, startPmMinute: null },
    items: [],
    ...overrides,
  };
}

/** A day off as the server sends it: no list, and its name. */
function dayOff(date: string, kind: "holiday" | "leave", name: string, overrides: Partial<DraftDay> = {}): DraftDay {
  return day(date, { listTypes: [], dayOff: { kind, name }, holiday: kind === "holiday" ? name : null, ...overrides });
}

function placed(planDate: string, customerId: string): PlanItemDraft {
  return { planDate, customerId, placeId: `${customerId}-place`, exceptionType: null, exceptionNote: null };
}

function savedItem(customerId: string, listType: PhoenixCrmDoctorListType) {
  return { customerId, placeId: `${customerId}-place`, listType, name: customerId, exceptionType: null, exceptionNote: null };
}

export function runPhoenixCrmPlanScreenExtrasTests(): void {
  // ── 1. Approved leave is a day off ─────────────────────────────────────────────────────────────
  {
    // HR's rows, spread over the window: the leave's own name, and whether it took the whole day.
    const away = spreadApprovedLeave(
      [
        { employee_hr_id: "PD-0013", start_date: "2026-10-05", end_date: "2026-10-07", vacation_type: "annual", day_part: "full_day" },
        { employee_hr_id: "PD-0013", start_date: "2026-10-08", end_date: "2026-10-08", vacation_type: "emergency", day_part: "am_only" },
        { employee_hr_id: "PD-0013", start_date: "2026-09-28", end_date: "2026-10-03", vacation_type: "sick", day_part: null },
        { employee_hr_id: "PD-0013", start_date: "2026-10-04", end_date: "2026-10-04", vacation_type: "personal", day_part: "full_day" },
      ],
      { from: SAT, to: THU },
    );
    const byDay = new Map(away.map((row) => [row.day, row]));
    assert.deepEqual([...byDay.keys()].sort(), [SAT, SUN, MON, TUE, WED, THU], "every covered day inside the window, and none outside it");
    assert.deepEqual(byDay.get(TUE), { day: TUE, hrId: "PD-0013", typeLabel: "Annual Vacation", fullDay: true }, "the leave's own name, never the stored key");
    assert.equal(byDay.get(THU)?.fullDay, false, "an AM-only request leaves the other half of the day at work — it is not a day off");
    assert.equal(byDay.get(THU)?.typeLabel, "Emergency Vacation");
    assert.equal(byDay.get(SAT)?.fullDay, true, "a row with no day part is a full day, the vacation module's own default");
    assert.equal(byDay.get(SUN)?.typeLabel, "Other", "an old 'personal' request reads as the module names it today");

    // One day-off path: the holiday first, then his own leave.
    const holidays = new Map([[THU, "Armed Forces Day"]]);
    const leave = new Map([
      [TUE, "Annual Vacation"],
      [THU, "Annual Vacation"],
    ]);
    assert.deepEqual(planDayOff(TUE, holidays, leave), { kind: "leave", name: "Annual Vacation" });
    assert.deepEqual(planDayOff(THU, holidays, leave), { kind: "holiday", name: "Armed Forces Day" }, "a public holiday is everybody's day off, so it wins");
    assert.equal(planDayOff(WED, holidays, leave), null, "a working day is no day off");
    assert.equal(planDayOff(TUE), null, "and with nothing read, no day is one — the day stays plannable");
    assert.equal(dayOffPhrase({ kind: "leave", name: "Annual Vacation" }), "a day off on approved leave (Annual Vacation)");
    assert.equal(dayOffPhrase({ kind: "holiday", name: "Armed Forces Day" }), "a public holiday (Armed Forces Day)");

    // 🔴 A save naming the day is refused, in a sentence — and the holiday's own sentence is unchanged.
    const hany: PlanRuleCustomer = { customerId: "C-1", name: "Dr Hany", listType: "AM", pending: true, places: [] };
    const rule = (planDate: string) =>
      resolvePlanItems({
        weekStart: WEEK,
        items: [{ customerId: "C-1", placeId: null, planDate, exceptionType: null, exceptionNote: null }],
        customers: new Map([["C-1", hany]]),
        settings: CAPS,
        isRamadan: () => false,
        holidays,
        leave,
      });
    const refused = rule(TUE);
    assert.equal(refused.ok, false, "a save naming a day of his approved leave is refused");
    assert.equal(!refused.ok && refused.error, "Tuesday 6 Oct is a day off on approved leave (Annual Vacation). Take Dr Hany off it.");
    const holiday = rule(THU);
    assert.equal(!holiday.ok && holiday.error, "Thursday 8 Oct is a public holiday (Armed Forces Day). Take Dr Hany off it.");
    assert.equal(rule(WED).ok, true, "the day after his leave is a working day");

    // On the board: the problem the save would meet is named before it leaves, as a leave.
    const customers = [customer("pm-1", "PM"), customer("pm-2", "PM"), customer("am-1", "AM")];
    const byId = indexCustomers(customers);
    const week: DraftWeek = {
      weekStart: WEEK,
      plan: null,
      days: [day(SAT, { editable: false }), dayOff(SUN, "leave", "Annual Vacation"), day(MON), dayOff(TUE, "leave", "Annual Vacation"), day(WED), dayOff(THU, "holiday", "Armed Forces Day")],
    };
    const problems = weekProblems(week, [placed(TUE, "pm-1"), placed(THU, "am-1"), placed(MON, "pm-2")], byId, CAPS);
    assert.deepEqual(
      problems.map((problem) => (problem.kind === "leave" ? `${problem.kind}:${problem.leave}` : problem.kind === "holiday" ? `${problem.kind}:${problem.holiday}` : problem.kind)),
      ["leave:Annual Vacation", "holiday:Armed Forces Day"],
      "a customer left on a leave day is named as leave, one on the holiday as the holiday, and a working day is no problem",
    );
    assert.deepEqual(dayOffOf(week.days[3]), { kind: "leave", name: "Annual Vacation" });
    assert.deepEqual(dayOffOf({ holiday: "Armed Forces Day" }), { kind: "holiday", name: "Armed Forces Day" }, "a day read before dayOff existed still names its holiday");
    assert.equal(firstDayToPlan(week.days)?.date, MON, "the board never opens on a day off — the passed Saturday and Sunday's leave are stepped over");

    // Suggest and every copy skip the day, because it holds no list.
    const copied = buildWeekCopyPlacements(
      [{ planDate: "2026-09-29", customerId: "pm-1" }, { planDate: "2026-09-28", customerId: "pm-2" }],
      customers,
      copyWeekOf(week, [], byId),
      CAPS,
    );
    assert.deepEqual(copied.map((item) => `${item.planDate}|${item.customerId}`), [`${MON}|pm-2`], "Copy last week lands nobody on a day off");
    const suggested = suggestWeek({
      week,
      items: [],
      activities: [],
      customers: Array.from({ length: 20 }, (_, index) => customer(`pm-${index}`, "PM")),
      caps: CAPS,
      gradeTargets: { PM: { A: 3, B: 2, C: 1 }, AM: { A: 1, B: null, C: null } } as unknown as SuggestInput["gradeTargets"],
      placedThisMonth: new Map(),
      weeksLeft: 1,
    });
    assert.ok(suggested.placements.length > 0, "the week is suggested");
    assert.deepEqual(
      [...new Set(suggested.placements.map((item) => item.planDate))].sort(),
      [MON, WED],
      "on its working days only — never a day of his leave, never the holiday",
    );

    // The wiring: HR's one reader, full days only, never a thrown read.
    const reader = source("src/lib/phoenix-crm/server/leave-days.ts");
    // The rule lives in the MANY-territory reader since 2026-10-02 — the plan reminder asks it of every
    // rep whose week is not sent, and one query each was one query per seat twice a day. One seat is
    // the same question, so `loadSeatDaysOff` delegates rather than keeping a second copy.
    const daysOff = bodyOf(reader, "export async function loadSeatsDaysOff(");
    assert.match(daysOff, /await loadApprovedLeaveDays\(seatsByHrId\.keys\(\), range\)/, "the same reader as the reports' on-leave — never a second copy of the leave rule");
    assert.match(daysOff, /if \(!row\.fullDay\) continue;/, "a half day is not a day off");
    assert.match(daysOff, /\} catch \(error\) \{\s*logError\(/, "a leave read that fails is logged…");
    assert.match(daysOff, /return out;\s*\}$/, "…and still answers, so the day stays plannable and the board never breaks");
    assert.match(
      bodyOf(reader, "export async function loadSeatDaysOff("),
      /return \(await loadSeatsDaysOff\(\[seat\], range\)\)\.get\(seat\.seatId\)/,
      "and one territory asks the same reader, never its own copy of the rule",
    );
    assert.doesNotMatch(reader, /\.from\(/, "the CRM reads no HR table itself");
    const vacation = source("src/lib/vacation/approved-leave-days.ts");
    assert.match(vacation, /\.select\("employee_hr_id, start_date, end_date, vacation_type, day_part"\)/, "the type and the day part are read with the days");

    const plans = source("src/lib/phoenix-crm/server/plans.ts");
    assert.equal(
      (plans.match(/loadSeatDaysOff\(seat, \{ from: weekStart, to: addDaysIso\(weekStart, 5\) \}\),/g) ?? []).length,
      2,
      "the week planner and the save both read the week's leave",
    );
    assert.ok(plans.includes("const dayOff = planDayOff(date, input.holidays, input.leave);"), "the day builder knows a day off of either kind");
    assert.ok(plans.includes("listTypes: dayOff ? [] : planDayListTypes(date),"), "and a day off holds no list");
    // `sharedPlaces` joined the same call on 2026-10-09 (three visits a day inside one polyclinic), so
    // the fingerprint names that line instead of demanding `leave,` be the last one — what it pins is
    // unchanged: the SAVE check, not only the week builder, is handed the week's leave. `liftedVenues`
    // joined it on 2026-10-31 (four hospitals with no venue cap), so it may follow that line, and `venueCaps`
    // after it on 2026-11-02 (the Super Admin's Polyclinic Caps page).
    assert.match(
      plans,
      /holidays,\s*leave,\s*sharedPlaces: planVenues,\s*(?:liftedVenues,\s*)?(?:venueCaps,\s*)?\}\);\s*if \(!resolved\.ok\) throw validationError\(resolved\.error\);/,
      "the save check is handed his leave",
    );
    const month = source("src/lib/phoenix-crm/server/monthly-plans.ts");
    assert.ok(
      month.includes("loadSeatDaysOff(seat, { from: addDaysIso(monthStart, -14), to: addDaysIso(monthEndOf(monthStart), 14) }),"),
      "the month board reads his leave in its first wave, over the same days as the holidays",
    );
    assert.ok(month.includes("isRamadan, activities, starts, holidays, leave, pendingLeave });"), "and every week of it is built with it, with the leave he has only asked for");

    const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.ok(panel.includes("const off = dayOffOf(day);"), "the day picker reads one day off");
    assert.ok(panel.includes("note: off.kind === \"leave\" ? `${off.name} · approved` : `Day off · ${off.name}`,"), "and names it — \"Annual Vacation · approved\", or \"Day off · Armed Forces Day\"");
    assert.ok(panel.includes("disabled: counts.AM + counts.PM === 0,"), "greyed, unless something is still on it to take off");
    const dayPanel = source("src/components/phoenix-crm/plan-day-panel.tsx");
    assert.ok(dayPanel.includes("const morning = !off && !day.listTypes.includes(\"PM\");"), "a day off is never read as a Thursday morning");
    assert.ok(dayPanel.includes("{off ? `${dayName} is ${dayOffPhrase(off)}. Take these off it.`"), "and a customer still on it is told to come off");
    const board = source("src/components/phoenix-crm/plan-board.tsx");
    assert.ok(board.includes(".find((entry) => entry.listTypes.length > 0)"), "\"Next day\" steps over a day off");
  }

  // ── 2. The empty days are named at Send ────────────────────────────────────────────────────────
  {
    const customers = [customer("pm-1", "PM"), customer("pm-2", "PM")];
    const byId = indexCustomers(customers);
    const week: DraftWeek = {
      weekStart: WEEK,
      plan: { planId: "plan-1", version: 2 },
      days: [
        day(SAT, { editable: false }), // passed, and empty: what was saved stands, and it is not his to fill
        dayOff(SUN, "leave", "Annual Vacation"), // his leave: no list, never named
        day(MON),
        day(TUE), // empty in the draft
        day(WED, { items: [savedItem("pm-2", "PM")] }), // saved with a customer, who the draft took off — an activity is left
        dayOff(THU, "holiday", "Armed Forces Day"),
      ],
    };
    const items = [placed(MON, "pm-1")];
    const activities = setPlannedActivity([], WED, "meeting", { halfDay: false, note: null });
    assert.deepEqual(emptyPlanDays(week, items, activities, byId), [TUE], "only a working day still his, holding a list, with nothing in the draft");
    assert.equal(emptyDayText(TUE), "Tuesday 6 Oct has no customers and no activity.", "said in the owner's words");
    assert.deepEqual(emptyPlanDays(week, [], activities, byId), [MON, TUE], "read from the draft on screen, not from what was saved");
    assert.deepEqual(emptyPlanDays(week, items, [], byId), [TUE, WED], "a day the draft emptied is named even though the saved week had a customer on it");
    assert.deepEqual(emptyPlanDays(week, [...items, placed(TUE, "left-the-list")], activities, byId), [TUE], "a customer who left the list fills no day");

    const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.ok(panel.includes("const emptyDays = editable ? emptyPlanDays(week, items, activities, byId) : [];"), "the panel reads the empty days off the draft");
    assert.match(
      panel,
      /it is sent, changing it needs your manager and SFE\.\s*<\/p>\s*<EmptyDaysNote dates=\{emptyDays\} \/>/,
      "the Send confirmation names them, before its buttons",
    );
    assert.ok(panel.includes('{placed > 0 ? <EmptyDaysNote className="mt-3" dates={emptyDays} /> : null}'), "and so does step 4 under Send this week");
    // 🔴 Never a refusal: neither Send button reads the empty days.
    assert.ok(panel.includes("disabled={locked || placed === 0}"), "Send this week is off only when nothing at all is placed");
    assert.ok(panel.includes('disabled={locked || problems.length > 0 || hold === "changed"}'), "and Send only on what the server would refuse");
    assert.doesNotMatch(panel, /disabled=\{[^}]*emptyDays/, "an empty day never greys either button");
    const note = bodyOf(panel, "function EmptyDaysNote(");
    assert.match(note, /Plan them, or send the week as it is\./, "the note says he may still send");
  }

  // ── 3. The rep's board saves itself ────────────────────────────────────────────────────────────
  {
    assert.equal(PLAN_AUTOSAVE_DELAY_MS, 1500, "about 1.5 seconds after his last change");

    // Which week may save itself: his, changed, and nothing the server would refuse.
    const ready = { editable: true, dirty: true, hold: null, problems: [] as unknown[] };
    assert.equal(canSaveItself(ready), true);
    assert.equal(canSaveItself({ ...ready, hold: "unchecked" }), true, "a save whose answer was lost is tried again once he changes something");
    assert.equal(canSaveItself({ ...ready, hold: "changed" }), false, "a week changed underneath him waits for his choice");
    assert.equal(canSaveItself({ ...ready, problems: [{ kind: "cap" }] }), false, "a week the server would refuse waits for his fix");
    assert.equal(canSaveItself({ ...ready, dirty: false }), false, "nothing changed, nothing saved");
    assert.equal(canSaveItself({ ...ready, editable: false }), false, "a week not his to change never saves");

    // The week of 3 October at version 4: Monday holds a customer who has since left the list.
    const customers = [customer("pm-1", "PM"), customer("pm-2", "PM"), customer("pm-3", "PM")];
    const week: DraftWeek = {
      weekStart: WEEK,
      plan: { planId: "plan-1", version: 4 },
      days: [day(SAT, { editable: false }), day(SUN), day(MON, { items: [savedItem("left-the-list", "PM")] }), day(TUE), day(WED), day(THU)],
    };
    const scope = weekScope("SEAT-PEDIA-REP-D11", false, WEEK);
    const typed = setPlannedActivity([], WED, "meeting", { halfDay: true, note: "Meet the DM " });
    const ticked: WeekDraft = { ...startDraft(scope, week), activities: typed, items: placeCustomer(startDraft(scope, week).items, placed(TUE, "pm-1")) };
    assert.equal(isWeekDirty(ticked, week), true, "a tick is a change");

    // What the save sends, and the version it made.
    const sent = buildWeekSavePayload({ seatId: "SEAT-PEDIA-REP-D11", test: false, week, draft: ticked, customers });
    assert.equal(sent.expectedVersion, 4, "the same save the button sent — over the version on screen");
    const made = { planId: "plan-1", version: 5 };

    // (a) Nothing changed while it travelled: nothing is left to save, so it never saves in a loop.
    const quiet = settleSavedDraft({ current: ticked, week, saved: made, sent, customers });
    assert.equal(isWeekDirty(quiet, week), false, "what was just saved never reads as a change — no save every 1.5 seconds");
    assert.deepEqual(quiet.items.map((item) => `${item.planDate}|${item.customerId}`), [`${TUE}|pm-1`], "the customer who left the list is gone with the save");
    assert.equal(quiet.activities[0]?.note, "Meet the DM ", "his note stays exactly as typed — a pause after a space never eats the space");
    assert.equal(markWeekSaved(scope, week, made, sent).activities[0]?.note, "Meet the DM", "which is what putting back the sent copy would have done under his cursor");

    // (b) He ticked while it travelled: the tick survives the answer, and is what saves next.
    const duringSave: WeekDraft = { ...ticked, items: placeCustomer(ticked.items, placed(WED, "pm-2")) };
    const kept = settleSavedDraft({ current: duringSave, week, saved: made, sent, customers });
    assert.ok(kept.items.some((item) => item.planDate === WED && item.customerId === "pm-2"), "🔴 the tick made during the save is still on the day");
    assert.equal(isWeekDirty(kept, week), true, "and still unsaved");
    const next = buildWeekSavePayload({ seatId: "SEAT-PEDIA-REP-D11", test: false, week, draft: kept, customers });
    assert.equal(next.expectedVersion, 5, "the next save goes over the version the last one made");
    assert.ok(next.items.some((item) => item.planDate === WED && item.customerId === "pm-2"), "and carries the tick");
    assert.equal(
      markWeekSaved(scope, week, made, sent).items.some((item) => item.customerId === "pm-2"),
      false,
      "putting back the sent copy would have wiped that tick, and nothing would ever have saved it",
    );

    // (c) A save can overtake the read after the save before it: an OLDER version of the same plan
    // still fits a draft that saved past it; only a NEWER one is a week changed elsewhere.
    const atFour = week;
    const atFive: DraftWeek = { ...week, plan: { planId: "plan-1", version: 5 } };
    const atSix: DraftWeek = { ...week, plan: { planId: "plan-1", version: 6 } };
    assert.equal(draftFits(quiet, scope, atFour), true, "before the read lands");
    assert.equal(draftFits(quiet, scope, atFive), true, "after it");
    assert.equal(draftFits(quiet, scope, atSix), false, "a version it never made or stood over is a week changed elsewhere");
    assert.equal(draftFits(quiet, scope, { ...week, plan: { planId: "plan-2", version: 1 } }), false, "and another plan is never his draft's");
    const twoSaves = settleSavedDraft({ current: kept, week, saved: { planId: "plan-1", version: 6 }, sent: next, customers });
    assert.equal(twoSaves.basis, "plan-1|4", "two saves, and the read after the first not back yet");
    assert.equal(draftFits(twoSaves, scope, atFive), true, "🔴 that read, landing late at version 5, keeps the draft on screen — it never blinks away");

    // The key the timer and a failure are judged by.
    const key = selfSaveKey([{ scope, draft: ticked }]);
    assert.equal(selfSaveKey([{ scope, draft: { ...ticked, items: [...ticked.items].reverse() } }]), key, "the order of the ticks is not a new save");
    assert.notEqual(selfSaveKey([{ scope, draft: duringSave }]), key, "a tick is");
    assert.notEqual(selfSaveKey([{ scope, draft: quiet }]), selfSaveKey([{ scope, draft: { ...quiet, saved: null } }]), "and so is the version a save made");

    // The one status line.
    assert.equal(saveStatusLine({ saving: false, blocked: null, failed: null, savedOnce: false }), null, "nothing said before anything of his has saved");
    assert.deepEqual(saveStatusLine({ saving: true, blocked: null, failed: null, savedOnce: false }), { kind: "saving", text: "Saving…", canRetry: false });
    assert.deepEqual(saveStatusLine({ saving: false, blocked: null, failed: null, savedOnce: true }), { kind: "saved", text: "Saved", canRetry: false });
    assert.deepEqual(
      saveStatusLine({ saving: false, blocked: null, failed: "No connection. Check the phone's internet and try again.", savedOnce: true }),
      { kind: "not_saved", text: "Not saved — No connection. Check the phone's internet and try again.", canRetry: true },
      "a failed save says why, and offers Try again",
    );
    assert.deepEqual(
      saveStatusLine({ saving: true, blocked: "Tue 6 Oct is a day off on approved leave (Annual Vacation). Take pm-1 off it.", failed: null, savedOnce: true }),
      { kind: "not_saved", text: "Not saved — Tue 6 Oct is a day off on approved leave (Annual Vacation). Take pm-1 off it.", canRetry: false },
      "a week waiting on his fix keeps the board's own problem text, and the fix is his, not a button",
    );

    // ── The wiring ──
    const board = source("src/components/phoenix-crm/plan-board.tsx");
    // Managers and the Super Admin from Team keep the Save button exactly as it was; the rep's board has none.
    assert.match(board, /\{!repBoard && needsSave\.length > 0 \? \(\s*<SaveBar/, "the Save bar is a reviewer's only");
    assert.ok(board.includes("onSave={() => void saveWeeks(needsSave)}"), "and on his board it saves as it always did");
    assert.ok(board.includes("{saveStatus ? <SaveStatusLine locked={locked || selfSaving} onRetry={retrySelfSave} status={saveStatus} /> : null}"), "the rep's board shows the one line");
    assert.ok(board.includes("const saveStatus: SaveStatus | null = repBoard"), "and only the rep's");

    // The timer: 1.5 seconds after his last change, never while anything else is on its way.
    assert.ok(board.includes("window.setTimeout(() => onSelfSaveTimer(), PLAN_AUTOSAVE_DELAY_MS)"), "the save waits out the delay");
    assert.ok(board.includes("}, [selfSaveAt, selfSaveWaits, selfSaveIdle]);"), "and each change starts it again");
    assert.ok(board.includes("const selfSaveIdle = busy === null && !resource.loading && !selfSaving;"), "a send, a read or its own last save goes first");

    // 🔴 It only ever SAVES — the very save the button used — and never sends, asks or decides.
    const saveItself = bodyOf(board, "async function saveItself(");
    assert.ok(saveItself.includes("buildWeekSavePayload({ seatId, test, week: state.week, draft: sentFrom, customers: customersNow })"), "the button's own payload");
    assert.ok(saveItself.includes('crmPost<SavedPlan>("/api/phoenix-crm/plans", payload, "plan", { keepalive: options.keepalive })'), "the button's own route");
    assert.ok(saveItself.includes("settleSavedDraft({ current: previous[state.scope] ?? sentFrom"), "and the answer never wipes a tick made meanwhile");
    assert.doesNotMatch(saveItself, /plans\/submit|decide|edit-requests|monthly-plans|markWeekSaved/, "it never sends, asks, decides or puts back the sent copy");
    assert.match(saveItself, /if \(!view \|\| !repBoard \|\| busy !== null \|\| selfSaveFlight\.current\) return;/, "the rep's own board only, and never two at once");
    assert.equal((board.match(/crmPost<SavedPlan>\("\/api\/phoenix-crm\/plans"/g) ?? []).length, 2, "two places save a week: the button's saveOne and this");
    const events = board.split("useEffectEvent(").slice(1);
    assert.equal(events.length, 4, "four ways in: the timer, the page hidden, the board left, and + Make weekly plan");
    for (const event of events) {
      const callback = event.slice(0, event.indexOf("\n  });"));
      assert.match(callback, /^\(\) => \{\s*void saveItself\((?:\{ keepalive: true \})?\);\s*$/, "every effect event only ever saves — nothing sends from an effect");
    }
    const refused = bodyOf(board, "function refusedSelfSave(");
    assert.ok(refused.includes('[state.scope]: "unchecked"') && refused.includes('[state.scope]: "changed"'), "a refusal is held exactly as a pressed Save's is");
    assert.doesNotMatch(refused, /\bshow\(/, "and said on the status line, never in a banner that scrolls him away from his ticks");

    // Send first sends whatever is still waiting; it never crosses a save on its way.
    const send = bodyOf(board, "async function sendWeek(");
    assert.ok(send.includes("if (!view || locked || selfSaveFlight.current || !state.editable) return;"), "Send never crosses a save on its way");
    assert.ok(
      send.includes("const saveFirst = state.dirty || state.fixes > 0 || (state.week.plan === null && !state.draft?.saved);"),
      "and a save still waiting goes with the send — a week already saved is not saved twice",
    );
    assert.ok(board.includes("locked={repBoard ? locked || selfSaving : locked}"), "the week's Send waits while a save is on its way");

    // Leaving, hiding the page and choosing another week send what is waiting; the guard asks only about what cannot save itself.
    assert.ok(board.includes("const unsavedWork = repBoard ? waitingWeek !== undefined || selfSaveFailed : anyDirty;"), "the leave guard on his board is work that cannot save itself");
    assert.ok(board.includes("onDirtyChange?.(unsavedWork);"), "the page around the board asks only about that");
    assert.match(board, /useEffect\(\(\) => \{\s*if \(!unsavedWork\) return;\s*function onBeforeUnload/, "and so does the browser");
    assert.ok(board.includes('window.addEventListener("pagehide", onPageHide);'), "a page closing sends a waiting save");
    assert.ok(board.includes('if (document.visibilityState === "hidden") onPageHidden();'), "and so does a page hidden behind another app");
    assert.ok(board.includes("return () => onBoardLeaves();"), "and leaving the board");
    assert.match(bodyOf(board, "function chooseWeek("), /if \(repBoard\) void saveItself\(\);/, "and choosing another week");
    const api = source("src/components/phoenix-crm/api.ts");
    assert.ok(api.includes("...(options.keepalive ? { keepalive: true } : {}),"), "a save sent as the page goes outlives the page");

    // His ticks stay open while it saves and reads itself back; a send or any other read still locks them.
    assert.ok(board.includes("const editLocked = repBoard ? busy !== null || (resource.loading && !quietRead) : locked;"), "his ticks never grey while his board saves");
    assert.ok(board.includes("if (!state.editable || editLocked) return;"), "and every change to the draft obeys that lock");
    assert.ok(board.includes("const locked = busy !== null || resource.loading;"), "every action still locks on a read");

    // His panel: no "Unsaved changes" pill and no word asking him to press a Save that is not there.
    assert.ok(board.includes("autosave={repBoard}"), "the panel knows his board saves itself");
    const panel = source("src/components/phoenix-crm/plan-week-panel.tsx");
    assert.equal((panel.match(/\{dirty && !autosave \? <CrmPill tone="orange">Unsaved changes<\/CrmPill> : null\}/g) ?? []).length, 2, "no Unsaved changes pill on his board");
    assert.ok(panel.includes("they save again once it is back, or press Try again."), "a lost answer points him at Try again, not at Save");
    const copyMenu = source("src/components/phoenix-crm/plan-copy-menu.tsx");
    assert.ok(copyMenu.includes('return autosave ? "Nothing is sent until you press Send." : "Nothing is saved or sent until you do.";'), "a copy or a suggestion is kept, and only Send sends it");
    const dayPanel = source("src/components/phoenix-crm/plan-day-panel.tsx");
    assert.ok(!dayPanel.includes("Nothing is saved or sent until you do."), "his step 3 never says a fill waits for a Save");

    // The status line keeps the module's look: square, wrapping, never cut short.
    const line = bodyOf(board, "function SaveStatusLine(");
    assert.ok(line.includes("sticky bottom-[var(--crm-sticky-bottom,0px)]"), "held where the Save bar stood, above the portal's bottom bar");
    assert.ok(line.includes("break-words"), "a long reason wraps");
    assert.doesNotMatch(line, /\brounded-(?!none\b)|\btruncate\b|\bline-clamp-|\boverflow-x-auto\b/, "square, never cut short, never a sideways scroll");
  }

  // ── 4. A save answers with the week it saved: the board no longer reads the month again ─────────
  // (2026-10-16 speed audit — every pause in his ticking saved, then re-read the whole month: 16 to 22
  // reads, eight deep, 2.3 s at the median.)
  {
    type View = Parameters<typeof withSavedBoards>[0];
    type Board = Parameters<typeof withSavedBoards>[1][number];
    const MONTH = "2026-10-01";
    const week = (weekStart: string, version: number | null, leading = false, planId = `plan-${weekStart}`) =>
      ({ weekStart, leading, label: weekStart, plan: version === null ? null : { planId, version } }) as unknown as View["weeks"][number];
    const meters = (placed: number) =>
      ({ tallies: [], amMeter: { covered: placed }, pmMeter: { covered: placed + 1 }, callRate: { amPlacements: placed } }) as unknown as NonNullable<Board["meters"]>;
    const view = {
      monthStart: MONTH,
      weeks: [week("2026-09-26", 3, true), week("2026-10-03", 4), week("2026-10-10", null)],
      tallies: [],
      amMeter: { covered: 0 },
      pmMeter: { covered: 0 },
      callRate: { amPlacements: 0 },
      customers: [],
      blockedReason: null,
    } as unknown as View;

    // The saved week takes its own place and the meters move with it; nothing else on the board changes.
    const answered = withSavedBoards(view, [{ monthStart: MONTH, week: week("2026-10-03", 5), meters: meters(7) }]);
    assert.ok(answered, "an answer for this board is put on it");
    assert.equal(answered.weeks[1].plan?.version, 5, "the week as the save left it");
    assert.equal(answered.weeks[0], view.weeks[0], "every other week is the very same");
    assert.equal(answered.weeks[2], view.weeks[2]);
    assert.deepEqual([answered.amMeter, answered.pmMeter, answered.callRate], [{ covered: 7 }, { covered: 8 }, { amPlacements: 7 }], "AM and PM each from the answer, never averaged");
    assert.equal(answered.customers, view.customers, "the list is untouched");
    assert.equal(answered.blockedReason, view.blockedReason);
    assert.equal(view.weeks[1].plan?.version, 4, "and the board it was handed is never changed in place");

    // The leading week enters no meter: its answer carries none, and the board's stand.
    const leadingSaved = withSavedBoards(view, [{ monthStart: MONTH, week: week("2026-09-26", 4, true), meters: null }]);
    assert.equal(leadingSaved?.weeks[0].plan?.version, 4);
    assert.equal(leadingSaved?.amMeter, view.amMeter, "the leading week moves no meter");

    // A week's first save makes its plan; two saves before the first was put in place: both weeks, and
    // the LAST save's meters, which counted the first.
    const two = withSavedBoards(view, [
      { monthStart: MONTH, week: week("2026-10-03", 5), meters: meters(7) },
      { monthStart: MONTH, week: week("2026-10-10", 1), meters: meters(9) },
    ]);
    assert.equal(two?.weeks[1].plan?.version, 5);
    assert.equal(two?.weeks[2].plan?.version, 1);
    assert.deepEqual(two?.amMeter, { covered: 9 });

    // Anything that is not exactly this board's reads the board again, as every save did before.
    assert.equal(withSavedBoards(view, [{ monthStart: "2026-11-01", week: week("2026-10-03", 5), meters: meters(7) }]), null, "another month");
    assert.equal(withSavedBoards(view, [{ monthStart: MONTH, week: week("2026-10-17", 1), meters: meters(7) }]), null, "a week the board does not hold");
    assert.equal(withSavedBoards(view, [{ monthStart: MONTH, week: week("2026-10-03", 5, true), meters: null }]), null, "a week the board files differently");
    assert.equal(withSavedBoards(view, [{ monthStart: MONTH, week: week("2026-10-03", 3), meters: meters(7) }]), null, "🔴 an answer older than a read that landed after it");
    assert.equal(withSavedBoards(view, [{ monthStart: MONTH, week: week("2026-10-03", 5, false, "another"), meters: meters(7) }]), null, "another plan's week");
    assert.equal(withSavedBoards(view, [{ monthStart: MONTH, week: week("2026-10-03", null), meters: meters(7) }]), null, "a week the board holds a plan for, answered with none");

    // ── The wiring ──
    const board = source("src/components/phoenix-crm/plan-board.tsx");
    const saveItself = bodyOf(board, "async function saveItself(");
    assert.ok(saveItself.includes("const boardMonth = options.keepalive ? undefined : view.monthStart;"), "his board names the month on screen; a save leaving with the page asks for nothing back");
    assert.ok(
      saveItself.includes("const payload = { ...buildWeekSavePayload({ seatId, test, week: state.week, draft: sentFrom, customers: customersNow }), boardMonth };"),
      "on the very payload the button's save sends",
    );
    assert.match(saveItself, /if \(saved\.board\) boards\.push\(saved\.board\);\s*else unanswered = true;/, "every answer is kept, and one with no board is remembered");
    assert.match(saveItself, /if \(!unanswered && boards\.length > 0\) \{\s*setSavedBoards\(/, "every save answered: its weeks are put in place");
    assert.match(saveItself, /\} else \{\s*setQuietRead\(true\);\s*resource\.reload\(\);\s*\}/, "otherwise the board reads itself again, quietly, exactly as before");
    assert.match(board, /if \(savedBoards !== null && !resource\.loading\) \{/, "put in place only once no read is on its way");
    assert.ok(board.includes("const answered = view && savedBoards.url === planUrl ? withSavedBoards(view, savedBoards.boards) : null;"), "and only on the board it was saved from");
    assert.match(bodyOf(board, "async function saveWeeks("), /resource\.reload\(\);/, "a reviewer's Save button reads the board again as it always did");

    const route = source("app/api/phoenix-crm/plans/route.ts");
    assert.match(route, /const saved = await savePlan\(viewer, body, keep\);/);
    assert.match(route, /boardMonth !== undefined && keep\.reads \? await loadMonthlyWeekAfterSave\(viewer, \{ boardMonth, saved, reads: keep\.reads \}\) : null;/, "asked for, the save answers with the board");
    assert.match(route, /const plan = board \? \{ \.\.\.saved, board \} : saved;/, "and otherwise exactly as before");

    const month = source("src/lib/phoenix-crm/server/monthly-plans.ts");
    assert.match(bodyOf(month, "export async function loadMonthlyWeekAfterSave("), /catch \(error\) \{[\s\S]*?return null;/, "a board it cannot draw is null — never a failed save");
    // ONE week builder and ONE meter composer for the month and for the answer, so the two can never draw
    // a week, or count a customer, apart.
    assert.equal((month.match(/buildMonthlyWeekView\(/g) ?? []).length, 4, "declared once; the month calls it twice, the answer once");
    assert.equal((month.match(/monthMeters\(/g) ?? []).length, 3, "declared once; the month and the answer call it");
    assert.equal((month.match(/meterCustomerOf\(/g) ?? []).length, 3, "declared once; the month and the answer count customers through it");
    const answer = bodyOf(month, "async function savedWeekBoard(");
    assert.match(answer, /Number\(planRow\.version\) !== saved\.version\) return null;/, "a newer save already on the week: the board reads it whole");
    assert.match(answer, /holidays: reads\.holidays,\s*leave: reads\.leave,/, "what the save read is not read again");
    assert.match(answer, /in\("week_start", leading \? \[weekStart\] : weeks\)/, "the leading week reads only itself — it enters no meter");
  }

  // ── 5. The plan reads that waited on each other (2026-10-16 speed audit) ─────────────────────────
  {
    const plans = source("src/lib/phoenix-crm/server/plans.ts");
    assert.match(
      bodyOf(plans, "export async function loadPlanItemRows("),
      /mapWithConcurrency\(chunk\(\[\.\.\.new Set\(planIds\)\], 50\), PLAN_READ_CONCURRENCY,/,
      "a plan's item chunks are read a few at a time, never one after another",
    );
    assert.match(bodyOf(plans, "export async function loadPlanReviews("), /mapWithConcurrency\(chunk\(\[\.\.\.territoryById\.keys\(\)\], 100\), PLAN_READ_CONCURRENCY,/, "and so are the review list's territories");

    const save = bodyOf(plans, "export async function savePlan(");
    assert.ok(save.indexOf("const reads = Promise.all([") < save.indexOf("await assertRepMayChangeWeek("), "the save's list, holidays and leave start beside the one-week guard");
    assert.match(save, /await afterResponse\("phoenix_crm_plan_save_readiness_stamp", \(\) => territoryReadiness\(seat\.seatId, false, true\)\);/, "the readiness stamp runs once the answer has gone");
    assert.equal((save.match(/venueNamesOf\(|loadSharedPlaceNames\(/g) ?? []).length, 1, "the venue names are read once per save");

    const planner = bodyOf(plans, "export async function loadPlanner(");
    assert.ok(planner.indexOf("venueNamesOf(placesByCustomer, venueNames)") < planner.indexOf("] = await wave;"), "the week planner's venue names ride in its wave");
    assert.ok(planner.indexOf("loadPlanEditState(") < planner.indexOf("] = await wave;"), "and so does the week's request to edit it");
    const monthPlanner = bodyOf(source("src/lib/phoenix-crm/server/monthly-plans.ts"), "export async function loadMonthlyPlanner(");
    assert.ok(monthPlanner.indexOf("venueNamesOf(placesByCustomer, venueNames)") < monthPlanner.indexOf("] = await wave;"), "the month board's venue names ride in its wave");
    assert.doesNotMatch(monthPlanner, /await loadSharedPlaceNames\(/, "never after it");

    const transition = bodyOf(plans, "export async function transitionPlan(");
    assert.ok(transition.indexOf("const allRowsRead = loadPlanItemRows(") < transition.indexOf("await assertRepMayChangeWeek("), "a send's rows start beside the guard");
    assert.doesNotMatch(transition, /loadSharedPlaceIdsByPlace/, "and the venue rides on the item's own place");

    const reviews = bodyOf(source("src/lib/phoenix-crm/server/monthly-plans.ts"), "export async function loadMonthlyPlanReviews(");
    assert.ok(reviews.indexOf("const planRowsEarly = isTest ? null : planRowsOf(territories);") < reviews.indexOf("headerRows = await headerQuery(null);"), "the month review's weekly plans are read beside its headers");
    assert.equal((reviews.match(/mapWithConcurrency\(/g) ?? []).length, 2, "and both of its chunk loops are bounded, never one chunk at a time");

    const edits = source("src/lib/phoenix-crm/server/plan-edits.ts");
    assert.match(bodyOf(edits, "export async function loadPlanEditState("), /mapWithConcurrency\(/);
    assert.match(bodyOf(edits, "export async function loadPlanEditRows("), /mapWithConcurrency\(/);

    // 🔴 Copy last month's mirror read: keyset on the mirror's own key, never an offset with no order —
    // past 1,000 rows an unordered offset page could repeat a row or skip one.
    const history = bodyOf(source("src/lib/crm/plan-board.ts"), "export async function getAgentPlanEntriesForWindow(");
    assert.match(history, /query\.gt\("crm_plan_entry_id", cursor\)/);
    assert.match(history, /\.order\("crm_plan_entry_id", \{ ascending: true \}\)\.limit\(PAGE_SIZE\)/);
    assert.doesNotMatch(history, /\.range\(/, "no offset page");
    assert.match(source("src/lib/phoenix-crm/server/plan-history.ts"), /await Promise\.all\(\[\s*loadPeopleNames\(\[source\.source_hr_id\]\),\s*getAgentPlanEntriesForWindow\(/, "the source's name and his plan are read together");

    // The double-visit requests: an edit's notice version is the count read AFTER the edit — never the
    // count before it plus one, which two edits landing together would share, so the second notice would
    // be taken for a repeat — and the report's two reads run side by side.
    const doubleVisits = source("src/lib/phoenix-crm/server/double-visit-requests.ts");
    const editDays = bodyOf(doubleVisits, "export async function editDoubleVisitRequestDays(");
    assert.ok(
      editDays.indexOf("const after = await loadRequestRow(requestId);") > editDays.indexOf('callPhoenixCrm<Row>("phoenix_crm_edit_double_visit_request_days"'),
      "the version is read after the edit",
    );
    assert.match(editDays, /version: Number\(after\?\.edit_count \?\? 1\),/, "the notice carries the count the edit left");
    assert.doesNotMatch(editDays, /edit_count \?\? 0\) \+ 1/, "never the count before the edit plus one");
    const report = bodyOf(doubleVisits, "export async function loadDoubleVisitReport(");
    assert.ok(report.indexOf("scopedRead.catch(() => undefined);") < report.indexOf("await loadAddressedRequestRows("), "the scope's requests are read beside the ones addressed to him");
    for (const loader of ["async function loadScopeRequestRows(", "async function loadAddressedRequestRows("]) {
      assert.match(bodyOf(doubleVisits, loader), /mapWithConcurrency\(chunk\(/, `${loader} reads its chunks a few at a time`);
    }

    // The plan save rewrites only the items that changed — every save sends every item of the open days.
    const migration = readFileSync(new URL("supabase/migrations/20261016180100_phoenix_crm_save_plan_writes_only_changed_items.sql", ROOT), "utf8").replace(/--.*$/gm, "");
    assert.match(migration, /insert into public\.phoenix_crm_plan_items as t \(/);
    assert.match(
      migration,
      /where \(t\.place_id, t\.list_type, t\.receives, t\.start_minute, t\.exception_type, t\.exception_note\)\s+is distinct from\s+\(excluded\.place_id, excluded\.list_type, excluded\.receives, excluded\.start_minute, excluded\.exception_type, excluded\.exception_note\);/,
      "an item sent back as it is stored is left alone",
    );
    assert.match(migration, /revoke execute on function public\.phoenix_crm_save_plan\(jsonb\) from public, anon, authenticated;\s*grant execute on function public\.phoenix_crm_save_plan\(jsonb\) to service_role;/);
  }

  console.log("phoenix-crm plan screen extras: OK");
}
