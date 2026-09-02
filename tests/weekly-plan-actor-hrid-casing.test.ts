import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { canonicalHrIdForDisplay } from "../src/lib/hr-id.ts";

// Built for a real production repair (2026-09-02). AccessContext.hrId is the LOWERCASE comparison
// key produced by canonicalHrIdKey — correct for matching, wrong for storage. Every weekly-plan RPC
// persisted it verbatim, leaving 541 lowercase actor ids across employee_plan_decisions,
// employee_plan_headers and employee_plan_hr_acknowledgements, the newest written the same day.
// Nothing looked broken: the app's own lookups canonicalise both sides, so only a naive .eq
// under-returns — the documented hazard that once hid 28% of reps' own orders.
//
// The converter is exercised for real (hr-id.ts is pure, no Supabase client). The write sites are
// source-pinned, because reaching them needs a database — and because the regression being guarded
// is a NEW call site added later, which no behavioural test of today's eight would ever catch.

const RAW_WRITE_SITES = [
  "p_actor_hr_id: input.access.hrId,",
  "p_actor_hr_id: access.hrId,",
  "p_hr_id: input.hrId,",
];

export async function runWeeklyPlanActorHrIdCasingTests() {
  const service = readFileSync("src/lib/weekly-planning/service.ts", "utf8");

  // --- the converter itself, run for real ---
  assert.equal(canonicalHrIdForDisplay("a-9"), "A-9", "the lowercase comparison key must convert back to the casing employees.hr_id stores");
  assert.equal(canonicalHrIdForDisplay("A-9"), "A-9", "an already-canonical id must pass through unchanged");
  assert.equal(canonicalHrIdForDisplay("  a-12  "), "A-12", "surrounding whitespace must never reach storage");
  assert.equal(canonicalHrIdForDisplay("aaa"), "AA", "the legacy aaa alias must resolve to the live employee id, not be stored as AAA");
  assert.equal(canonicalHrIdForDisplay(null), null, "a null actor must stay null - never the string NULL");

  // --- the single funnel exists ---
  assert.ok(
    service.includes("import { canonicalHrIdForDisplay, hrIdLookupKeys } from \"@/lib/hr-id\";"),
    "service.ts must import canonicalHrIdForDisplay - without it the funnel below cannot compile",
  );
  assert.ok(
    service.includes("function actorHrIdForStorage(value: string | null | undefined) {")
      && service.includes("return canonicalHrIdForDisplay(value) ?? value ?? null;"),
    "actorHrIdForStorage must exist and convert through canonicalHrIdForDisplay - it is the one place that turns a comparison key back into a stored id",
  );

  // --- no raw write site may survive ---
  for (const raw of RAW_WRITE_SITES) {
    assert.equal(
      service.includes(raw),
      false,
      `service.ts still passes a raw session hr id to an RPC ("${raw}") - that writes the lowercase comparison key into the database and reopens the 2026-09-02 drift`,
    );
  }

  // --- and EVERY actor parameter is funnelled, so a ninth call site cannot slip through ---
  // The leading space is load-bearing: the field double_visit_medical_rep_hr_id ENDS with the
  // substring "p_hr_id:" ("...re[p_hr_id:]"), so a bare split counts a type declaration as a
  // ninth RPC parameter and this assertion fails on correct code. Do not simplify it away.
  const actorParams = service.split(" p_actor_hr_id:").length - 1;
  const hrIdParams = service.split(" p_hr_id:").length - 1;
  const funnelled = service.split("_hr_id: actorHrIdForStorage(").length - 1;
  assert.ok(actorParams + hrIdParams > 0, "the pin found no actor parameters at all - the RPC payload shape changed and this test is measuring nothing");
  assert.equal(
    funnelled,
    actorParams + hrIdParams,
    `every p_actor_hr_id / p_hr_id argument must go through actorHrIdForStorage - found ${actorParams + hrIdParams} parameters but only ${funnelled} funnelled, so a call site writes the raw lowercase key`,
  );
}
