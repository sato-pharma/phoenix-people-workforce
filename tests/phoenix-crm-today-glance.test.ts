import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { buildTodayStops, NO_PLACE_YET, nextStop, stopWhereLine, todayRouteOrder, visitDayMinute, type TodayStop } from "../src/lib/phoenix-crm/today-rules.ts";

/**
 * Phoenix CRM — Today at a glance, and "Next up" (owner, 2026-09-30: "the best-appearing and easiest
 * CRM, yet controlled").
 *
 * Between two doors the rep asks two things: how much of the plan is done, and who to go to NOW. The
 * screen answers both at the top — AM and PM each on its own square bar, and one card naming the
 * next customer with one big Log visit button — and keeps the whole list underneath.
 *
 * Two halves are pinned here:
 *
 *   1. **`nextStop`, the pure choice.** Receives now beats receives later; later beats no hours
 *      saved; a customer who does not receive today goes last; a done customer is never chosen; and a
 *      tie falls to the plan's own brick order — the order the screen draws, not the array order.
 *   2. **The screen.** AM and PM are two bars, never one (the call-rate golden rule); Log visit on
 *      the card is the SAME planned-visit hand-off the row's Add visit uses, so there is no new step
 *      in his day; and the house rules (square corners, no ellipsis, nothing that says he is checked).
 */

/** Minutes past midnight. */
const at = (hours: number, minutes = 0) => hours * 60 + minutes;

/** Wednesday — `nextStop` names the weekday a customer does not receive on. */
const WEDNESDAY = 3;

function row(patch: Partial<TodayStop>): TodayStop {
  return {
    customerId: "c1",
    name: "Customer",
    listType: "PM",
    speciality: null,
    brick: "D14",
    placeLabel: "Clinic",
    todayWindows: "5:00 PM – 8:00 PM",
    startMinute: null,
    grade: "B",
    windows: [],
    hoursSaved: true,
    done: false,
    doneAt: null,
    ...patch,
  };
}

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

