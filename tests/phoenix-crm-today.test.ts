import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripCommentsCompact } from "./support/comment-strip.ts";

import {
  buildTodayStops,
  compareTodayStops,
  NO_HOURS_YET,
  NO_PLACE_YET,
  planUnsentNote,
  stopWhereLine,
  todayByBrick,
  todayEmptyReason,
  type PlannedStop,
  type TodayVisit,
} from "../src/lib/phoenix-crm/today-rules.ts";

/**
 * Phoenix CRM — A2: the app opens on his day.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "very easy very simple". He opens the app a
 * dozen times a day and landed on a tab bar. Now he lands on today's stops, in the order he will
 * drive them, each one done or one tap from being entered.
 *
 * Everything on that screen is HIS OWN WORK — his plan, his day, his two targets — which is exactly
 * what the rule keeps visible. Nothing that judges him is, and the last block below is what stops
 * the screen quietly becoming a place to put it.
 */

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

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runPhoenixCrmTodayTests(): void {
  // ── A visited stop KEEPS ITS PLACE ──────────────────────────────────────────────────────────────
  //
  // The obvious implementation moves a done stop to the bottom, and it is wrong: he glances at this
  // between two doors, and a list that reshuffles under him mid-morning is one he has to re-read
  // every time. It changes state in place, and nothing moves until tomorrow.
  {
    const planned = [stop({ customerId: "a", name: "Dr A" }), stop({ customerId: "b", name: "Dr B" }), stop({ customerId: "c", name: "Dr C" })];
    const built = buildTodayStops({ planned, visitsToday: [visit({ customerId: "b", name: "Dr B", doneAt: "11:05" })] });
    assert.deepEqual(built.stops.map((row) => row.customerId), ["a", "b", "c"], "the order does not change when one is done");
    assert.equal(built.stops[1]?.done, true);
    assert.equal(built.stops[1]?.doneAt, "11:05", "and it carries the time he entered it");
    assert.equal(built.stops[0]?.done, false);
    assert.equal(built.stops[0]?.doneAt, null);
  }

  // ── A visit off the plan sits BESIDE the day, never inside it ───────────────────────────────────
  {
    const built = buildTodayStops({
      planned: [stop({ customerId: "a" })],
      visitsToday: [visit({ customerId: "z", name: "Dr Z", listType: "AM", doneAt: "09:10" })],
    });
    assert.equal(built.stops.length, 1, "his route is still his route");
    assert.deepEqual(
      built.alsoVisited.map((row) => row.name),
      ["Dr Z"],
      "real work he did, shown — but dropping it into the middle of the route would change the shape of the list he is reading",
    );
  }

  // ── AM and PM are counted apart, always ─────────────────────────────────────────────────────────
  {
    const built = buildTodayStops({
      planned: [stop({ customerId: "a", listType: "AM" }), stop({ customerId: "b", listType: "PM" }), stop({ customerId: "c", listType: "PM" })],
      visitsToday: [visit({ customerId: "a", listType: "AM" }), visit({ customerId: "b", listType: "PM" })],
    });
    assert.deepEqual(built.counts, { plannedAm: 1, plannedPm: 2, doneAm: 1, donePm: 1, donePharmacies: 0 }, "five figures, never a total — and the pharmacies apart from both lists");

    const rules = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/today-rules.ts", import.meta.url), "utf8"));
    assert.equal(/doneAm \+ donePm|plannedAm \+ plannedPm/.test(rules), false, "AM and PM are never summed — the call-rate golden rule");
  }

  // ── The day is driven, not indexed ──────────────────────────────────────────────────────────────
  {
    const rows = [
      stop({ customerId: "late-pm", name: "Zaki", listType: "PM", startMinute: 900 }),
      stop({ customerId: "early-pm", name: "Adel", listType: "PM", startMinute: 600 }),
      stop({ customerId: "am", name: "Wael", listType: "AM", startMinute: 800 }),
    ].sort(compareTodayStops);
    assert.deepEqual(rows.map((row) => row.customerId), ["am", "early-pm", "late-pm"], "AM, then the hour the place opens, then the name");

    // Clustered AFTER that sort, so the clusters come out in the order he MEETS them.
    const notDone = (patch: Partial<PlannedStop>) => ({ ...stop(patch), done: false, doneAt: null });
    const groups = todayByBrick([
      notDone({ customerId: "1", brick: "D14" }),
      notDone({ customerId: "2", brick: "A1" }),
      notDone({ customerId: "3", brick: "D14" }),
      notDone({ customerId: "4", brick: null }),
    ]);
    assert.deepEqual(groups.map((group) => group.label), ["Brick D14", "Brick A1", "No brick"], "route order, and no-brick last");
    assert.equal(groups[0]?.rows.length, 2);
  }

  // ── An empty day says WHY, in his own terms ─────────────────────────────────────────────────────
  {
    assert.equal(todayEmptyReason({ hasPlan: true, isFieldDay: false, stops: 0 }), "Today is not a field day.");
    assert.match(String(todayEmptyReason({ hasPlan: false, isFieldDay: true, stops: 0 })), /No plan has been sent/);
    assert.equal(todayEmptyReason({ hasPlan: true, isFieldDay: true, stops: 0 }), "Nobody is planned for today.");
    assert.equal(todayEmptyReason({ hasPlan: true, isFieldDay: true, stops: 3 }), null, "a day with stops says nothing at all");
  }

  // ── THE DAY HE PLANNED IS SHOWN WHATEVER THE PLAN'S STATUS (owner, 2026-09-30) ─────────────────
  //
  // "in today show me my today plan am/pm/ph, list all drs of today with timing and location." It
  // read a SENT plan only, so the moment a rep touched his week after sending it the plan went back
  // to `draft` and Today answered "No plan has been sent for this week yet" — with 1 AM and 15 PM
  // sitting on that very day. His own work, hidden from him, on the screen he drives the day from.
  //
  // 🔴 SHOWING IT IS NOT COUNTING IT. What makes a visit count as PLANNED is still decided server
  // side against a plan that reached `submitted`/`approved` BEFORE the visit's captured_at — that is
  // `plannedCustomerIds`, a different reader, and it must keep its status filter or the rep can place
  // a customer at the door and have it count. This screen only shows and offers Add visit.
  {
    const visits = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/visits.ts", import.meta.url), "utf8"));

    const start = visits.indexOf("export async function plannedCustomersOn");
    assert.notEqual(start, -1, "plannedCustomersOn is exported");
    const body = visits.slice(start, visits.indexOf("\n}", start));
    assert.ok(body.includes("hasPlan: false"), "a week with no plan at all is still its own answer");
    assert.ok(
      !body.includes('.in("status", ["submitted", "approved"])'),
      "Today must not filter the plan by status — a draft day is still his day",
    );
    assert.ok(body.includes('.select("id, status")'), "it reads the status");
    assert.ok(
      body.includes('sent: status === "submitted" || status === "approved"'),
      "and reports whether it is sent, so the screen can say so without hiding the day",
    );

    // The counting reader keeps its filter. This is the half that must never loosen.
    const counting = visits.indexOf("async function plannedCustomerIds");
    assert.notEqual(counting, -1, "plannedCustomerIds is still there");
    const countingBody = visits.slice(counting, visits.indexOf("\n}", counting));
    assert.ok(
      countingBody.includes('"submitted"') && countingBody.includes('"approved"'),
      "what COUNTS as planned still requires a sent plan",
    );
  }

  // ── The reason, and the note that replaces hiding the day ──────────────────────────────────────
  {
    // A day with stops says nothing at all, whether or not the week is sent.
    assert.equal(todayEmptyReason({ hasPlan: true, isFieldDay: true, stops: 3 }), null);
    assert.equal(todayEmptyReason({ hasPlan: false, isFieldDay: true, stops: 3 }), null, "stops outrank every reason");
    assert.match(String(todayEmptyReason({ hasPlan: false, isFieldDay: true, stops: 0 })), /No plan has been sent/);
    assert.equal(todayEmptyReason({ hasPlan: true, isFieldDay: true, stops: 0 }), "Nobody is planned for today.");
    assert.equal(todayEmptyReason({ hasPlan: true, isFieldDay: false, stops: 5 }), "Today is not a field day.");

    // The note fires only where it is true, and it never fires on an empty day — there the reason
    // already says it, and two sentences saying the same thing is what the walk of 2026-09-30 removed.
    assert.equal(planUnsentNote({ hasPlan: true, sent: false, stops: 16 }), "This week is still a draft. Your day is below — send the week on Plan when it is ready.");
    assert.equal(planUnsentNote({ hasPlan: true, sent: true, stops: 16 }), null, "a sent week says nothing");
    assert.equal(planUnsentNote({ hasPlan: true, sent: false, stops: 0 }), null, "an empty day has no day to introduce");
    assert.equal(planUnsentNote({ hasPlan: false, sent: false, stops: 0 }), null);

    const tab = stripCommentsCompact(readFileSync(new URL("../src/components/phoenix-crm/today-tab.tsx", import.meta.url), "utf8"));
    assert.ok(tab.includes("{view.unsentNote ?"), "the screen says it");
    // It is a note, never a gate: nothing about the draft may disable Add visit or the rows.
    assert.ok(!/unsentNote[^\n]*\?\s*null\s*:/.test(tab), "the note never stands in place of the day");
    assert.ok(!/disabled=\{[^}]*unsentNote/.test(tab), "and it never disables anything");
  }

  // ── A CUSTOMER NOT VALIDATED YET STILL READS AS A PLACE ON THE ROUTE ───────────────────────────
  //
  // 88 of this rep's customers have no clinic saved, and they are planned and visited as normal. The
  // row used to say only "No place saved yet", so a day of them was a list of names with nowhere to
  // go. It now carries where the SALES MASTER has him — brick, area, town — which is the organogram's
  // vocabulary, never iReports360's own zone and city words.
  {
    const validated = { hasPlace: true, placeLabel: "Dr Nabil's clinic", reference: null, todayWindows: "9:00 AM – 1:00 PM" };
    assert.equal(stopWhereLine(validated, "باجور"), "Dr Nabil's clinic · باجور · 9:00 AM – 1:00 PM");

    const pending = { hasPlace: false, placeLabel: null, reference: { brick: "باجور", area: "Menoufia 2", address: "سرس" }, todayWindows: NO_PLACE_YET };
    assert.equal(stopWhereLine(pending, "باجور"), `باجور · Menoufia 2 · سرس · ${NO_HOURS_YET}`, "where he is, then what is actually missing");
    assert.equal(stopWhereLine(pending, null), `Menoufia 2 · سرس · ${NO_HOURS_YET}`, "the brick is not repeated when it is the group heading");
    assert.notEqual(NO_HOURS_YET, NO_PLACE_YET, "a row showing a place must never end by saying there is none");

    const bare = { hasPlace: false, placeLabel: null, reference: null, todayWindows: NO_PLACE_YET };
    assert.equal(stopWhereLine(bare, null), NO_PLACE_YET, "and with nothing known it still says it once, never twice");

    // The brick is taken from the reference too, so an unvalidated customer clusters with his own
    // brick-mates instead of falling into a nameless group at the end of the day.
    const loader = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/today.ts", import.meta.url), "utf8"));
    assert.ok(loader.includes("brick: place?.brickName ?? reference?.brick ?? null,"), "the brick falls back to the reference");
    assert.ok(loader.includes("loadPlannerReferences("), "and the loader fetches them");
    assert.ok(loader.includes("const reference = place ? null : (references.get(customerId) ?? null);"), "a validated customer never reads the reference");
  }

  // ── The shell opens on it, and a manager with a decision still lands on Team ────────────────────
  {
    const app = stripCommentsCompact(readFileSync(new URL("../src/components/phoenix-crm/phoenix-crm-app.tsx", import.meta.url), "utf8"));
    const start = app.indexOf("function openingTab(");
    assert.notEqual(start, -1);
    const body = app.slice(start, start + 800);
    const team = body.indexOf('decisions > 0) return "team"');
    const today = body.indexOf('return "today"');
    assert.notEqual(team, -1, "the Team branch is still there");
    assert.notEqual(today, -1, "and the app opens on Today");
    assert.ok(team < today, "a manager with a real decision waiting lands on Team FIRST — Today must not take that away from him");

    // 🔴 Eight tabs need an eighth grid, or the Super Admin's bar wraps onto a shrunken second line.
    assert.ok(app.includes('8: "grid-cols-2 sm:grid-cols-4 lg:grid-cols-8"'), "the eighth tab count has its own grid");
    const order = /const TAB_ORDER: readonly TabKey\[\] = \[([^\]]+)\]/.exec(app)?.[1] ?? "";
    assert.equal(order.split(",").length, 8, "TAB_ORDER and TAB_COLUMNS must agree, or the bar has no grid at its own width");
    assert.ok(order.trimStart().startsWith('"today"'), "Today is the first tab");
  }

  // ── The screen shows him nothing that judges him ────────────────────────────────────────────────
  //
  // This is the assertion that stops Today quietly becoming the place the distances live: it is the
  // rep's most-opened screen, which makes it the most tempting one.
  {
    for (const path of ["src/lib/phoenix-crm/server/today.ts", "src/lib/phoenix-crm/today-rules.ts", "src/components/phoenix-crm/today-tab.tsx"]) {
      const code = source(path);
      for (const word of [/distance/i, /accuracy/i, /\bfar\b/i, /spread/i, /integrity/i, /\bflagg?ed\b/i, /suspic/i]) {
        assert.equal(word.test(code), false, `${path} must not carry ${word} onto the rep's own day`);
      }
    }
  }

  // ── The dashboard: AM and PM as two sections, never one total (owner, 2026-09-29) ───────────────
  //
  // "A dashboard of today's visits, done and not done" — and the call-rate rule says AM and PM are
  // never summed or averaged. The old screen's "Planned today" tile counted `view.stops.length`, one
  // number over both lists; that is exactly the total this pins out.
  {
    const tab = source("src/components/phoenix-crm/today-tab.tsx");
    assert.ok(tab.includes('const LIST_TYPES: readonly PhoenixCrmListType[] = ["AM", "PM"];'), "the plan is drawn as an AM section and a PM section, AM first");
    assert.ok(tab.includes("LIST_TYPES.map((listType)"), "one section per list type");
    assert.equal(
      /(done|planned)(Am|Pm)\s*\+\s*[\w.]*(done|planned)(Am|Pm)|value=\{`\$\{view\.stops\.length\}`\}/.test(tab),
      false,
      "AM and PM are never added into one figure",
    );
    assert.ok(tab.includes("view.alsoVisited.map"), "the visits off the plan are shown beside it");
    assert.ok(tab.includes("unplannedKindLabel(extra.offKind)"), "each with its kind — out of plan or out of list");
    assert.ok(tab.includes("view.plannedActivity") && tab.includes("view.dayActivity"), "and the day's activity, planned and recorded");

    // 🔴 The envelope is opened ONCE. The route answers `{ today: TodayView }` and `useCrmGet(url,
    // "today")` already returns what sits under that key; the first screen typed the answer as
    // `{ today: TodayView }` and read `.today` again — always undefined, so Today never left its
    // loading state and nothing anywhere said why.
    const route = source("app/api/phoenix-crm/today/route.ts");
    assert.ok(route.includes("NextResponse.json({ today, success: true })"), "the route answers under the key `today`");
    assert.ok(tab.includes('useCrmGet<TodayView>(crmUrl("/api/phoenix-crm/today", { seatId, test }), "today")'), "the screen reads that key once");
    assert.equal(/data\?\.today|<\{ today: TodayView \}>/.test(tab), false, "and never opens the envelope a second time");
  }

  console.log("phoenix-crm today: OK");
}
