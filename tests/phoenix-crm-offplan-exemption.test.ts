import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OFF_PLAN_EXEMPT_CARD_TEXT,
  offPlanAllowance,
  offPlanBlock,
  offPlanExemptionSentence,
} from "../src/lib/phoenix-crm/offplan-cap-rules.ts";
import { sharedPlanCapRefusal } from "../src/lib/phoenix-crm/shared-place-rules.ts";

const MIGRATION = "supabase/migrations/20261017150000_phoenix_crm_offplan_exemptions.sql";
const HOSPITAL = "مستشفي الجوي التخصصي";

/**
 * Owner, 2026-10-17: Mostafa Mahmoud Mohamed Ali may visit as many customers out of plan as he needs at the
 * Air Force Specialised Hospital — five, six — and the approval stays the normal one (district manager, then SFE).
 * Asked whether those visits should use up his numbers elsewhere: "everything as it is today, the exception is
 * only for الجوي التخصصي". So the exception is a named, seat-scoped row, never a raised cap.
 */
export function runPhoenixCrmOffplanExemptionTests(): void {
  const caps = { offPlanDailyCap: 2, offPlanWeeklyCap: 8 };
  const full = [
    { customerId: "elsewhere-1", visitDate: "2026-10-18" },
    { customerId: "elsewhere-2", visitDate: "2026-10-18" },
  ];

  // Without an exception a full day offers nobody new — the rule everyone else keeps.
  const plain = offPlanAllowance({ rows: full, day: "2026-10-18", caps });
  assert.equal(offPlanBlock(plain, "hospital-doctor"), "day", "the ordinary limit is untouched");
  assert.equal(plain.exemptCustomerIds, undefined, "no exception, no exception fields");
  assert.equal(offPlanExemptionSentence(plain), null, "and nothing is said about one");

  // With the exception, the hospital's customers are open on a full day and a full week, and others stay blocked.
  const excepted = offPlanAllowance({
    rows: full,
    day: "2026-10-18",
    caps,
    exemptions: { customerIds: ["hospital-doctor", "hospital-account"], labels: [HOSPITAL] },
  });
  assert.equal(offPlanBlock(excepted, "hospital-doctor"), null, "a hospital customer is never blocked by the day");
  assert.equal(offPlanBlock(excepted, "hospital-account"), null, "nor the hospital account itself");
  assert.equal(offPlanBlock(excepted, "elsewhere-3"), "day", "🔴 every other customer keeps the day's limit");
  assert.deepEqual([excepted.day.used, excepted.week.used], [2, 2], "the exception adds nothing to the meters");
  const sentence = offPlanExemptionSentence(excepted);
  assert.ok(sentence !== null && sentence.includes(HOSPITAL), "the rep is told where the limit is lifted");
  assert.ok(!/check|flag|violation|monitor/i.test(sentence ?? ""), "golden rule #1: nothing says he is being checked");
  assert.ok(!/\b(account|accounts|doctor|doctors)\b/i.test(`${sentence} ${OFF_PLAN_EXEMPT_CARD_TEXT}`), "the module's banned screen words");

  // The migration: the door stamps and skips, the counts leave stamped visits out, the seed names one seat.
  const migration = readFileSync(MIGRATION, "utf8");
  assert.ok(migration.includes("add column if not exists offplan_exempt boolean not null default false"), "the stamp column");
  assert.ok(
    migration.includes("if public.phoenix_crm_offplan_exempt(new.seat_id, new.customer_id, new.place_id) then\n    new.offplan_exempt := true;\n    return new;"),
    "the cap trigger stamps and returns BEFORE it counts anything",
  );
  assert.equal(migration.split("and not v.offplan_exempt").length - 1, 3, "🔴 the two out-of-plan counts and the venue count leave stamped visits out");
  assert.ok(
    migration.includes("new.unplanned_kind = 'out_of_plan'\n     and public.phoenix_crm_offplan_exempt(new.seat_id, new.customer_id, new.place_id)"),
    "the venue's daily number is lifted for an out-of-plan visit only — a planned one still counts",
  );
  assert.ok(migration.includes("e.seat_id = p_seat"), "🔴 the exception is per SEAT — no other rep is touched");
  assert.ok(migration.includes("sp.seat_id = p_seat"), "and a venue counts only if it belongs to that same seat");
  assert.ok(migration.includes("'SEAT-CNS-REP-CA2'"), "the seed names Mostafa Mahmoud Mohamed Ali's seat");
  assert.ok(migration.includes("01850dd5-8346-40fc-86ab-211825063ee6"), "and the hospital account on his list");
  assert.ok(!migration.includes("update public.phoenix_crm_settings"), "🔴 the settings (2 a day, 8 a week) are never raised");
  assert.ok(migration.includes("revoke execute on function public.phoenix_crm_offplan_exempt(text, uuid, uuid) from public, anon, authenticated"), "closed to the browser roles");

  // The approval chain is not touched by this change.
  assert.ok(!migration.includes("unplanned_status"), "the approval status is not written by the exception");

  // The reads and the screens.
  const cap = readFileSync("src/lib/phoenix-crm/server/offplan-cap.ts", "utf8");
  assert.ok(cap.includes('.eq("offplan_exempt", false)'), "the allowance rows leave exempt visits out, as the trigger does");
  assert.ok(cap.includes('rpc("phoenix_crm_offplan_exempt_customers"'), "the picker's exempt customers come from the database's own rule");
  const visits = readFileSync("src/lib/phoenix-crm/server/visits.ts", "utf8");
  assert.ok(visits.includes("exemptions: offPlanExemptions"), "the rep's form carries the exception");
  const team = readFileSync("src/lib/phoenix-crm/server/team.ts", "utf8");
  assert.ok(team.includes("offPlanExempt: exemptVisitIds.has(view.visitId)"), "each waiting visit says whether it fell under it");
  const card = readFileSync("src/components/phoenix-crm/unplanned-visit-card.tsx", "utf8");
  assert.ok(card.includes("visit.offPlanExempt") && card.includes("OFF_PLAN_EXEMPT_CARD_TEXT"), "the managers' card says so");
  const allowance = readFileSync("src/components/phoenix-crm/offplan-allowance.tsx", "utf8");
  assert.ok(allowance.includes("offPlanExemptionSentence(allowance, voice)"), "the rep's allowance card tells him");
  assert.equal(offPlanExemptionSentence(excepted, "manager"), null, "a venue exception is told to the rep only, as before");

  runNewHireWindowTests(caps, full);
  runLiftedVenueTests();
}

