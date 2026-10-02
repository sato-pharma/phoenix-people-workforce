import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PLAN_DEADLINE_LABEL } from "../src/lib/phoenix-crm/calendar.ts";
import { isPlanDaySent, planDayStatus, standingReturnedDay } from "../src/lib/phoenix-crm/plan-rules.ts";
import { weekIsAllDaysOff } from "../src/lib/phoenix-crm/plan-reminder-rules.ts";
import { buildPhoenixCrmStartGuide } from "../src/lib/phoenix-crm/start-guide.ts";
import { alsoTodayParts, buildTodayStops, type PlannedStop, type TodayVisit } from "../src/lib/phoenix-crm/today-rules.ts";
import {
  RECORDING_IN_FLIGHT_NEXT,
  RECORDING_IN_FLIGHT_WARNING,
  UNSAVED_VOICE_NOTE_WARNING,
  voiceNoteLeaveWarning,
} from "../src/lib/phoenix-crm/unsaved-voice-note.ts";
import { weekProgressOf, weekProgressParts } from "../src/lib/phoenix-crm/week-progress.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the six edges the audit of 2026-10-02 found around a plan DAY, pinned.
 *
 * Every one of them is a place where a rule that is right about the WEEK was applied to a DAY, or
 * the other way round. They are grouped here because they share that shape and because they shipped
 * in one change; each block names the sequence that produced it, so a later reader can tell a
 * deliberate decision from a regression.
 *
 * The rules they serve, all the owner's:
 *
 *   - "Planned" is a plan that reached submitted or approved BEFORE the visit's server `captured_at`
 *     — never a plan row the rep can still edit (2026-09-26).
 *   - An off-plan visit counts in nothing until it is approved (2026-09-26).
 *   - Returning ONE day reopens only that day; the other days stay planned (2026-10-02).
 *   - The deadline is 23:55 Cairo, written wherever a rep reads a due date (2026-10-02).
 *   - GOLDEN RULE #1, the EASY half: never tell a rep to do what he cannot do.
 */

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