export function runPhoenixCrmTodayGlanceTests(): void {
  // ── (a) nextStop: who he should go to next ──────────────────────────────────────────────────────

  // Receives NOW beats receives later — even when the later one comes first on the route.
  {
    const later = row({ customerId: "later", windows: [{ startMinute: at(19), endMinute: at(21) }] });
    const open = row({ customerId: "open", windows: [{ startMinute: at(17), endMinute: at(20) }] });
    const next = nextStop([later, open], at(18), WEDNESDAY);
    assert.equal(next?.stop.customerId, "open", "the one receiving right now is next, whatever the route order");
    assert.equal(next?.state, "now");
    assert.equal(next?.status, "Receives now until 8:00 PM", "and the card says until when, on the module's own clock");
  }

  // Receives LATER beats no hours saved; and of two later ones, the soonest.
  {
    const noHours = row({ customerId: "no-hours", hoursSaved: false, windows: [] });
    const eight = row({ customerId: "eight", windows: [{ startMinute: at(20), endMinute: at(22) }] });
    const seven = row({ customerId: "seven", windows: [{ startMinute: at(19), endMinute: at(21) }] });
    const next = nextStop([noHours, eight, seven], at(18), WEDNESDAY);
    assert.equal(next?.stop.customerId, "seven", "a known opening beats no hours saved, and the soonest opening wins");
    assert.equal(next?.state, "later");
    assert.equal(next?.status, "Receives from 7:00 PM");

    const onlyNoHours = nextStop([noHours], at(18), WEDNESDAY);
    assert.equal(onlyNoHours?.status, "No hours saved yet", "no hours is said as it is — never as \"does not receive\"");
  }

  // Does not receive TODAY goes last — behind no hours, and behind hours that are over for today.
  {
    const notToday = row({ customerId: "not-today", hoursSaved: true, windows: [] });
    const passed = row({ customerId: "passed", windows: [{ startMinute: at(9), endMinute: at(12) }] });
    const noHours = row({ customerId: "no-hours", hoursSaved: false, windows: [] });

    assert.equal(nextStop([notToday, passed, noHours], at(18), WEDNESDAY)?.stop.customerId, "no-hours", "no hours saved may still be in");
    assert.equal(nextStop([notToday, passed], at(18), WEDNESDAY)?.stop.customerId, "passed", "hours over today beats not receiving today at all");
    const last = nextStop([notToday], at(18), WEDNESDAY);
    assert.equal(last?.state, "not-today");
    assert.equal(last?.status, "Does not receive on Wednesday", "he is still his to visit, and the card says plainly why he is last");
    assert.equal(nextStop([passed], at(18), WEDNESDAY)?.status, "Today's hours have passed");
  }

  // A DONE customer is never chosen; nothing left is null.
  {
    const doneOpen = row({ customerId: "done-open", done: true, doneAt: "17:40", windows: [{ startMinute: at(17), endMinute: at(20) }] });
    const notToday = row({ customerId: "not-today", hoursSaved: true, windows: [] });
    assert.equal(nextStop([doneOpen, notToday], at(18), WEDNESDAY)?.stop.customerId, "not-today", "a visited customer is never next, however open he is");
    assert.equal(nextStop([doneOpen], at(18), WEDNESDAY), null, "every planned visit done: nothing is next — the screen celebrates instead");
    assert.equal(nextStop([], at(18), WEDNESDAY), null, "nothing planned: nothing is next");
  }

  // A tie falls to the plan's own BRICK order — AM before PM, then the bricks in the order he meets them.
  {
    const stops = [
      row({ customerId: "am", listType: "AM", brick: "X1", hoursSaved: false }),
      row({ customerId: "d14-first", brick: "D14", hoursSaved: false }),
      row({ customerId: "a1", brick: "A1", hoursSaved: false }),
      row({ customerId: "d14-second", brick: "D14", hoursSaved: false }),
    ];
    assert.deepEqual(
      todayRouteOrder(stops).map((stop) => stop.customerId),
      ["am", "d14-first", "d14-second", "a1"],
      "the route is the screen's own: AM first, then each brick clustered where he first meets it",
    );
    assert.equal(nextStop(stops, at(10), WEDNESDAY)?.stop.customerId, "am", "all equal: the first stop on the route");
    const amDone = stops.map((stop) => (stop.customerId === "am" ? { ...stop, done: true } : stop));
    assert.equal(nextStop(amDone, at(10), WEDNESDAY)?.stop.customerId, "d14-first");
    const twoDone = amDone.map((stop) => (stop.customerId === "d14-first" ? { ...stop, done: true } : stop));
    assert.equal(
      nextStop(twoDone, at(10), WEDNESDAY)?.stop.customerId,
      "d14-second",
      "the rest of the same brick comes before the next brick — not the array's next row",
    );
  }

  // The edges of the clock.
  {
    // A start time only counts as one hour long, as everywhere in the module.
    const fromFive = row({ customerId: "from-five", windows: [{ startMinute: at(17), endMinute: null }] });
    assert.equal(nextStop([fromFive], at(17, 30), WEDNESDAY)?.status, "Receives now, from 5:00 PM");
    assert.equal(nextStop([fromFive], at(18, 30), WEDNESDAY)?.state, "passed");

    // A clinic open past midnight still receives at 00:30, which is minute 1470 of the visit day.
    const late = row({ customerId: "late", windows: [{ startMinute: at(22), endMinute: at(25) }] });
    assert.equal(nextStop([late], at(24, 30), WEDNESDAY)?.status, "Receives now until 1:00 AM");

    // No clock to read: the hours, and never "now".
    const noClock = nextStop([fromFive], null, WEDNESDAY);
    assert.equal(noClock?.state, "later");
    assert.equal(noClock?.status, "Receives from 5:00 PM");

    // A stop built before the new fields existed still reads: its first start, or no hours.
    const older = { ...row({ startMinute: at(17) }), windows: undefined, hoursSaved: undefined, grade: undefined };
    assert.equal(nextStop([older], at(16), WEDNESDAY)?.status, "Receives from 5:00 PM");
    const olderNoHours = { ...row({ startMinute: null }), windows: undefined, hoursSaved: undefined };
    assert.equal(nextStop([olderNoHours], at(16), WEDNESDAY)?.status, "No hours saved yet");
  }

  // visitDayMinute: the Cairo clock, on the VISIT day (which turns over at 02:00). December, so the
  // readings do not lean on Egypt's summer time.
  {
    assert.equal(visitDayMinute(Date.parse("2026-12-02T10:00:00Z"), "2026-12-02"), at(12), "Cairo is UTC+2 in December: noon");
    assert.equal(
      visitDayMinute(Date.parse("2026-12-02T23:30:00Z"), "2026-12-02"),
      at(25, 30),
      "01:30 on the 3rd is still the 2nd's visit day — minute 1530",
    );
    assert.equal(visitDayMinute(Date.parse("2026-12-03T00:30:00Z"), "2026-12-02"), null, "02:30: that visit day is over, so nobody is \"now\"");
    assert.equal(visitDayMinute(Date.parse("2026-12-05T10:00:00Z"), "2026-12-02"), null, "a screen left open for days calls nobody \"now\"");
    assert.equal(visitDayMinute(Number.NaN, "2026-12-02"), null);
  }

  // ── (b) The screen ──────────────────────────────────────────────────────────────────────────────

  const tab = source("src/components/phoenix-crm/today-tab.tsx");

  // AM and PM: two bars, apart — never one, never a sum.
  {
    assert.match(
      tab,
      /<PlanMeter done=\{plannedDone\("AM"\)\} listType="AM" planned=\{view\.counts\.plannedAm\} target=\{view\.target\.am\} visited=\{view\.counts\.doneAm\} \/>/,
      "an AM bar, fed only AM figures",
    );
    assert.match(
      tab,
      /<PlanMeter done=\{plannedDone\("PM"\)\} listType="PM" planned=\{view\.counts\.plannedPm\} target=\{view\.target\.pm\} visited=\{view\.counts\.donePm\} \/>/,
      "a PM bar, fed only PM figures",
    );
    assert.equal((tab.match(/<PlanMeter\b/g) ?? []).length, 2, "exactly two bars — there is no third, combined one");
    assert.equal((tab.match(/role="progressbar"/g) ?? []).length, 1, "the one bar drawing lives in PlanMeter, so every bar on Today is per list type");
    assert.equal(
      /(done|planned)(Am|Pm)\s*\+|\+\s*[\w.]*(done|planned)(Am|Pm)|\/\s*2\b/.test(tab),
      false,
      "AM and PM are never summed or averaged — the call-rate golden rule",
    );
  }

  // Next up: the choice is nextStop's, and Log visit IS the planned-visit hand-off.
  {
    assert.ok(tab.includes("nextStop(view.stops, nowMs === null ? null : visitDayMinute(nowMs, view.date), weekdayOfIsoDay(view.date))"), "Next up is chosen by nextStop from his own day");
    assert.ok(
      tab.includes("onLogVisit={() => onAddVisit(next.stop.customerId, next.stop.name)}"),
      "Log visit hands the customer to Add visit through the SAME onAddVisit the rows use — no new plumbing, no new step",
    );
    assert.match(tab, /onClick=\{onLogVisit\} variant="primary">\s*Log visit\s*<\/CrmButton>/, "one big primary button, labelled Log visit");
    assert.equal((tab.match(/>\s*Log visit\s*</g) ?? []).length, 1, "and only one of it");
    assert.match(tab, /dir="auto">\s*\{stop\.name\}/, "an Arabic name reads in its own direction");
    assert.ok(tab.includes('stop.grade ? `Grade ${stop.grade}` : "No grade"'), "the card names the grade");
    assert.ok(tab.includes("{listText(stop.listType)}"), "and AM or PM");

    // Everything done celebrates and offers Add visit; nothing planned offers Plan and Add visit.
    assert.ok(tab.includes("All planned visits done"), "a finished plan says so");
    assert.match(tab, /<AllDoneCard[\s\S]{0,200}onClick=\{onStartVisit\}/, "and offers Add visit for anyone else he sees");
    assert.match(tab, /<CrmEmpty[\s\S]{0,400}Open Plan[\s\S]{0,60}\{addDay\}/, "an empty day offers Open Plan, then Add visit");
  }

  // The house rules, on the three Today files.
  {
    for (const path of ["src/components/phoenix-crm/today-tab.tsx", "src/lib/phoenix-crm/today-rules.ts"]) {
      const code = source(path);
      for (const banned of [/\brounded-(?!none\b)/, /border-radius/, /\btruncate\b/, /\bline-clamp-/, /text-ellipsis|text-overflow/, /\boverflow-x-auto\b/]) {
        assert.equal(banned.test(code), false, `${path} breaks the locked look with ${banned} — square corners, no ellipsis, no sideways scroll`);
      }
      // GOLDEN RULE #1, the BLIND half: his most-opened screen never says he is being checked.
      for (const word of [/distance/i, /accuracy/i, /location/i, /integrity/i, /\bflagg?ed\b/i, /suspic/i, /\bfar\b/i]) {
        assert.equal(word.test(code), false, `${path} must not carry ${word} onto the rep's own day`);
      }
      assert.equal(/\b(doctor|doctors|account|accounts)\b/i.test(code), false, `${path} says "customer", never doctor or account`);
    }
  }

  // The server hands the card what it reads, and nothing about where he stood.
  {
    const server = source("src/lib/phoenix-crm/server/today.ts");
    assert.ok(server.includes("grade: parseGrade(row.grade),"), "each stop carries the grade on his list");
    assert.ok(
      server.includes("windows: windows.map((window) => ({ startMinute: window.startMinute, endMinute: window.endMinute })),"),
      "and today's windows — the season already decided on the server",
    );
    assert.ok(server.includes("hoursSaved: Boolean(place && place.timings.length > 0),"), "and whether any hours are saved at all");
  }

  // Where and when, said once (walk of 2026-09-30): a customer with no place read "No place saved yet ·
  // No place saved yet", and a place saved without a name read "No place saved yet", which was untrue.
  {
    assert.equal(stopWhereLine({ hasPlace: false, placeLabel: null, todayWindows: NO_PLACE_YET }, null), NO_PLACE_YET, "no place: said once");
    assert.equal(
      stopWhereLine({ hasPlace: true, placeLabel: null, todayWindows: "5:00 PM – 8:00 PM" }, "Brick Itsa"),
      "Brick Itsa · 5:00 PM – 8:00 PM",
      "a place saved without a name is still a place — never \"No place saved yet\"",
    );
    assert.equal(stopWhereLine({ placeLabel: "Evening clinic", todayWindows: "5:00 PM – 8:00 PM" }, null), "Evening clinic · 5:00 PM – 8:00 PM", "an older stop is judged by its hours line");
    assert.equal(stopWhereLine({ todayWindows: NO_PLACE_YET, placeLabel: null }, null), NO_PLACE_YET);
    const tab = stripComments(readFileSync(new URL("../src/components/phoenix-crm/today-tab.tsx", import.meta.url), "utf8"));
    assert.equal(/"No place saved yet"/.test(tab), false, "the screen never writes the phrase itself — one rule says it");
  }

  // ── AM · PM · PHARMACIES, three figures apart (owner, 2026-09-30: "show me my today plan am/pm/ph") ──
  // A pharmacy is feedback recorded ON a visit — a customer is AM or PM and nothing else — so there is
  // nothing to plan and no "Add visit" against one. It is the day's pharmacy work read back, counted
  // APART: never inside doneAm or donePm, whatever the vendor tagged.
  {
    const built = buildTodayStops({
      planned: [],
      visitsToday: [
        { customerId: "a", name: "Dr One", listType: "AM", doneAt: "09:10", pharmacyName: "El Ezaby" },
        { customerId: "b", name: "Dr Two", listType: "PM", doneAt: "17:40", pharmacyName: "el ezaby" },
        { customerId: "c", name: "Dr Three", listType: "PM", doneAt: "18:20", pharmacyName: "Seif" },
        { customerId: "d", name: "Dr Four", listType: "PM", doneAt: "19:00", pharmacyName: null },
      ],
    });
    assert.deepEqual(
      built.pharmacies.map((pharmacy) => `${pharmacy.name} | ${pharmacy.fromCustomers.join(", ")} | ${pharmacy.firstAt}`),
      ["el ezaby | Dr One, Dr Two | 09:10", "Seif | Dr Three | 18:20"],
      "one pharmacy however it is spelled, the latest spelling wins, every customer it came from, and the first clock",
    );
    assert.equal(built.counts.donePharmacies, 2, "two pharmacies");
    assert.equal(built.counts.doneAm, 1, "AM counts visits, never pharmacies");
    assert.equal(built.counts.donePm, 3, "and neither does PM");
    assert.equal(built.counts.doneAm + built.counts.donePm, 4, "the four visits stay four — a pharmacy is never added in");

    const tab = source("src/components/phoenix-crm/today-tab.tsx");
    assert.match(tab, /<PharmaciesToday view=\{view\} \/>/, "the day shows its pharmacies");
    assert.match(tab, /title=\{`Pharmacies · \$\{countText\(pharmacies\.length\)\} today`\}/, "counted on its own heading");
    const at = tab.indexOf("function PharmaciesToday(");
    const block = at < 0 ? "" : tab.slice(at, tab.indexOf("\n}", at));
    assert.ok(block, "it is one component");
    assert.doesNotMatch(block, /onAddVisit|Add visit/, "no Add visit against a pharmacy — it is recorded on a visit, never visited alone");
    assert.doesNotMatch(block, /distance|accuracy|flag|far/i, "and nothing that judges him");
  }

  console.log("phoenix-crm today glance: OK");
}
