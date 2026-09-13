import assert from "node:assert/strict";

import { applyVisitFilter, buildParticipantCrmIdOrFilter, type VisitFilterableQuery } from "../src/lib/crm/reads.ts";

/**
 * The CRM read door's "agent OR double-visit partner" filter (`participantCrmIds`), added so the
 * outstation workload reads (crm/visit-workload.ts, crm/visit-partners.ts) could stop querying the
 * visits mirror directly. These pin the pure expression and the exact builder calls, including the
 * fail-closed case: a supplied id list that yields no usable id must match NOBODY, never silently
 * drop the filter and widen a person's workload to every visit in the window.
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
  assert.equal(buildParticipantCrmIdOrFilter([1166]), "agent_crm_id.in.(1166),double_crm_id.in.(1166)");

  // Several ids, in caller order, de-duplicated — the old per-hop `in.(list)` expression.
  assert.equal(
    buildParticipantCrmIdOrFilter([12, 7, 12, 30]),
    "agent_crm_id.in.(12,7,30),double_crm_id.in.(12,7,30)",
  );

  // Non-finite ids are dropped; nothing usable left → null (the door's "no rows").
  assert.equal(buildParticipantCrmIdOrFilter([Number.NaN, 5]), "agent_crm_id.in.(5),double_crm_id.in.(5)");
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
    ["or", "agent_crm_id.in.(1166),double_crm_id.in.(1166)"],
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
    ["or", "agent_crm_id.in.(12,7),double_crm_id.in.(12,7)"],
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
    ["or", "agent_crm_id.in.(5),double_crm_id.in.(5)"],
  ]);
}
