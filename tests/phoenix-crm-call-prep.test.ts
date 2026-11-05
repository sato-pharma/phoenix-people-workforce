import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  buildCallPrep,
  callPrepEmptyNote,
  nextFieldDayAfter,
  pickLastObjection,
  type CallPrepStop,
  type LastObjectionRow,
} from "../src/lib/phoenix-crm/call-prep.ts";
import type { LastVisitProducts } from "../src/lib/phoenix-crm/last-visit-products.ts";
import type { LastNextStep, VisitObjection } from "../src/lib/phoenix-crm/visit-outcome.ts";

/**
 * Tomorrow's call prep — four facts that existed and could only be read from INSIDE the visit form.
 *
 * `today.ts` is explicit that the day screen shows "only what he is going to do today", which is right
 * and leaves the evening before with nowhere to read when he last saw a doctor, what the doctor pushed
 * back on, what he himself promised, or what he discussed.
 *
 * WHAT EACH SECTION CATCHES, in the words of the change that would break it:
 *
 *  1. "Tomorrow" computed as `today + 1` — which on a Thursday evening prepares a FRIDAY, a day that
 *     holds no plan at all (calendar.ts `planDayListTypes`), so the whole screen would read empty for
 *     the one evening a rep most wants it.
 *  2. The objection taken from the newest visit that HAPPENS to carry one, so a doctor who objected on
 *     price in July and raised nothing at the last visit is presented as objecting. The module's own
 *     rule is the NEWEST visit's answer, and "No objection" is a stored answer that closes an older one.
 *  3. A missing fact defaulted to a blank or a zero instead of being ABSENT — "nothing to prepare" and
 *     "he prepared nothing" are different sentences and only the first is true of a carried-over doctor.
 *  4. A pharmacy filed among the doctors: `listType === "AM" ? am : pm` is the spelling that put 26
 *     readers wrong while the typechecker stayed green. A pharmacy is never planned at all.
 *  5. The read widened past the rep's own seat, moved onto the countable view, or growing a write —
 *     the plan is WEEKLY and a sent week changes only through "Ask to edit this week".
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

function rawSource(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

function objectionRow(input: { customerId: string; visitDate: string; objection: string | null; clock?: string }): LastObjectionRow {
  return {
    customerId: input.customerId,
    visitDate: input.visitDate,
    capturedAt: `${input.visitDate}T${input.clock ?? "10:00"}:00.000Z`,
    objection: input.objection,
  };
}

function stop(customerId: string, customerName: string, listType: unknown): CallPrepStop {
  return { customerId, customerName, listType };
}

function nextStep(label: string, dueOn: string | null): LastNextStep {
  return { date: "2026-10-01", nextStep: "send_data", label, dueOn };
}

/** Every fact unknown — the shape a carried-over doctor nobody has visited yet arrives in. */
const NOTHING_KNOWN: {
  lastSeen: ReadonlyMap<string, { lastSeenOn: string | null }>;
  products: ReadonlyMap<string, LastVisitProducts>;
  openNextSteps: ReadonlyMap<string, LastNextStep>;
  objections: ReadonlyMap<string, VisitObjection>;
} = {
  lastSeen: new Map(),
  products: new Map(),
  openNextSteps: new Map(),
  objections: new Map(),
};

