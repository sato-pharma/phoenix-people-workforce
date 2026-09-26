import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripCommentsCompact } from "./support/comment-strip.ts";

import {
  buildTodayStops,
  compareTodayStops,
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
    assert.deepEqual(built.counts, { plannedAm: 1, plannedPm: 2, doneAm: 1, donePm: 1 }, "four figures, never a total");

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

  // ── "No plan sent" and "a sent plan with nobody on it" are different answers ────────────────────
  //
  // They send him to different screens, so the loader must be able to tell them apart. `hasPlan` is
  // the whole reason `plannedCustomersOn` exists beside the older `plannedCustomerIds`.
  {
    const visits = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/visits.ts", import.meta.url), "utf8"));
    const start = visits.indexOf("export async function plannedCustomersOn");
    assert.notEqual(start, -1, "plannedCustomersOn is exported");
    const body = visits.slice(start, start + 1400);
    assert.ok(body.includes("hasPlan: false"), "no sent plan is its own answer");
    assert.ok(body.includes('.in("status", ["submitted", "approved"])'), "and only a SENT plan counts, exactly as the visit save decides it");
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

  console.log("phoenix-crm today: OK");
}
