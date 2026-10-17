import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OFF_PLAN_EXEMPT_CARD_TEXT,
  offPlanAllowance,
  offPlanBlock,
  offPlanExemptionSentence,
} from "../src/lib/phoenix-crm/offplan-cap-rules.ts";

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
  assert.ok(allowance.includes('voice === "rep" ? offPlanExemptionSentence(allowance) : null'), "the rep's allowance card tells him");
}
