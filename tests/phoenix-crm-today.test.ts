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
    assert.ok(body.includes('.select("id, status, version")'), "it reads the status, and the version so the week can be sent from where he stands");
    assert.ok(body.includes("planId: String((plan as Row).id)"), "and hands back the plan it read");
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
    assert.ok(tab.includes("<UnsentWeek onSent={resource.reload} view={view} />"), "the screen says it");
    // 🔴 And it ACTS: the note carries the one tap that sends the week, because until it is sent every
    // one of his own planned customers routes to the out-of-plan reason screen (owner, 2026-09-30).
    const noteAt = tab.indexOf("function UnsentWeek(");
    const note = tab.slice(noteAt, tab.indexOf("\n}", noteAt));
    assert.ok(noteAt >= 0, "the note is one component");
    assert.ok(note.includes('action: "submit"'), "one tap sends it");
    assert.ok(note.includes("Send this week"), "and says so in his own words");
    assert.ok(!/useEffect|setTimeout/.test(note), "nothing sends it for him");
    assert.ok(note.includes("if (!view.unsentNote) return null;"), "a sent week shows nothing at all");
    // It is a note, never a gate: nothing about the draft may disable Add visit or the rows.
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

  // ── ADD VISIT ON A DRAFT DAY NEVER ACCUSES HIM OF GOING OFF PLAN (owner, 2026-09-30) ───────────
  //
  // His own words, on the day Today started showing a draft: "when I press add visit on any one of
  // them from today, it redirects me to out of plan — how come?" Both halves were behaving as written:
  // Today shows the day he planned whatever the plan's status, and a visit counts as PLANNED only
  // against a plan that reached review BEFORE the visit's server-issued captured_at. Between them,
  // every one of his sixteen planned customers landed on the out-of-plan reason screen — a written
  // reason, then his manager, then the SFE, for keeping his own plan open.
  //
  // 🔴 THE COUNTING RULE DOES NOT MOVE. `plannedToday` still means a SENT plan, and `routeFor` still
  // sends anyone genuinely off the plan to the reason screen. What changed is that a customer on his
  // OWN UNSENT DRAFT gets the one tap that sends the week, after which the visit is planned for real.
  {
    const visits = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/visits.ts", import.meta.url), "utf8"));
    const tab = stripCommentsCompact(readFileSync(new URL("../src/components/phoenix-crm/visits-tab.tsx", import.meta.url), "utf8"));
    const picker = stripCommentsCompact(readFileSync(new URL("../src/components/phoenix-crm/visit-customer-picker.tsx", import.meta.url), "utf8"));

    // The two sets are read by two different functions and must stay apart.
    assert.ok(visits.includes("plannedTodayUnsent: !planned.has(customerId) && draftToday.has(customerId),"), "the draft set is separate from the sent set");
    assert.ok(visits.includes("const draftToday = draftPlan.sent ? new Set<string>() : new Set(draftPlan.customerIds);"), "and is empty once the week is sent");

    // 🔴 The half that must never loosen: what COUNTS still requires a sent plan.
    const counting = visits.indexOf("async function plannedCustomerIds");
    const countingBody = visits.slice(counting, visits.indexOf("\n}", counting));
    assert.ok(countingBody.includes('.in("status", ["submitted", "approved"])'), "plannedCustomerIds keeps its status filter");
    assert.ok(!countingBody.includes("draftToday"), "and knows nothing about the draft");

    // The route: four branches, in this order, and the draft one sits BEFORE the reason screen.
    const route = tab.slice(tab.indexOf("function routeFor("), tab.indexOf("\n}", tab.indexOf("function routeFor(")));
    assert.ok(route.includes('if (customer.outside) return { name: "form"'), "outside the list goes to the form");
    assert.ok(route.includes('if (customer.plannedToday) return { name: "form"'), "a sent plan goes to the form as planned");
    assert.ok(route.includes('if (customer.plannedTodayUnsent) return { name: "send_week"'), "his own draft offers to send the week");
    assert.ok(route.includes('return { name: "reason"'), "and anyone genuinely off the plan still gives a reason");
    assert.ok(
      route.indexOf("plannedTodayUnsent") < route.indexOf('return { name: "reason"'),
      "the draft branch must come BEFORE the reason screen, or the trap is still there",
    );
    assert.ok(
      route.indexOf("customer.plannedToday)") < route.indexOf("customer.plannedTodayUnsent"),
      "a sent plan wins over a draft, so a sent week never detours through the send screen",
    );

    // The screen sends nothing on his behalf, and never dead-ends him.
    // 🔴 Sliced to the NEXT export, never to the first newline-brace — that one lands on the props
    // block’s own "}) {" and cuts the JSX out of the slice, so every assertion about the SCREEN reads
    // the props instead and passes. It did exactly that when this was first written.
    const screenAt = picker.indexOf("export function SendWeekFirst(");
    assert.ok(screenAt >= 0, "the screen is its own exported component");
    const screen = picker.slice(screenAt, picker.indexOf("export function OutOfPlanReason(", screenAt));
    assert.ok(screen.includes("</CrmBlock>"), "and the slice reaches its JSX, or nothing below is testing the screen");
    assert.ok(screen.includes("onSend"), "he presses it himself");
    // 🔴 The ESCAPE, checked by its own button and not by the prop — a prop left in the signature with
    // the button deleted reads exactly like a working escape, and did when this was first written.
    assert.ok(screen.includes("onClick={onOutOfPlan}"), "and can always go off-plan instead");
    assert.ok(screen.includes("Log it off the plan instead"), "in words he can find on the screen");
    assert.ok(!/useEffect|autoSend|setTimeout/.test(screen), "nothing sends the week for him");
    assert.doesNotMatch(screen, /distance|accuracy|flag|integrity/i, "and nothing on it judges him");

    // Sending it opens the form as PLANNED — that is the whole point of the detour.
    const step = tab.slice(tab.indexOf('case "send_week":'), tab.indexOf('case "reason":'));
    assert.ok(step.includes('action: "submit"'), "it sends the week");
    assert.ok(step.includes('visitType: "planned"'), "and then the visit is planned");
    assert.ok(step.includes('name: "reason"'), "declining still reaches the reason screen");
    assert.ok(step.includes("resource.reload()"), "and the form is re-read so plannedToday is true");
  }

  console.log("phoenix-crm today: OK");
}