const LIFTED_MIGRATION = "supabase/migrations/20261031170001_phoenix_crm_alex_hospitals_no_cap.sql";

/**
 * Owner, 2026-10-31, of four hospitals in Saad Salama's district: "make them normally add in their plans any count
 * in these hospitals and make them log visits planned/unplanned in those hospitals without cap". A row carrying
 * lifts_venue_cap lifts the venue's own daily number for planned visits too — on the plan's save and send and at
 * the door — besides the out-of-plan cap every venue row already lifts. The Air Force hospital's row keeps false.
 */
function runLiftedVenueTests(): void {
  const dayLabel = (isoDay: string) => isoDay;
  const elite = Array.from({ length: 6 }, () => ({ planDate: "2026-11-01", sharedPlaceId: "elite" }));
  assert.ok(sharedPlanCapRefusal({ items: elite, venues: new Map(), cap: 3, dayLabel }) !== null, "an ordinary venue holds three a day");
  assert.equal(
    sharedPlanCapRefusal({ items: elite, venues: new Map(), cap: 3, dayLabel, liftedVenues: new Set(["elite"]) }),
    null,
    "🔴 a lifted venue holds any count on the plan",
  );
  const withOther = [...elite, ...Array.from({ length: 4 }, () => ({ planDate: "2026-11-01", sharedPlaceId: "other" }))];
  assert.ok(
    sharedPlanCapRefusal({ items: withOther, venues: new Map(), cap: 3, dayLabel, liftedVenues: new Set(["elite"]) })?.includes("has 4 visits"),
    "🔴 every other venue keeps its three, counted without the lifted one",
  );

  const migration = readFileSync(LIFTED_MIGRATION, "utf8");
  assert.ok(migration.includes("add column if not exists lifts_venue_cap boolean not null default false"), "false keeps the 2026-10-17 rule");
  assert.ok(
    migration.includes("if exists (select 1 from public.phoenix_crm_venue_cap_lifted(new.seat_id) l where l.shared_place_id = v_shared) then\n    return new;"),
    "the door lets a planned visit in a lifted venue through, before it counts",
  );
  assert.ok(migration.includes("and e.lifts_venue_cap") && migration.includes("join public.phoenix_crm_shared_places sp on sp.seat_id = e.seat_id"), "🔴 per seat, and only rows that lift it");
  assert.ok(migration.includes("'SEAT-CNS-REP-AB3'") && migration.includes("'SEAT-CNS-REP-AB1'"), "Ahmed Ashraf's and Hager Abdelmaged's seats");
  assert.ok(!migration.includes("'SEAT-CNS-REP-CA2'"), "the Air Force hospital's row is not touched");
  assert.ok(!migration.includes("update public.phoenix_crm_settings"), "🔴 the settings are never raised");
  assert.ok(migration.includes("revoke execute on function public.phoenix_crm_venue_cap_lifted(text) from public, anon, authenticated"), "closed to the browser roles");

  const plans = readFileSync("src/lib/phoenix-crm/server/plans.ts", "utf8");
  assert.ok(plans.includes("loadLiftedVenues(seat.seatId),\n  ]);"), "the save reads the lifted venues beside its other reads");
  assert.ok(plans.includes("sharedPlaces: planVenues,\n    liftedVenues,"), "and hands them to the plan rules");
  assert.ok(plans.includes("overVenue = sharedPlanCapRefusal({ ...venueCheck, venues, liftedVenues });"), "🔴 the send counts without them too");
  const rules = readFileSync("src/lib/phoenix-crm/plan-rules.ts", "utf8");
  assert.ok(rules.includes("liftedVenues: input.liftedVenues,"), "resolvePlanItems passes them to the venue cap");
  const loader = readFileSync("src/lib/phoenix-crm/server/shared-places.ts", "utf8");
  assert.ok(loader.includes('rpc("phoenix_crm_venue_cap_lifted"'), "the plan asks the door's own rule");
}