export function runPhoenixCrmCallPrepTests(): void {
  // ── 1. "Tomorrow" is the next day a PLAN can hold ─────────────────────────────────────────────
  {
    // An ordinary field day: simply the next one. (2026-10-05 is a Monday.)
    assert.equal(nextFieldDayAfter("2026-10-05"), "2026-10-06");
    assert.equal(nextFieldDayAfter("2026-10-03"), "2026-10-04", "Saturday to Sunday");
    // 🔴 THURSDAY'S TOMORROW IS THE SATURDAY. Friday is never a field day (`planDayListTypes` answers
    // []), so `today + 1` would prepare a day that can hold no plan and the screen would read empty.
    assert.equal(nextFieldDayAfter("2026-10-08"), "2026-10-10", "Thursday skips Friday");
    // And a Friday itself — a rep opening the app on his day off — looks at the Saturday.
    assert.equal(nextFieldDayAfter("2026-10-09"), "2026-10-10", "Friday's tomorrow is the Saturday");
    // It is total: every day of a field week resolves to a field day.
    for (const day of ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]) {
      const next = nextFieldDayAfter(day);
      assert.ok(next > day, `${day} resolves forward`);
      assert.notEqual(new Date(`${next}T12:00:00Z`).getUTCDay(), 5, `${day} never resolves onto a Friday`);
    }
  }

  // ── 2. The objection is the NEWEST visit's answer ─────────────────────────────────────────────
  {
    const older = objectionRow({ customerId: "c1", visitDate: "2026-07-01", objection: "price" });
    assert.equal(pickLastObjection([older]).get("c1"), "price", "on its own it stands");

    // A later visit with NO objection answer at all replaces it: the newest visit's answer is the one.
    const silent = objectionRow({ customerId: "c1", visitDate: "2026-09-01", objection: null });
    assert.equal(pickLastObjection([older, silent]).has("c1"), false, "the newest visit's answer wins, even when it is nothing");

    // "No objection" is STORED and is a real answer, so it closes an older one and is itself absent —
    // there is nothing to prepare for.
    const none = objectionRow({ customerId: "c1", visitDate: "2026-09-01", objection: "none" });
    assert.equal(pickLastObjection([older, none]).has("c1"), false, "`none` closes an older objection and is never printed");

    // A later real objection replaces an earlier one, in either input order.
    const newer = objectionRow({ customerId: "c1", visitDate: "2026-09-01", objection: "competitor" });
    assert.equal(pickLastObjection([older, newer]).get("c1"), "competitor");
    assert.equal(pickLastObjection([newer, older]).get("c1"), "competitor", "input order cannot change it");

    // Two visits in one day: `capturedAt` breaks the tie.
    const morning = objectionRow({ customerId: "c1", visitDate: "2026-09-01", objection: "price", clock: "09:00" });
    const evening = objectionRow({ customerId: "c1", visitDate: "2026-09-01", objection: "safety", clock: "19:00" });
    assert.equal(pickLastObjection([morning, evening]).get("c1"), "safety");

    // A value a phone one release behind could send is dropped rather than printed as a key.
    assert.equal(pickLastObjection([objectionRow({ customerId: "c1", visitDate: "2026-09-01", objection: "budget" })]).has("c1"), false);
    // A row with no day is not a visit.
    assert.equal(pickLastObjection([{ customerId: "c1", visitDate: "", capturedAt: "x", objection: "price" }]).size, 0);
  }

  // ── 3. Absent, never empty ────────────────────────────────────────────────────────────────────
  {
    const lines = buildCallPrep({ stops: [stop("new", "Dr Carried Over", "PM")], ...NOTHING_KNOWN });
    assert.equal(lines.length, 1, "he is still a stop");
    const [line] = lines;
    assert.equal(line.lastSeenOn, null, "never seen is null, not a date");
    assert.equal(line.objectionLabel, null);
    assert.equal(line.nextStepLabel, null);
    assert.deepEqual(line.products, []);
    assert.equal(line.firstTime, true, "and the screen can say he has not been seen yet");

    // One fact known is enough to stop being a first visit.
    const known = buildCallPrep({
      stops: [stop("c1", "Dr Known", "AM")],
      lastSeen: new Map([["c1", { lastSeenOn: "2026-09-29" }]]),
      products: new Map<string, LastVisitProducts>([["c1", { date: "2026-09-29", products: ["Royanoxicam", "Lacto Advanced"] }]]),
      openNextSteps: new Map([["c1", nextStep("Send the data", "2026-10-07")]]),
      objections: new Map<string, VisitObjection>([["c1", "price"]]),
    })[0];
    assert.equal(known.firstTime, false);
    assert.equal(known.lastSeenOn, "2026-09-29");
    assert.equal(known.objectionLabel, "Price", "the objection is in words, never the stored key");
    assert.equal(known.nextStepLabel, "Send the data");
    assert.equal(known.nextStepDueOn, "2026-10-07");
    assert.deepEqual(known.products, ["Royanoxicam", "Lacto Advanced"]);

    // A stop with no name is never drawn with an id in its place.
    assert.equal(buildCallPrep({ stops: [stop("c1", "", "AM")], ...NOTHING_KNOWN }).length, 0);
  }

  // ── 4. AM before PM, a pharmacy never, and one line per customer ──────────────────────────────
  {
    const ordered = buildCallPrep({
      stops: [stop("p1", "Dr Zaki", "PM"), stop("a1", "Dr Bakr", "AM"), stop("a2", "Dr Amin", "AM")],
      ...NOTHING_KNOWN,
    });
    assert.deepEqual(
      ordered.map((line) => line.customerName),
      ["Dr Amin", "Dr Bakr", "Dr Zaki"],
      "AM first — the call-rate rule keeps the two apart and a day is read in the order it is driven",
    );
    assert.deepEqual(ordered.map((line) => line.listType), ["AM", "AM", "PM"]);

    // 🔴 A PHARMACY IS NEVER PLANNED (owner, 2026-10-02) and carries no KPI, so a row claiming to be
    // one is DROPPED — never widened into the AM/PM union, which is the spelling that filed 26
    // readers' pharmacies among the doctors with nothing going red.
    const withPharmacy = buildCallPrep({ stops: [stop("ph", "El Ezaby", "Pharmacy"), stop("a1", "Dr Amin", "AM")], ...NOTHING_KNOWN });
    assert.deepEqual(withPharmacy.map((line) => line.customerName), ["Dr Amin"], "a pharmacy is not a prep line");
    // It reads the value through `parseListType`, whose documented fallback is PM — so an unrecognised
    // value reads exactly as it did before a third list existed. The stored `list_type` is canonical
    // (`Pharmacy`, the vendor's own spelling) and the import door canonicalises before this is asked,
    // which is why `doctorListType` is the right reader here and a hand-rolled compare is not.
    assert.deepEqual(buildCallPrep({ stops: [stop("x", "Dr X", "something-else")], ...NOTHING_KNOWN })[0].listType, "PM");

    // One customer planned twice in one day is ONE line: two would read as two calls to make.
    const twice = buildCallPrep({ stops: [stop("c1", "Dr Amin", "AM"), stop("c1", "Dr Amin", "PM")], ...NOTHING_KNOWN });
    assert.equal(twice.length, 1);
  }

  // ── 5. The two empty sentences are different on purpose ───────────────────────────────────────
  {
    assert.equal(callPrepEmptyNote({ planSent: true, stops: 3 }), null, "with stops there is no note");
    const notSent = callPrepEmptyNote({ planSent: false, stops: 0 }) ?? "";
    const nobody = callPrepEmptyNote({ planSent: true, stops: 0 }) ?? "";
    assert.ok(notSent.length > 0 && nobody.length > 0);
    assert.notEqual(notSent, nobody, '"the week is not sent" sends him to the Plan screen; "nobody is planned" does not');
    assert.ok(notSent.toLowerCase().includes("not sent"), "and it says which it is");
    for (const note of [notSent, nobody]) assert.ok(!note.includes("…") && !note.includes("..."), "never truncated with an ellipsis");
  }

  // ── 6. READ ONLY, the rep's own seat, the raw table, off the plan-change path ──────────────────
  {
    const server = source("src/lib/phoenix-crm/server/call-prep.ts");
    assert.ok(server.includes("territoryForRepWrite("), "the gate is the rep's own seat — his plan and his own notes");
    assert.ok(server.includes("loadPlannedDay("), "the stops come from the module's own plan door, never a query of its own");
    assert.ok(!server.includes("plannedCustomersOn("), "and never a second door beside it — the day's rule is asked inside loadPlannedDay");
    assert.ok(server.includes("isPlanSentForReview("), "and the day's own standing decides, never the week's status column");
    assert.ok(
      server.includes('.from("phoenix_crm_visits")') && !server.includes("countable_visits"),
      "what the doctor said at a visit waiting on its approval is still what the doctor said",
    );
    assert.ok(server.includes("fetchAllRowsKeyset"), "the visits read is paged");
    // 2026-10-16 performance audit: "what was said last time" and "last seen" are ONE visits read, from
    // the earlier of their two first days with no upper bound, and each cuts its own window back out.
    assert.equal(server.split('.from("phoenix_crm_visits")').length - 1, 1, "the screen reads the visits table once");
    assert.match(
      server,
      /\.select\("id, customer_id, visit_date, captured_at, products, next_step, next_step_on, objection, imported_from_ireports360_at"\)/,
      "with both reads' columns",
    );
    assert.match(
      server,
      /\.gte\("visit_date", lastSaidSince < lastSeenSince \? lastSaidSince : lastSeenSince\),/,
      "from the earlier of the two windows",
    );
    assert.ok(!/\.lte\("visit_date"/.test(server), "and no upper bound, because last seen never had one");
    assert.match(server, /return day >= since && day <= today;/, "the six months, today included, cut back out for what was said");
    assert.match(
      server,
      /loadPlannerInsights\(seatId, isTest, today, customersRead, \{ visitsRead \}\)/,
      "and the same rows handed to the insight, which cuts its own window",
    );
    // The customer list is read for the day's stops alone, and for nobody on a day that is not sent —
    // the rule now sits inside the one planned-day door (visits.ts, 2 Nov 2026), on both of its paths.
    assert.match(server, /const customersRead = dayRead\.then\(\(\{ stops \}\) => stops\);/, "the stops' customers are the planned day's own");
    const plannedDay = source("src/lib/phoenix-crm/server/visits.ts");
    const door = plannedDay.slice(plannedDay.indexOf("export async function loadPlannedDay("), plannedDay.indexOf("export async function plannedCustomersOn("));
    assert.match(door, /customerIds: isPlanSentForReview\(planned\.status\) \? planned\.customerIds : \[\],/, "the fallback reads nobody on a day that is not sent");
    assert.match(
      door,
      /stops: isPlanSentForReview\(planned\.status\) \? foldTerritoryCustomers\(day\.stops\) : emptyTerritoryCustomers\(\)/,
      "and so does the one-statement door",
    );
    // Reuse, not re-derivation: all three picks are the module's own rules.
    for (const reused of ["pickLastVisitProducts(", "pickLastNextStep(", "pickLastObjection(", "loadPlannerInsights(", "buildCallPrep("]) {
      assert.ok(server.includes(reused), `the read composes ${reused} rather than restating it`);
    }
    // 🔴 NOTHING WRITES. A sent week changes only through "Ask to edit this week" (owner, 2026-10-01),
    // and a read-only prep list is exactly where a second door into that one path gets built.
    for (const write of [".insert(", ".update(", ".upsert(", ".delete(", "callPhoenixCrm(", "transitionPlan", "savePlan"]) {
      assert.ok(!server.includes(write), `the call-prep read never writes (${write})`);
    }

    const route = rawSource("app/api/phoenix-crm/call-prep/route.ts");
    assert.ok(!/export async function POST/.test(route), "the route has no POST at all");
    assert.ok(route.includes('assertPermission(access, "phoenix_crm", "read")'), "it asserts the module permission first");

    const panel = source("src/components/phoenix-crm/call-prep-panel.tsx");
    for (const meter of ["CrmStat", "CrmStatGrid", "CrmFillBar", "percentText"]) {
      assert.ok(!panel.includes(meter), `the panel draws no meter (${meter})`);
    }
    for (const write of ["useCrmAction", "crmPost", "onClick"]) {
      assert.ok(!panel.includes(write), `the panel offers no action (${write})`);
    }
    // Golden rule #1: no measurement of any kind reaches this screen.
    for (const measured of ["distance", "locationFlag", "accuracy", "mocked", "integrity"]) {
      assert.ok(!panel.includes(measured), `the rep's prep carries no measurement (${measured})`);
    }
    assert.ok(panel.includes("CrmTable") && panel.includes("CrmCardsOnPhone"), "desktop a table, phone cards");
    assert.ok(panel.includes("dayLabelLong(view.date)"), "the DAY is named, so a Thursday evening never reads 'tomorrow' over a Saturday");
  }

  console.log("phoenix-crm tomorrow's call prep: OK");
}