/** SQL is read RAW: a migration's comments are part of what it says, and nothing here is TypeScript. */
function sql(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function stop(patch: Partial<PlannedStop>): PlannedStop {
  return {
    customerId: "c1",
    name: "Dr A",
    listType: "PM",
    speciality: null,
    brick: "D14",
    placeLabel: "Clinic",
    todayWindows: "10:00 to 14:00",
    startMinute: 600,
    ...patch,
  };
}

function visit(patch: Partial<TodayVisit>): TodayVisit {
  return { customerId: "c1", name: "Dr A", listType: "PM", doneAt: "10:24", ...patch };
}

const MIGRATION = "supabase/migrations/20261002221734_phoenix_crm_acknowledged_edit_opens_the_whole_week.sql";

export function runPhoenixCrmPlanDayEdgesTests(): void {
  // ── 1. HR's acknowledgement OPENS THE WHOLE WEEK — in the database as well as in TypeScript ────
  //
  // THE SEQUENCE, measured against origin/main on 2026-10-02: the rep asks to edit his sent week;
  // his district manager returns ONE day; the DM, then SFE approve the request and HR acknowledges
  // it AFTER the return. The acknowledgement left the `returned` plan exactly as it stood —
  // `returned_day` still set, no plan event written — while `standingReturnedDay` lifted the day for
  // every screen, so the rep could change any day. Then his next save wrote a 'saved' event carrying
  // `returned_day` (20261002142625), which is NEWER than the acknowledgement; and both database
  // readers of the "Still planned" rule compare the acknowledgement with the LATEST event. From that
  // save on, every day but the returned one counted as SENT again — so a visit to a customer he had
  // just added on another day was stamped PLANNED, with no DM and no SFE approval behind it and the
  // reason he typed dropped.
  //
  // The fix is at the acknowledgement, not in the readers: with the day cleared AND an event written,
  // the latest event is a plain whole-week return, which is authority on no day at all — the answer
  // those readers already give.
  {
    const migration = sql(MIGRATION);
    assert.match(
      migration,
      /elsif v_plan_from = 'returned' and v_plan\.returned_day is not null then/,
      "the acknowledgement answers a week returned for ONE day",
    );
    assert.match(migration, /set returned_day = null,/, "by clearing the day it was returned for");
    assert.match(
      migration,
      /jsonb_build_object\('edit_request_id', v_request_id, 'opened_whole_week', true\)/,
      "🔴 and by WRITING a plan event — the column alone would leave the latest event still naming the day, which is what the save and phoenix_crm_plan_day_status read",
    );
    assert.equal(
      [...migration.matchAll(/insert into public\.phoenix_crm_plan_events/g)].length,
      2,
      "one event for a sent week reopened, one for a week returned for a day — and no third path that writes none",
    );

    // The readers are NOT replaced here. They ask the latest event, and the latest event is now right.
    for (const untouched of ["phoenix_crm_save_visit", "phoenix_crm_plan_day_status", "phoenix_crm_save_plan"]) {
      assert.equal(
        migration.includes(`create or replace function public.${untouched}`),
        false,
        `${untouched} is not replaced by this file — the state it reads is what changed`,
      );
    }
    // The SECURITY DEFINER rule the required `validate` job enforces, stated here too because this
    // function is the one door a reviewer's decision goes through.
    assert.match(
      migration,
      /revoke execute on function public\.phoenix_crm_decide_plan_edit_request\(jsonb\) from public, anon, authenticated;/,
      "anon and authenticated inherit EXECUTE through PUBLIC, so all three are revoked",
    );
    assert.match(migration, /grant execute on function public\.phoenix_crm_decide_plan_edit_request\(jsonb\) to service_role;/);

    // TypeScript's own answer is unchanged and now agrees with the database by construction: with the
    // column cleared there is no day to stand, and the time comparison stays as the reading of a row
    // written before this migration.
    assert.equal(
      standingReturnedDay({ status: "returned", returnedDay: null, decidedAt: "2026-10-05T09:00:00Z", editAcknowledgedAt: "2026-10-06T09:00:00Z" }),
      null,
      "no day stored, no day standing",
    );
    assert.equal(
      standingReturnedDay({ status: "returned", returnedDay: "2026-10-06", decidedAt: "2026-10-05T09:00:00Z", editAcknowledgedAt: "2026-10-06T09:00:00Z" }),
      null,
      "and a row written before the migration is still lifted by the acknowledgement that came after the return",
    );
    assert.equal(
      standingReturnedDay({ status: "returned", returnedDay: "2026-10-06", decidedAt: "2026-10-07T09:00:00Z", editAcknowledgedAt: "2026-10-06T09:00:00Z" }),
      "2026-10-06",
      "an acknowledgement BEFORE the return never lifts it — that week was returned afterwards",
    );
  }

  // ── 2. The landing chips count the PLAN's stops, and the off-plan work sits beside them ────────
  //
  // `doneAm`/`donePm` counted every visit logged today against a denominator taken from the plan, so
  // one visit off the plan read "AM 3 of 2" and the chip turned GREEN with a planned stop still
  // undone. `team-today.ts` has always kept the two apart for his managers; this is the same rule on
  // his own screen, and the work he did off the plan is still shown — beside it, never inside it.
  {
    const built = buildTodayStops({
      planned: [stop({ customerId: "a", listType: "AM" }), stop({ customerId: "b", listType: "AM" })],
      visitsToday: [
        visit({ customerId: "a", listType: "AM", doneAt: "09:05" }),
        visit({ customerId: "z", name: "Dr Z", listType: "AM", doneAt: "09:40" }),
        visit({ customerId: "y", name: "Dr Y", listType: "PM", doneAt: "17:10" }),
      ],
    });
    assert.equal(built.counts.plannedAm, 2, "two AM planned");
    assert.equal(built.counts.doneAm, 1, "🔴 ONE of them done — never 2, which is what counting every AM visit gave");
    assert.ok(built.counts.doneAm < built.counts.plannedAm, "so the chip cannot read done with a planned stop still undone");
    assert.equal(built.counts.extraAm, 1, "the AM visit off the plan is counted, apart");
    assert.equal(built.counts.extraPm, 1, "and so is the PM one");
    assert.equal(built.counts.donePm, 0, "nothing was planned on PM, so nothing planned was done there");
    assert.deepEqual(alsoTodayParts(built.counts), ["AM 1", "PM 1"], "and his own screen says what he did off the plan, AM and PM apart");
    assert.deepEqual(alsoTodayParts({ extraAm: 0, extraPm: 0 }), [], "a day with nothing off the plan draws no line at all");
    assert.deepEqual(alsoTodayParts({ extraAm: 0, extraPm: 2 }), ["PM 2"], "and a figure at zero is left out, as the chips leave one out");

    // Never summed, never averaged (the call-rate golden rule reaches every count on this panel).
    const rules = source("src/lib/phoenix-crm/today-rules.ts");
    assert.equal(/extraAm \+ extraPm|doneAm \+ donePm/.test(rules), false, "AM and PM are never added into one figure");

    const landing = source("src/lib/phoenix-crm/server/rep-landing.ts");
    assert.ok(landing.includes("alsoParts: alsoTodayParts(view.counts),"), "the landing panel is handed the parts, never a figure to add up");
    const panel = source("src/components/employee-portal/rep-today-plan-panel.tsx");
    assert.ok(panel.includes('<FootLine label="Also today" parts={plan.alsoParts} />'), "and draws them under the stops, beside This week");
  }

  // ── 3. His week line counts the days he SENT, not the week's own status ────────────────────────
  //
  // A week returned for ONE day reads `returned`, so asking `isPlanSentForReview` of the WEEK took
  // the planned figures off the whole line: every stop he sent and nobody took back stopped being
  // planned because one day came back to him.
  {
    const visits = [{ visitDate: "2026-10-03", listType: "AM", pharmacyName: null }];
    const sentDays = weekProgressOf({ weekStart: "2026-10-03", anyDaySent: true, plannedListTypes: ["AM", "PM", "PM"], visits });
    assert.deepEqual(sentDays.planned, { am: 1, pm: 2 }, "the stops on the days he sent");
    assert.deepEqual(weekProgressParts(sentDays), ["AM 1 planned · 1 visited", "PM 2 planned · 0 visited"], "and the line reads as his own work");
    assert.equal(
      weekProgressOf({ weekStart: "2026-10-03", anyDaySent: false, plannedListTypes: ["AM"], visits }).planned,
      null,
      "with no sent day at all there is nothing planned to read yet",
    );

    // The day rule itself: a week returned for Tuesday still stands on every other day, and the
    // returned day alone is back with him.
    const returned = { status: "returned", returnedDay: "2026-10-06", returnedFrom: "approved" } as const;
    assert.equal(planDayStatus({ ...returned, date: "2026-10-05" }), "approved", "Monday is what the week was when Tuesday was returned");
    assert.equal(planDayStatus({ ...returned, date: "2026-10-06" }), "returned", "and Tuesday is his again");
    assert.equal(isPlanDaySent({ ...returned, date: "2026-10-05" }), true, "so Monday is a sent day");
    assert.equal(isPlanDaySent({ ...returned, date: "2026-10-06" }), false, "and Tuesday is not");
    assert.equal(
      isPlanDaySent({ status: "returned", returnedDay: null, returnedFrom: null, date: "2026-10-05" }),
      false,
      "a week returned WHOLE is authority on no day — which is what an acknowledged edit now leaves behind (block 1)",
    );
  }

  // ── 4. The start guide carries the HOUR, in both languages ─────────────────────────────────────
  //
  // The deadline is 23:55 Cairo, an instant, and it is written wherever a rep reads a due date
  // (owner, 2026-10-02). The guide is the one page a NEW rep is handed, and both halves of it said
  // "the Thursday before it" with no hour — teaching him the cut-off was midnight.
  {
    for (const language of ["en", "ar"] as const) {
      const guide = buildPhoenixCrmStartGuide(language);
      assert.ok(guide.includes(PLAN_DEADLINE_LABEL), `the ${language} guide prints the deadline (${PLAN_DEADLINE_LABEL})`);
    }
    assert.ok(
      buildPhoenixCrmStartGuide("en").includes(`due on the Thursday before it at ${PLAN_DEADLINE_LABEL}`),
      "the English sentence joins the hour to the day it is due",
    );
    // Interpolated from the ONE constant, never typed: the hour here can never drift from the hour
    // the server stamps him late against.
    const guideSource = source("src/lib/phoenix-crm/start-guide.ts");
    assert.ok(guideSource.includes("${PLAN_DEADLINE_LABEL}"), "the guide reads the constant");
    assert.equal(/11:55\s*(PM|pm)/.test(guideSource), false, "and never writes the hour out by hand");
  }

  // ── 5. A week he CANNOT send is never chased ───────────────────────────────────────────────────
  //
  // GOLDEN RULE #1: never tell a rep to do what he cannot do. A week whose every working day is a
  // public holiday or his own approved full-day leave holds no customer — the day's list types are
  // empty and a save that names it is refused — so the send comes back `phoenix_crm:empty_plan`.
  // The 12:57 and 17:57 reminders still told him "Due tonight, press Send", twice a day, and told
  // his district manager he had not sent it.
  {
    const week = "2026-10-03";
    const all = new Set(["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    assert.equal(weekIsAllDaysOff(week, all), true, "every working day off: there is nothing he could send");
    const oneLeft = new Set([...all].filter((day) => day !== "2026-10-06"));
    assert.equal(weekIsAllDaysOff(week, oneLeft), false, "🔴 ONE working day left is still a week he sends — and he is reminded exactly as before");
    assert.equal(weekIsAllDaysOff(week, new Set()), false, "and a read that gave no days off reminds him, which is the safe direction");
    assert.equal(weekIsAllDaysOff(week, new Set(["2026-10-09"])), false, "a day outside the week is not one of its days");

    const run = source("src/lib/phoenix-crm/server/plan-reminder.ts");
    assert.ok(run.includes("loadPlanHolidays(day.weekStart, weekEnd),"), "the week's public holidays are read once for the whole run");
    assert.ok(run.includes("loadSeatsDaysOff(stillToSend, { from: day.weekStart, to: weekEnd }),"), "and every reminded rep's own leave in ONE read, not one per seat");
    assert.ok(run.includes("weekIsAllDaysOff(day.weekStart,"), "the rule decides it, never a copy of the rule here");
    assert.ok(run.includes("cannotSend: stillToSend.length - unsent.length,"), "and the run says how many it left alone, so a quiet run reads as one");
    // Both notices are built from the filtered list, so his manager is not told about him either.
    const repAt = run.indexOf("repReminder({ hrId: rep");
    const managerAt = run.indexOf("managerReminder({ hrId, day, cairoToday, tick, repNames })");
    const filteredAt = run.indexOf("const unsent = stillToSend.filter(");
    assert.ok(filteredAt > 0 && repAt > filteredAt && managerAt > filteredAt, "the rep's notice and his manager's are both built after the filter");
  }

  // ── 6. The microphone is not thrown away by Next ───────────────────────────────────────────────
  //
  // Step 3 holds every box, including the microphone; Next swaps the whole of it for the read-back,
  // which UNMOUNTS `CrmSpeak`, and its cleanup CANCELS the recorder — cancelled, so what was caught
  // is discarded and nothing is uploaded. The rep pressed the button the form was telling him to
  // press and the recording was gone with no word said. The one-shot leave warning never fired for
  // it either: `voiceNote` is null until Stop.
  {
    assert.deepEqual(
      voiceNoteLeaveWarning({ hasVoiceNote: false, recording: true, saving: false, warned: false }),
      { title: "Your recording", message: RECORDING_IN_FLIGHT_WARNING },
      "leaving with the microphone open is stopped once, and told what it costs",
    );
    assert.deepEqual(
      voiceNoteLeaveWarning({ hasVoiceNote: true, recording: false, saving: false, warned: false }),
      { title: "Your voice note", message: UNSAVED_VOICE_NOTE_WARNING },
      "a stored note still reads its own sentence",
    );
    assert.equal(
      voiceNoteLeaveWarning({ hasVoiceNote: true, recording: true, saving: false, warned: true }),
      null,
      "🔴 the second press LEAVES, recording or not — a guard he cannot get out of is the trap Golden Rule #1 forbids",
    );
    assert.equal(voiceNoteLeaveWarning({ hasVoiceNote: true, recording: true, saving: true, warned: false }), null, "and a save in flight is never interrupted");
    assert.equal(voiceNoteLeaveWarning({ hasVoiceNote: false, recording: false, saving: false, warned: false }), null, "nothing recorded, nothing asked");

    // It says what he loses and what to do, never what he did wrong.
    for (const sentence of [RECORDING_IN_FLIGHT_WARNING, RECORDING_IN_FLIGHT_NEXT]) {
      for (const forbidden of [/you forgot/i, /\bunsaved changes\b/i, /\bwarning\b/i, /\berror\b/i, /\bmust\b/i]) {
        assert.ok(!forbidden.test(sentence), `"${sentence}" must not say ${forbidden} — it is a fact about the app, not a failing of his`);
      }
      assert.match(sentence, /Stop/, "and both name the one tap that keeps it");
    }

    const speak = source("src/components/phoenix-crm/speak.tsx");
    assert.ok(speak.includes("onBusy?: (busy: boolean) => void;"), "the control reports whether the microphone is open");
    assert.ok(speak.includes("onBusy?.(true);"), "true once something really started");
    assert.ok(speak.includes("} finally {\n      onBusy?.(false);\n    }"), "and false only after the upload and the writing-out have finished");
    assert.equal(
      /useEffect\(\(\) => \{[^}]*onBusy/.test(speak),
      false,
      "reported from the handlers, never an effect — a setState inside useEffect is a lint error in this repo, and this one lands in the caller",
    );

    const form = source("src/components/phoenix-crm/visit-log-form.tsx");
    assert.ok(form.includes("onBusy={setRecording}"), "the form listens");
    const toLog = form.slice(form.indexOf("function toLog() {"), form.indexOf("function toggleProduct("));
    assert.ok(toLog.includes("if (recording) {"), "and Next stops while the microphone is open");
    assert.ok(toLog.includes("setProblem(RECORDING_IN_FLIGHT_NEXT);"), "saying what to press instead");
    assert.ok(toLog.includes("showStep(STEP_COMMENT);"), "and taking him to the control it means");
    assert.ok(toLog.indexOf("if (recording) {") < toLog.indexOf("if (openStep !== null) {"), "before anything else — the recording is what going on would destroy");
    assert.ok(
      form.includes("voiceNoteLeaveWarning({ hasVoiceNote: voiceNote !== null, recording, saving, warned: leaveWarning !== null })"),
      "and Back asks the one guard, with the microphone's state in it",
    );
  }

  console.log("phoenix-crm plan-day edges: OK");
}
