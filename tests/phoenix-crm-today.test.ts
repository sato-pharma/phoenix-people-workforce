import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripCommentsCompact } from "./support/comment-strip.ts";

import { customerMetaText, gradeSpecialityParts, gradeSpecialityText } from "../src/components/phoenix-crm/labels.ts";

import { isPlanSentForReview } from "../src/lib/phoenix-crm/plan-rules.ts";
import {
  addressWithoutTheBrick,
  buildTodayStops,
  compareTodayStops,
  NO_HOURS_YET,
  NO_PLACE_YET,
  planStatusNote,
  stopWhereLine,
  stopWhereParts,
  todayByBrick,
  todayEmptyReason,
  todayPharmacies,
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
    assert.deepEqual(
      built.counts,
      { plannedAm: 1, plannedPm: 2, doneAm: 1, donePm: 1, extraAm: 0, extraPm: 0, donePharmacies: 0 },
      "seven figures, never a total — the pharmacies apart from both lists, and the off-plan work apart from the plan's own",
    );

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
    assert.equal(todayEmptyReason({ status: "approved", isFieldDay: false, stops: 0 }), "Today is not a field day.");
    assert.match(String(todayEmptyReason({ status: null, isFieldDay: true, stops: 0 })), /No plan has been sent/);
    // 🔴 ONE SENTENCE, NEVER TWO: Today shows the APPROVED plan only, so an unapproved plan ALWAYS
    // has zero stops — this reason and the plan’s status note therefore always fired together and the
    // screen carried both. The note IS the reason now.
    assert.match(String(todayEmptyReason({ status: "submitted", isFieldDay: true, stops: 0 })), /still pending approval/);
    assert.match(String(todayEmptyReason({ status: "draft", isFieldDay: true, stops: 0 })), /has not been sent yet/);
    assert.match(String(todayEmptyReason({ status: "returned", isFieldDay: true, stops: 0 })), /sent back to you/);
    assert.equal(todayEmptyReason({ status: "approved", isFieldDay: true, stops: 0 }), "Nobody is planned for today.");
    assert.equal(todayEmptyReason({ status: "approved", isFieldDay: true, stops: 3 }), null, "a day with stops says nothing at all");
    assert.equal(todayEmptyReason({ status: null, isFieldDay: true, stops: 3 }), null, "stops outrank every reason");
  }

  // ── TODAY SHOWS THE APPROVED PLAN, AND NOTHING ELSE (owner, 2026-09-30) ────────────────────────
  //
  // His own words, overruling the same day's earlier attempt: "what appears in the today tab is the
  // approved plan — the approved plan ONLY. If not approved, show that the plan is still pending
  // approval." Today had briefly shown the day for a plan in any state, with a button to send it from
  // here; both are gone. Today is the day he has been CLEARED to work.
  //
  // 🔴 AND THIS IS WHAT CLOSES THE OUT-OF-PLAN TRAP HE FOUND — by construction, not by a special case.
  // Every customer Today can show sits on an APPROVED plan, and `plannedCustomerIds` counts
  // submitted AND approved, so approved is a SUBSET of what the server counts as planned: the visit
  // route cannot reach the out-of-plan reason screen from a Today row at all.
  {
    const visits = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/visits.ts", import.meta.url), "utf8"));
    const loader = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/today.ts", import.meta.url), "utf8"));

    // Today's reader reports the STATUS and never decides for itself.
    const start = visits.indexOf("export async function plannedCustomersOn");
    assert.notEqual(start, -1, "plannedCustomersOn is exported");
    const body = visits.slice(start, visits.indexOf("\n}", start));
    assert.ok(body.includes("status: PhoenixCrmPlanStatus | null"), "it hands back the status");
    assert.ok(!body.includes('.in("status"'), "and filters nothing itself");

    // The loader shows stops for an APPROVED plan only.
    assert.ok(loader.includes('const approvedIds = planned.status === "approved" ? planned.customerIds : [];'), "the approved plan only");
    assert.ok(loader.includes("for (const customerId of approvedIds) {"), "and the stops are built from it");
    assert.ok(!/for \(const customerId of planned\.customerIds\)/.test(loader), "never from the plan's rows regardless of status");
    assert.ok(loader.includes("status: planned.status,"), "and the empty reason names which state an unapproved plan is in");

    // 🔴 The counting reader is still wider than Today, which is what makes the trap impossible:
    // approved ⊂ {submitted, approved}. Since 2026-10-01 the form narrows the SAME read rather than
    // running a second one behind `.in("status", …)` — it needs the status itself now, to say why
    // Planned has nobody to offer — so the filter is a named predicate at the call site.
    assert.match(
      visits,
      /isPlanSentForReview\(planDay\.status\) \? planDay\.customerIds : \[\]/,
      "what COUNTS as planned still takes either",
    );
    assert.ok(isPlanSentForReview("submitted") && isPlanSentForReview("approved"), "and that predicate takes both");
    for (const status of ["draft", "returned", null] as const) {
      assert.equal(isPlanSentForReview(status), false, `${status ?? "no plan row"} is the rep's own to edit, so it is never authority`);
    }

    // Each status earns its own sentence. `submitted` is his wording; the other two are named as
    // themselves, because "pending approval" would be untrue of a plan nobody has yet.
    assert.equal(planStatusNote("approved"), null, "an approved plan says nothing — the day speaks");
    assert.equal(planStatusNote(null), null, "and no plan at all is the empty reason's job, not this one");
    assert.match(String(planStatusNote("submitted")), /still pending approval/, "his own words for a plan waiting on someone");
    assert.match(String(planStatusNote("draft")), /has not been sent yet/, "a draft is not pending anything");
    assert.match(String(planStatusNote("returned")), /sent back to you/, "and a returned plan is waiting on HIM");
    for (const status of ["draft", "submitted", "returned"] as const) {
      assert.doesNotMatch(String(planStatusNote(status)), /Send this week/, "the sending lives on Plan, never here");
    }

    // The screen says it, and offers no way to send from here.
    // 🔴 THERE IS NO TODAY SCREEN ANY MORE (owner, 2026-09-30) — the rule is read by the rep's
    // LANDING panel, which renders nothing at all when there is no approved day, so an unapproved
    // plan shows no panel rather than a sentence in a box.
    const panel = stripCommentsCompact(readFileSync(new URL("../src/components/employee-portal/rep-today-plan-panel.tsx", import.meta.url), "utf8"));
    assert.ok(panel.includes("if (!plan) return null;"), "no day, no panel — never an empty square");
    assert.ok(!panel.includes("plans/submit"), "and the panel never sends a plan");
    assert.ok(!/Send this week/.test(panel), "nor offers to");

    // Nor does Add visit: the step that sent an unapproved week is gone from the flow.
    const flow = stripCommentsCompact(readFileSync(new URL("../src/components/phoenix-crm/visits-tab.tsx", import.meta.url), "utf8"));
    assert.ok(!flow.includes("send_week"), "no send-the-week step");
    assert.ok(!flow.includes("plans/submit"), "and Add visit never sends a plan either");
    const route = flow.slice(flow.indexOf("function routeFor("), flow.indexOf("\n}", flow.indexOf("function routeFor(")));
    assert.ok(route.includes('if (customer.plannedToday) return { name: "form"'), "an approved customer goes straight to the form");
    assert.ok(route.includes('return { name: "reason"'), "and someone genuinely off the plan still gives a reason");
    assert.ok(!route.includes("plannedTodayUnsent"), "with no draft branch left");
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

    // 🔴 The rep's day renders the line as its PARTS, each in an isolate of its own — joined, an
    // Arabic place scrambled the hours beside it ("AM – 1:00 PM 9:00 · عيادة النور"). The parts are
    // the line's own, in its order, so the joined line and the rendered one can never disagree.
    assert.deepEqual(stopWhereParts(validated, "باجور"), ["Dr Nabil's clinic", "باجور", "9:00 AM – 1:00 PM"], "the place, the brick, the hours — each apart");
    assert.deepEqual(stopWhereParts(pending, null), ["Menoufia 2", "سرس", NO_HOURS_YET]);
    assert.deepEqual(stopWhereParts(bare, null), [NO_PLACE_YET], "and nothing known is still one part, never none");
    for (const [stop, brick] of [[validated, "باجور"], [validated, null], [pending, "باجور"], [pending, null], [bare, null]] as const) {
      assert.equal(stopWhereLine(stop, brick), stopWhereParts(stop, brick).join(" · "), "the joined line is exactly its parts");
    }

    // The brick is taken from the reference too, so an unvalidated customer clusters with his own
    // brick-mates instead of falling into a nameless group at the end of the day.
    const loader = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/server/today.ts", import.meta.url), "utf8"));
    assert.ok(loader.includes("brick: place?.brickName ?? reference?.brick ?? null,"), "the brick falls back to the reference");
    assert.ok(loader.includes("loadPlannerReferences("), "and the loader fetches them");
    assert.ok(loader.includes("const reference = place ? null : (references.get(customerId) ?? null);"), "a validated customer never reads the reference");
  }

  // ── WHAT THE APP OPENS ON, NOW THAT TODAY IS RETIRED ───────────────────────────────────────────
  //
  // 🔴 The module opened on Today and the Super Admin's bar carried eight tabs. Both are gone: the
  // owner retired Today from Phoenix CRM on 2026-09-30 (its replacement is the rep's landing panel),
  // and the portal's modules are separate pages with no bar at all. A manager with a decision waiting
  // still has to reach Team first, which is what this keeps.
  {
    const app = stripCommentsCompact(readFileSync(new URL("../src/components/phoenix-crm/phoenix-crm-app.tsx", import.meta.url), "utf8"));
    const rules = stripCommentsCompact(readFileSync(new URL("../src/lib/phoenix-crm/opening-tab.ts", import.meta.url), "utf8"));
    const start = rules.indexOf("function openingTab(");
    assert.notEqual(start, -1);
    const body = rules.slice(start, start + 800);
    assert.notEqual(body.indexOf('decisions > 0) return "team"'), -1, "the Team branch is still there");
    assert.ok(!body.includes('return "today"'), "and nothing opens on Today any more");

    const order = /const TAB_ORDER: readonly TabKey\[\] = \[([^\]]+)\]/.exec(rules)?.[1] ?? "";
    // NINE since the CNS daily forecast became its own tab on his word (2026-10-01), after the team
    // calendar (2026-09-30) — Today left and neither of them is Today creeping back. TEN since the Super
    // Admin's own Test accounts tab (owner, 2026-10-22). TAB_COLUMNS carries a 10 rule.
    assert.equal(order.split(",").length, 10, "TAB_ORDER and TAB_COLUMNS must agree, or the bar has no grid at its own width");
    assert.ok(app.includes('10: "grid-cols-2 sm:grid-cols-5"'), "ten tabs have their own grid");
    assert.ok(!order.includes('"today"'), "🔴 Today is not a tab — do not add it back; its replacement is RepTodayPlanPanel");
    assert.ok(app.includes('7: "grid-cols-3 sm:grid-cols-4 lg:grid-cols-7"'), "seven tabs have their own grid");
    assert.ok(!app.includes("today-tab"), "and the retired screen is gone from the shell");
  }

  // ── The screen shows him nothing that judges him ────────────────────────────────────────────────
  //
  // This is the assertion that stops Today quietly becoming the place the distances live: it is the
  // rep's most-opened screen, which makes it the most tempting one.
  {
    for (const path of ["src/lib/phoenix-crm/server/today.ts", "src/lib/phoenix-crm/today-rules.ts", "src/components/employee-portal/rep-today-plan-panel.tsx"]) {
      const code = source(path);
      for (const word of [/distance/i, /accuracy/i, /\bfar\b/i, /spread/i, /integrity/i, /\bflagg?ed\b/i, /suspic/i]) {
        assert.equal(word.test(code), false, `${path} must not carry ${word} onto the rep's own day`);
      }
    }
  }

  // ── THE REP'S LANDING PANEL — WHAT REPLACED TODAY (owner, 2026-09-30) ──────────────────────────
  //
  // 🔴 His own spec, retiring the module: "you will retire it from Phoenix CRM, and make something
  // like it — of course NOT a big tool like this — in the rep's landing page. For example you put the
  // BRICKS as headers, if MORE THAN ONE brick, and under each brick the customers planned to be
  // visited today. When he has visited one it is coloured GREEN; if not visited it is not coloured.
  // And a very small PLUS sign that redirects him to enter a visit for that person."
  //
  // 🔴 AND THEN, ON SEEING THE FIRST ATTEMPT: "it became AWFUL like this. Find a way to put it to be
  // CONTRASTING and PREMIUM POLISHED with the current overview. I recommend that you remove the Early
  // Birds and the My Tools, and put the doctors in a premium polished, in their place." So the panel
  // may NOT carry a look of its own: it takes the column those two held and wears the chrome of the
  // panels it sits beside. That is what the borrowed-vocabulary block below pins — a one-off style
  // here is the exact defect he was looking at.
  //
  // So this pins the four things he named, the borrowed chrome, and the page rules the panel inherits.
  {
    const panel = source("src/components/employee-portal/rep-today-plan-panel.tsx");
    const centre = source("src/components/employee-portal/portal-command-center.tsx");
    const landing = source("src/lib/phoenix-crm/server/rep-landing.ts");

    // 1. Bricks as headers, ONLY when there is more than one.
    assert.ok(panel.includes("const showBrickHeadings = plan.bricks.length > 1;"), "bricks head the list only when there is more than one");
    assert.ok(panel.includes("{showBrickHeadings ? <BrickHeading brick={brick} /> : null}"), "and the header is conditional on it");
    // 🔴 And the brick is said ONCE. Neither it nor the area goes on a row (owner, 2026-09-30: "you
    //    don't have to write Menoufia … and the Bagour is duplicated"): the area is his own
    //    territory, and the brick is a heading, or the header's word on a single-brick day.
    assert.ok(
      landing.includes("address: addressWithoutTheBrick(stop.reference.address, stop.brick), area: null"),
      "the area is dropped from every row, and an address that merely repeats the brick with it",
    );
    assert.ok(!landing.includes("stopWhereLine(stop,"), "and the brick is never passed to the where-line");
    assert.ok(landing.includes("where: stopWhereParts("), "the row carries the line's parts, for the panel to isolate");
    assert.ok(!landing.includes("stopWhereParts(stop,"), "and the brick is never passed to them either");
    // The rule itself, by behaviour: the brick is dropped only when the address OPENS with it.
    assert.equal(addressWithoutTheBrick("الباجور، سبك الضحاك", "باجور"), "سبك الضحاك", "the leading town goes, the village stays");
    assert.equal(addressWithoutTheBrick("الباجور", "باجور"), null, "an address that is only the brick leaves nothing");
    assert.equal(addressWithoutTheBrick("جروان الباجور", "باجور"), "جروان الباجور", "a place that merely CONTAINS the brick is a different place and is kept");
    assert.equal(addressWithoutTheBrick("طنطا، سجر", "باجور"), "طنطا، سجر", "another town is never dropped");
    assert.equal(addressWithoutTheBrick(null, "باجور"), null);
    assert.equal(addressWithoutTheBrick("الباجور", null), "الباجور", "with no brick nothing is dropped");
    assert.ok(
      landing.includes("soleBrick: groups.length === 1 ? (view.stops[0]?.brick ?? null) : null,"),
      'a one-brick day names the brick from the STOP, not the group label — that label is "Brick <name>", and the header read "WED 30 SEPT · BRICK باجور"',
    );
    assert.ok(panel.includes("{plan.soleBrick ? `${plan.dateLabel} · ${plan.soleBrick}` : plan.dateLabel}"), "and a one-brick day still says where he is");

    // 2. Green when visited, nothing when not — carried by a tick as well as the colour, so it
    //    survives a grey screenshot and a colour-blind reader.
    assert.match(panel, /stop\.done \? "bg-emerald-50" : "bg-white"/, "a visited customer is green");
    assert.match(panel, /stop\.done \? "bg-emerald-500" : "bg-slate-200"/, "and one not visited carries no colour at all — its rail is neutral slate");
    assert.ok(panel.includes('<Check aria-hidden="true"'), "the tick says it too");

    // 3. The very small plus, into Add visit on that person.
    assert.ok(panel.includes("function addVisitHref(stop: RepTodayStop)"), "the plus has one address");
    assert.match(panel, /\?customer=\$\{encodeURIComponent\(stop\.customerId\)\}/, "which names the customer");
    assert.ok(panel.includes('phoenixCrmModulePath(PHOENIX_CRM_PORTAL_BASE, "visits")'), "and points at the Visits module's own page");
    assert.equal((panel.match(/h-7 w-7 shrink-0/g) ?? []).length, 2, "very small, and the tick that replaces it is the same size");
    assert.ok(panel.includes('<Plus aria-hidden="true"'), "and it is a plus sign");
    assert.ok(panel.includes("stop.done ? ("), "no plus on one he has already done — a tick stands there instead");

    // 4. 🔴 AM · PM · PHARMACIES, THREE FIGURES APART, never summed. Two golden rules meet in this
    //    one header: the call rate is scored AM against 2 and PM against 10, and a pharmacy is
    //    counted apart from both. The third chip is HIS OWN ASK of that morning — "show me my today
    //    plan am/pm/ph" — which outlived the Today module it was built for: when Today was retired
    //    that evening the figure lost its screen, and he put it back here (2026-09-30).
    assert.ok(panel.includes('<CountChip done={plan.amDone} label="AM" planned={plan.amPlanned} />'));
    assert.ok(panel.includes('<CountChip done={plan.pmDone} label="PM" planned={plan.pmPlanned} />'));
    assert.ok(
      panel.includes('<CountChip done={plan.pharmaciesDone} label="Pharmacies" />'),
      'the pharmacies chip carries NO planned figure — a pharmacy is feedback recorded ON a visit, so there is nothing to plan against one and no "n of m" to print',
    );
    assert.ok(
      landing.includes("pharmaciesDone: view.counts.donePharmacies,"),
      "and the figure is the day's own pharmacy count, never a second derivation on the panel",
    );
    assert.equal(/(am|pm)(Done|Planned)\s*\+\s*[\w.]*(am|pm)(Done|Planned)/i.test(panel), false, "AM and PM are never added into one figure");
    assert.equal(
      /pharmaciesDone\s*\+|\+\s*[\w.]*pharmaciesDone/i.test(panel),
      false,
      "🔴 and a pharmacy is never added into either of them — the AM · PM · Pharmacies golden rule",
    );

    // 4b. 🔴 THE GRADE AND THE SPECIALITY ON EVERY ROW. Recording the old CRM on 2026-09-29, the
    //     owner opened on its dashboard, which "shows him my visits of today, with the specialities,
    //     with the grades" — and this panel printed only the name and the place. They come off the
    //     day's own stops (never a second read), and they sit on a line of their own between the name
    //     and the place: folded into the place line, two Arabic parts joined by " · " swap on screen.
    assert.ok(landing.includes("grade: stop.grade ?? null,"), "every row carries the stop's own grade — a missing one is no grade, never undefined");
    assert.ok(landing.includes("speciality: stop.speciality,"), "and its own speciality");
    const nameAt = panel.indexOf("{stop.name}");
    const identityAt = panel.indexOf("parts={gradeSpecialityParts(stop)}");
    const whereAt = panel.indexOf("parts={stop.where}");
    assert.ok(identityAt > 0, "the row prints the grade and the speciality");
    assert.ok(nameAt < identityAt && identityAt < whereAt, "on their own line, after the name and before the place");
    assert.ok(
      !panel.includes("customerMetaText("),
      "and WITHOUT the AM or PM that customerMetaText opens with — the row's own column already says it, so it would print twice",
    );

    // 4c. 🔴 ONE DIRECTION PER ROW, AND EVERY PART ISOLATED. Measured on the first cut: with a `dir`
    //     on each line, an Arabic name and place hugged the right edge while "Grade B" between them
    //     hugged the left; and joined into one string, an Arabic place split the hours from their AM
    //     ("AM – 1:00 PM 9:00 · عيادة النور"). So the block takes its direction from the NAME, once,
    //     and every part of both lines sits in its own <bdi>.
    const row = panel.slice(panel.indexOf("function StopRow("), panel.indexOf("function BrickHeading("));
    assert.ok(row.includes('<span className="min-w-0 flex-1" dir="auto">'), "the row's text takes one direction, from its first letter — the name's");
    assert.equal((row.match(/dir="auto"/g) ?? []).length, 1, "and no line inside the row sets a direction of its own");
    assert.ok(panel.includes("<bdi>{part}</bdi>"), "each part is isolated, so a mixed line keeps every part's own order");
    assert.ok(panel.includes('{index > 0 ? " · " : null}'), "joined by the module's own separator, which runs in the row's direction");
    assert.deepEqual(gradeSpecialityParts({ grade: "B", speciality: "طب الأطفال" }), ["Grade B", "طب الأطفال"], "the grade and an Arabic speciality are two parts");
    assert.deepEqual(gradeSpecialityParts({ grade: null, speciality: null }), ["No grade"], "and a bare customer is still one part, never none");

    // The words are the module's own, so this row reads exactly as the rest of Phoenix CRM does.
    assert.equal(gradeSpecialityText({ grade: "A", speciality: "Paediatrics" }), "Grade A · Paediatrics");
    assert.equal(gradeSpecialityText({ grade: null, speciality: "Paediatrics" }), "No grade · Paediatrics", "an ungraded customer says so");
    assert.equal(gradeSpecialityText({ grade: "B", speciality: null }), "Grade B", "no speciality leaves no dangling separator");
    assert.equal(gradeSpecialityText({ grade: null, speciality: null }), "No grade", "and the line is never empty");
    assert.equal(
      customerMetaText({ grade: "B", listType: "PM", speciality: "Internal Medicine" }),
      "PM · Grade B · Internal Medicine",
      "the full line every other screen prints is unchanged by sharing its second half",
    );
    assert.equal(customerMetaText({ grade: null, listType: "AM", speciality: null }), "AM · No grade");

    // 5. 🔴 THE CHROME IS BORROWED, NOT INVENTED — every piece of it is lifted from the panels it now
    //    sits beside. `RepPanel`, `RepNeedRow` and the chip live in portal-command-center.tsx, which
    //    imports THIS file, so they cannot be imported back (a cycle) and are written out instead.
    //    These comparisons are what stops the two copies drifting into two looks.
    for (const [what, shape] of [
      // The shell took `adminSoftDepthClassName` in the portal's premium-depth pass (2026-10-09),
      // which is why the shape is a template and not a quoted literal. The comparison is the point
      // and is unchanged: BOTH copies must wear it, so a pass that lights one and forgets the
      // other still fails here.
      ["the panel shell", 'className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}'],
      ["the panel title", 'className="text-phx-xs font-bold uppercase tracking-[0.09em] text-slate-600"'],
      ["the header chip", "border px-1.5 py-px text-phx-2xs font-bold uppercase tracking-[0.06em] tabular-nums"],
      ["the row rail", 'className={`w-1 self-stretch'],
    ] as const) {
      assert.ok(panel.includes(shape), `the panel must wear the overview's own ${what}: ${shape}`);
      assert.ok(centre.includes(shape), `and the overview must still be the source of ${what} — if it changed there, change it in the panel too`);
    }

    // 🔴 THE HEADER IS THE ONE PIECE THAT PARTS FROM THE OVERVIEW'S, BY EXACTLY ONE CLASS. The chip
    // rail is `shrink-0`, which makes its own `flex-wrap` inert, so the THIRD chip put 319px of
    // content into a 284px header at 320px and the panel scrolled sideways — which the
    // fits-the-screen golden rule forbids outright, and wrapping is the remedy it names. Measured
    // 2026-09-30: identical at 360, 375, 390 and 412, where the chips already fit on one line.
    //
    // The panel's string is DERIVED from the overview's here rather than written out, so this is
    // still the drift guard the loop above is: change the header in portal-command-center.tsx and
    // this goes red until the panel follows.
    const centreHeader = 'className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2"';
    assert.ok(centre.includes(centreHeader), "the overview must still be the source of the panel header");
    assert.ok(
      panel.includes(centreHeader.replace("flex items-center", "flex flex-wrap items-center")),
      "the panel header must be the overview's, plus flex-wrap — without it the third chip overflows the panel at 320px",
    );
    assert.ok(!panel.includes("@/components/employee-portal/portal-command-center"), "and it is NEVER imported from there — that is the cycle this duplication exists to avoid");

    // The landing page's own rules: no empty square, and nothing that judges him.
    assert.ok(panel.includes("if (!plan) return null;"), "no day, no panel — never the empty square he has sworn at");
    // The COLUMN goes with it: a 1fr grid track holding nothing is that same empty square.
    // Since 2026-11-01 his day fills under Suspense, so the condition moved into the CSS: the split
    // holds only while the row has a child marked as the day's column.
    assert.ok(centre.includes("@3xl:has-[>[data-rep-day]]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"), "and the two-column split collapses when there is no day");
    assert.ok(/async function RepDayColumn[\s\S]{0,160}if \(!day\) return null;/.test(centre), "a day that answers null removes the column, marker and all");
    // 🔴 THE FOUR KPI TILES STACK 2x2 WHENEVER THE DAY IS BESIDE THEM, AND THE CONDITION IS THE DAY,
    //    NEVER A WIDTH. He asked for this stack twice on 2026-09-30 — the second time because the
    //    first fix leant on `@3xl:grid-cols-4` and a container query, which was MEASURED not to hold:
    //    the wrapper is a real `inline-size` container 721px wide, inside 48rem, and the row still
    //    rendered four 219px tracks, so on a wide screen the tiles went back across the top and his
    //    left column finished 143px short of the day. Re-introducing any width query here puts the
    //    asymmetry back on the one screen he actually works on.
    assert.ok(
      centre.includes('"grid grid-cols-2 gap-2 @3xl:grid-cols-4 group-has-[>[data-rep-day]]/rep-day:grid-cols-2"'),
      "the KPI tiles are 2x2 whenever there is a day beside them, and four across only when there is not",
    );
    assert.ok(
      !/@[\w-]+:group-has-\[>\[data-rep-day\]\]/.test(centre),
      "the 2x2 override carries no width query — the condition is the day, never a width",
    );
    assert.ok(
      !centre.includes('"grid grid-cols-2 gap-2 @3xl:grid-cols-4"'),
      "and the unconditional four-across form must not come back — that is the exact string that shipped the asymmetry",
    );
    assert.doesNotMatch(panel, /distance|accuracy|integrity|flag|far from/i, "and nothing on it judges him (golden rule #1)");
    assert.doesNotMatch(panel, /rounded(?!-none)/, "square corners, written out");
    assert.doesNotMatch(panel, /…|truncate/, "and nothing is cut off");

    // 🔴 A VISIT LOGGED FROM THE PANEL'S "+" TURNS THAT ROW GREEN WHEN HE COMES BACK (owner,
    //    2026-09-30: "if it is submitted from those visits in the overview landing page, it is
    //    automatically marked as done"). It was already true of a FRESH request — `done` is read
    //    from the day's saved visits — and FALSE of the one navigation a rep actually makes:
    //    forward from the "+", then Back, which the router answers out of its own cache. Measured
    //    that day on the preview box: the row stayed white, the "+" stayed, and the header still
    //    read "AM 0 of 1" over a visit that was already in the database.
    const form = source("src/components/phoenix-crm/visit-log-form.tsx");
    assert.ok(form.includes("router.refresh();"), "a saved visit must empty the router cache, or Back shows him the day as it stood before he logged it");
    assert.ok(
      form.indexOf("router.refresh();") > form.indexOf('crmPost<SavedVisit>("/api/phoenix-crm/visits"'),
      "and only once the visit is actually saved",
    );
    // 🔴 The server-side cure was TRIED AND MEASURED NOT TO WORK: the landing page is force-dynamic,
    //    so there is no server cache to invalidate. Re-adding it would look like the fix and be one
    //    more thing to unpick the next time this row goes stale.
    assert.ok(
      !source("app/api/phoenix-crm/visits/route.ts").includes("revalidatePath("),
      "the save route must not call revalidatePath — it does nothing for a force-dynamic page, and it is not what turns the row green",
    );

    // 🔴 EARLY BIRDS IS RETIRED FROM THE MEDICAL REP'S PAGE ONLY — his own scope, the same day:
    // "retire early bird only from med rep accounts". Every other centre keeps the card.
    assert.ok(!centre.includes("<EarlyBirdOfTheFortnightCard"), "the rep's landing page no longer draws the Early Bird card");
    for (const other of [
      "src/components/admin/ceo-phase-b.tsx",
      "src/components/employee-portal/dashboards/dsm-command-center.tsx",
      "src/components/employee-portal/dashboards/rm-command-center.tsx",
      "src/components/employee-portal/dashboards/nsm-command-center.tsx",
      "src/components/employee-portal/dashboards/marketing-manager-command-center.tsx",
    ]) {
      assert.ok(
        source(other).includes("<EarlyBirdOfTheFortnightCard"),
        `${other}: the Early Bird card must STAY. The owner retired it from the medical rep's page alone — "only from med rep accounts" — so do not follow that removal through to this one.`,
      );
    }

    // The loader never throws onto the landing page, and reads HIS OWN territory.
    const loader = source("src/lib/phoenix-crm/server/rep-landing.ts");
    assert.ok(loader.includes("const [own] = viewer.ownTerritories;"), "his own territory, not a manager's board");
    assert.ok(loader.includes("if (view.stops.length === 0) return null;"), "no stops, no panel");
    assert.match(loader, /catch \(error\) \{/, "and a failed read never takes the landing page down with it");
    // The day's own date is on the panel BECAUSE of the 02:00 rule, and is formatted as UTC so a
    // Cairo calendar day is never shifted back one by the runtime's zone.
    assert.ok(loader.includes('timeZone: "UTC",'), "the day label is formatted as UTC — it is a calendar day, not an instant");

    // It is wired in, for the rep and through the one switch.
    assert.ok(centre.includes("<RepDayColumn plan={repTodayPlan} />"), "the rep's landing page draws it");
    assert.ok(centre.includes("<RepTodayPlanPanel plan={day} />"), "through the panel");
    const home = source("app/employee-portals/page.tsx");
    // Loaded BESIDE the home snapshot, not after it (2026-10-01, "slow to transfer between page and
    // page"): started first, awaited once the snapshot is in. It never rejects, which is what makes
    // leaving it running safe when the snapshot fails.
    // For the rep only (2026-10-31): his is the one landing that draws the panel.
    const started = home.indexOf("const repTodayPlanPromise =");
    assert.ok(
      /const repTodayPlanPromise =\s*\(access\.role \?\? ""\)\.toLowerCase\(\) === "medical rep" \? loadRepTodayPlan\(access\) : Promise\.resolve\(null\);/.test(home),
      "the day is read for the Medical Rep, the one landing that draws it",
    );
    // The prefix only: the call also carries the rep's picked keycard month (#5005).
    const snapshot = home.indexOf("snapshot = await getPortalHomeSnapshot(access");
    assert.ok(started !== -1, "and the page loads it");
    assert.ok(snapshot !== -1 && started < snapshot, "starting it before the home snapshot is awaited, so the two run together");
    // 🔴 AND NEVER WAITING FOR IT AT ALL (2026-11-01, "fix the portal home slow opens"): his day is the
    // slowest read on the landing, so an await here holds the rep's whole page behind one panel.
    assert.ok(!home.includes("await repTodayPlanPromise"), "the page never waits for his day");
    assert.ok(home.includes("repTodayPlan={repTodayPlanPromise}"), "it hands the read over still running");
    const suspended = centre.indexOf("<RepDayColumn plan={repTodayPlan} />");
    assert.ok(centre.lastIndexOf("<Suspense", suspended) > centre.lastIndexOf("</Suspense>", suspended), "and his day fills under its own Suspense");
    assert.ok(/data-rep-day="">\s*<RepPanelLoading title="Your day" \/>/.test(centre), "marked as the day's column while it loads, so the row keeps its shape");
  }

  // ── AM · PM · PHARMACIES — the rule the third chip prints ───────────────────────────────────────
  //
  // 🔴 A PHARMACY IS NEVER A STOP OF ITS OWN. It is feedback recorded ON a visit
  // (`phoenix_crm_visits.pharmacy_name`) — a customer's list type is AM or PM and nothing else — so
  // there is nothing to plan against one and no "Add visit" for one. It is the day's pharmacy work
  // read back, counted APART: never inside doneAm or donePm, whatever the vendor tagged.
  //
  // This block was written for the Today module and travelled with the figure when he moved it to
  // the landing panel (2026-09-30). Retiring the screen a number is drawn on does not retire the
  // rule that says how it is counted — that is exactly how this one nearly went out with the tab.
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
    // Nobody was planned here, so all four visits are off the plan: `doneAm`/`donePm` are the PLAN's
    // own stops done (2026-10-02) and the four are counted beside them, still AM and PM apart.
    assert.equal(built.counts.doneAm, 0, "no planned stop was done, because none was planned");
    assert.equal(built.counts.donePm, 0, "and the same on PM");
    assert.equal(built.counts.extraAm, 1, "AM counts visits, never pharmacies");
    assert.equal(built.counts.extraPm, 3, "and neither does PM");
    assert.equal(built.counts.extraAm + built.counts.extraPm, 4, "the four visits stay four — a pharmacy is never added in");

    // Called directly as well: it is exported, and the panel's figure is only as good as this.
    assert.deepEqual(todayPharmacies([]), [], "a day with no visits has no pharmacies");
    assert.deepEqual(
      todayPharmacies([{ customerId: "a", name: "Dr One", listType: "AM", doneAt: "09:10", pharmacyName: "   " }]),
      [],
      "and a blank name is not a pharmacy",
    );

    // 🔴 The chip is hidden at zero rather than printed as "Pharmacies 0" — the landing page's own
    // no-empty-square rule, which a figure with no denominator would otherwise walk straight past.
    const panel = source("src/components/employee-portal/rep-today-plan-panel.tsx");
    assert.ok(
      panel.includes("if (planned === 0 || (planned === undefined && done === 0)) return null;"),
      "no pharmacy visited yet, no chip",
    );
    assert.ok(
      panel.includes("{planned === undefined ? `${label} ${done}` : `${label} ${done} of ${planned}`}"),
      'a pharmacy has no denominator, so its chip reads "Pharmacies 2" and never "n of m"',
    );
  }

  console.log("phoenix-crm today: OK");
}
