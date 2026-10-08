import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyVisitFilter, buildParticipantCrmIdOrFilter, type VisitFilterableQuery } from "../src/lib/crm/reads.ts";

/**
 * The CRM read door's "agent OR double-visit partner" filter (`participantCrmIds`), added so the
 * outstation workload reads (crm/visit-workload.ts, crm/visit-partners.ts) could stop querying the
 * visits mirror directly. These pin the pure expression and the exact builder calls, including the
 * fail-closed case: a supplied id list that yields no usable id must match NOBODY, never silently
 * drop the filter and widen a person's workload to every visit in the window.
 *
 * THREE columns since 2026-10-07, not two: the visits door carries a SECOND partner slot, because a
 * chain visit's other person — the senior above the manager, or the product manager who came with him
 * — was being dropped entirely. On production that is Hany Saad Omar's 4 October rows and Rasha Sabry
 * Khalifa's 6, every one of them in slot 2 and invisible while this filter asked two columns.
 */

type Call = [method: string, ...args: unknown[]];

function recordingQuery(calls: Call[]): VisitFilterableQuery {
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  const query: VisitFilterableQuery = {
    eq: record("eq"),
    gte: record("gte"),
    ilike: record("ilike"),
    in: record("in"),
    is: record("is"),
    lte: record("lte"),
    neq: record("neq"),
    not: record("not"),
    or: record("or"),
  };
  return query;
}

export function runCrmParticipantFilterTests() {
  // One id: the same rows the old `agent_crm_id.eq.X,double_crm_id.eq.X` expression matched.
  assert.equal(buildParticipantCrmIdOrFilter([1166]), "agent_crm_id.in.(1166),double_crm_id.in.(1166),double2_crm_id.in.(1166)");

  // Several ids, in caller order, de-duplicated — the old per-hop `in.(list)` expression.
  assert.equal(
    buildParticipantCrmIdOrFilter([12, 7, 12, 30]),
    "agent_crm_id.in.(12,7,30),double_crm_id.in.(12,7,30),double2_crm_id.in.(12,7,30)",
  );

  // Non-finite ids are dropped; nothing usable left → null (the door's "no rows").
  assert.equal(buildParticipantCrmIdOrFilter([Number.NaN, 5]), "agent_crm_id.in.(5),double_crm_id.in.(5),double2_crm_id.in.(5)");
  assert.equal(buildParticipantCrmIdOrFilter([]), null);
  assert.equal(buildParticipantCrmIdOrFilter([Number.NaN, Number.POSITIVE_INFINITY]), null);

  // Workload read shape: date range + participant, resigned exclusion opted out (empty list).
  const workloadCalls: Call[] = [];
  applyVisitFilter(
    recordingQuery(workloadCalls),
    { dateFrom: "2026-06-01", dateTo: "2026-06-05", participantCrmIds: [1166] },
    "",
  );
  assert.deepEqual(workloadCalls, [
    ["gte", "visit_date", "2026-06-01"],
    ["lte", "visit_date", "2026-06-05"],
    ["or", "agent_crm_id.in.(1166),double_crm_id.in.(1166),double2_crm_id.in.(1166)"],
  ]);

  // Partner read shape: requireDoubleCrmId is NOT NULL only — it must not add doubleOnly's `neq 0`.
  const partnerCalls: Call[] = [];
  applyVisitFilter(
    recordingQuery(partnerCalls),
    { dateFrom: "2026-06-01", dateTo: "2026-06-05", participantCrmIds: [12, 7], requireDoubleCrmId: true },
    "",
  );
  assert.deepEqual(partnerCalls, [
    ["gte", "visit_date", "2026-06-01"],
    ["lte", "visit_date", "2026-06-05"],
    ["not", "double_crm_id", "is", null],
    ["or", "agent_crm_id.in.(12,7),double_crm_id.in.(12,7),double2_crm_id.in.(12,7)"],
  ]);
  assert.ok(!partnerCalls.some(([method]) => method === "neq"), "requireDoubleCrmId must keep the 0 sentinel rows");

  // Fail closed: an unusable id list becomes an empty IN, never an unfiltered read.
  const closedCalls: Call[] = [];
  applyVisitFilter(recordingQuery(closedCalls), { participantCrmIds: [] }, "");
  assert.deepEqual(closedCalls, [["in", "agent_crm_id", []]]);

  // The default resigned-agent exclusion still applies when the caller does not opt out.
  const defaultCalls: Call[] = [];
  applyVisitFilter(recordingQuery(defaultCalls), { participantCrmIds: [5] }, "(1,2)");
  assert.deepEqual(defaultCalls, [
    // exclusion_crm_id, not agent_crm_id: a native rep with no CRM id carries -1 there, where a null
    // would make `not in` drop the row (see supabase/migrations/20260913230000_crm_cutover.sql).
    ["not", "exclusion_crm_id", "in", "(1,2)"],
    ["or", "agent_crm_id.in.(5),double_crm_id.in.(5),double2_crm_id.in.(5)"],
  ]);

  // NOBODY HAND-ROLLS THIS EXPRESSION. A reader that spells the columns out itself asks whichever slots
  // its author knew about, and goes quietly wrong the day the door grows one — which is exactly what
  // happened: the rep-day read carried `agent_crm_id.eq.X,double_crm_id.eq.X` of its own, so a person
  // who rode along as the chain's OTHER partner opened his own day and found it empty.
  const repDay = readFileSync("src/lib/crm/rep-day.ts", "utf8");
  assert.doesNotMatch(repDay, /double_crm_id\.(eq|in)\./, "the rep-day read asks the shared builder, never its own column list");
  assert.match(repDay, /buildParticipantCrmIdOrFilter\(\[crmId\]\)/, "and it is that builder it asks");

  // AND THE SECOND HALF IS IN TYPESCRIPT. Widening the PostgREST filter is not enough on its own: a
  // reader that fetches the row and then decides "whose visit is this" against one partner column
  // discards it again, and the chain's other person still reads as absent. Every reader that
  // attributes a visit to a PERSON asks both slots — this is the list, and a new one belongs on it.
  //
  // The DEDUCTION connectors are on this list for the same reason, one step harder: a manager read as
  // absent there is a manager the month CHARGES, so the slot he stood in decides his pay.
  for (const [file, needle] of [
    ["src/lib/attendance/crm-day-maps.ts", "visit.double2_hr_id"],
    ["src/lib/company-activity-report/crm-detail.ts", "visit.double2_hr_id"],
    ["src/lib/business-review/sources/visits.ts", "row.double2_hr_id"],
    ["src/lib/business-review/sources/field-link.ts", "row.double2_hr_id"],
    ["src/lib/deductions/connectors/dsm-no-record.ts", "row.double2_hr_id"],
    ["src/lib/deductions/connectors/holiday-bridge.ts", "row.double2_hr_id"],
    ["src/lib/deductions/connectors/crm.ts", "visit.double2_hr_id"],
  ] as const) {
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes(needle), `${file} attributes a visit to both partner slots, not just the first`);
    assert.match(source, /double2_hr_id/, `${file} also SELECTS the second slot, or the attribution above reads undefined`);
  }
}