const NEW_HIRE_MIGRATION = "supabase/migrations/20261026230001_phoenix_crm_new_hire_offplan_month.sql";

/**
 * Owner, 2026-10-26: "Aya Mamdouh is a new hire — make her able to submit unplanned visits during her first
 * hiring month with no cap, only during the first month, then automatic return normal." A dated row over all of
 * one rep's out-of-plan visits; the day after it ends, the door and the picker are back to 2 and 8 by themselves.
 */
function runNewHireWindowTests(caps: { offPlanDailyCap: number; offPlanWeeklyCap: number }, full: Array<{ customerId: string; visitDate: string }>): void {
  const inWindow = offPlanAllowance({
    rows: full,
    day: "2026-10-18",
    caps,
    exemptions: { customerIds: [], labels: [], all: { label: "New hire — first month", until: "2026-11-23" } },
  });
  assert.equal(offPlanBlock(inWindow, "anyone"), null, "🔴 inside the window no customer is blocked by the day or the week");
  const told = offPlanExemptionSentence(inWindow);
  assert.equal(told, "Until 23 November there is no daily or weekly limit on your unplanned visits. From the day after, the usual limit applies.");
  assert.ok(offPlanExemptionSentence(inWindow, "manager")?.includes("the rep's unplanned visits"), "a manager entering for her reads it about the rep");
  assert.ok(!/check|flag|violation|monitor|\b(account|accounts|doctor|doctors)\b/i.test(told ?? ""), "golden rule #1 and the banned screen words");
  // No window (the loader answers none once the day is past valid_until): the ordinary limit, unchanged.
  const after = offPlanAllowance({ rows: full, day: "2026-10-18", caps, exemptions: { customerIds: [], labels: [] } });
  assert.equal(after.exemptAll, undefined, "no window, no window field");
  assert.equal(offPlanBlock(after, "anyone"), "day", "🔴 the day after the window the usual limit is back");

  const migration = readFileSync(NEW_HIRE_MIGRATION, "utf8");
  assert.ok(migration.includes("p_day between e.valid_from and e.valid_until"), "the window is both days inclusive and nothing else");
  assert.ok(migration.includes("and e.rep_hr_id = p_rep") && migration.includes("where e.seat_id = p_seat"), "🔴 bound to her seat AND her — no other rep is reached");
  assert.ok(
    migration.includes("or public.phoenix_crm_offplan_rep_exempt(new.seat_id, new.rep_hr_id, new.visit_date) then\n    new.offplan_exempt := true;\n    return new;"),
    "the door stamps and returns before it counts, so her month never uses up a later week",
  );
  assert.ok(migration.indexOf("if new.capture_source = 'admin' then") < migration.indexOf("phoenix_crm_offplan_rep_exempt(new.seat_id"), "the admin entry skip still comes first");
  assert.ok(migration.includes("valid_from is not null\n      and valid_until is not null"),"🔴 a whole-rep row can never be open-ended");
  assert.ok(migration.includes("'SEAT-PED-REP-GZ4'") && migration.includes("'PD-0029'"), "the row names Aya Mamdouh's seat and her");
  assert.ok(migration.includes("date '2026-10-24'") && migration.includes("date '2026-11-23'"), "her hire date to the day before the month comes round");
  assert.ok(!migration.includes("update public.phoenix_crm_settings"), "🔴 the settings (2 a day, 8 a week) are never raised");
  assert.ok(!migration.includes("function public.phoenix_crm_shared_place_day_cap"), "the venue's own daily number is not lifted for her");
  assert.ok(migration.includes("revoke execute on function public.phoenix_crm_offplan_rep_exempt(text, text, date) from public, anon, authenticated"), "closed to the browser roles");

  const cap = readFileSync("src/lib/phoenix-crm/server/offplan-cap.ts", "utf8");
  assert.ok(cap.includes('.lte("valid_from", day)') && cap.includes('.gte("valid_until", day)') && cap.includes('.eq("rep_hr_id", repHrId)'), "the picker reads the window with the door's own test");
  const visits = readFileSync("src/lib/phoenix-crm/server/visits.ts", "utf8");
  assert.ok(visits.includes("loadOffPlanExemptions(seat.seatId, enteredAs === \"rep\" ? viewer.hrId : (seat.occupantHrId ?? null), today)"), "the form reads the seat's rep's window for the visit day");
}
