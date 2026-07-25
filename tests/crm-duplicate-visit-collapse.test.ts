import assert from "node:assert/strict";

import { collapseDuplicateDoubleVisitSubmissions } from "../src/lib/crm/reads.ts";

// Regression coverage for the iReports360 mobile-client "burst duplicate" bug: the SAME
// real-world double-visit stop gets saved as 2+ separate CRM records (same rep, same double
// partner, same day, same AM/PM, byte-identical comment), typically seconds to a few hours
// apart. Confirmed in production (2026-07-24): 263 of 1,570 double-visit rows (~17%) in an
// 11-day window belonged to such a group, across dozens of unrelated rep/manager pairs — e.g.
// Engy Said (CN-0004) / Ahmed Elkawass (A-7) logging the SAME "Gehaz obour" campaign stop twice,
// 8 minutes apart, as distinct crm_visit_ids 1213518 and 1213536. This test locks
// collapseDuplicateDoubleVisitSubmissions to the confirmed grouping/keep-earliest rule and to its
// deliberately conservative comment-substance gate (never collapse on a short/generic comment).

type Row = {
  crm_visit_id: number;
  agent_crm_id: number | null;
  double_crm_id: number | null;
  visit_date: string;
  ampm: string | null;
  comment: string | null;
  crm_save_date: string | null;
};

function row(partial: Partial<Row> & { crm_visit_id: number }): Row {
  return {
    agent_crm_id: 1507,
    double_crm_id: 1234,
    visit_date: "2026-07-22",
    ampm: "AM",
    comment: "Gehaz obour",
    crm_save_date: null,
    ...partial,
  };
}

export async function runCrmDuplicateVisitCollapseTests() {
  // 1. The real production case: two identical submissions of the same stop, 8 minutes apart —
  // only the earlier (first real submission) survives.
  const burst = [
    row({ crm_visit_id: 1213518, crm_save_date: "2026-07-23T01:24:40" }),
    row({ crm_visit_id: 1213536, crm_save_date: "2026-07-23T01:32:47" }),
  ];
  const collapsedBurst = collapseDuplicateDoubleVisitSubmissions(burst);
  assert.equal(collapsedBurst.length, 1, "duplicate burst collapses to one row");
  assert.equal(collapsedBurst[0].crm_visit_id, 1213518, "the EARLIER submission (by crm_save_date) is kept");

  // 2. A single-agent visit (no double partner) must never be touched, even with a matching
  // comment/day — the collapse only ever applies to the double-visit dimension.
  const singleAgent = row({ crm_visit_id: 9001, double_crm_id: null, comment: "Gehaz obour" });
  assert.deepEqual(
    collapseDuplicateDoubleVisitSubmissions([...burst, singleAgent]).map((r) => r.crm_visit_id).sort(),
    [1213518, 9001],
    "a single-agent row is always kept, independent of any double-visit duplicate group",
  );

  // 3. Different AM/PM, different day, different double partner, or different agent must never
  // be grouped together, even sharing the exact same comment text.
  const distinctDims = [
    row({ crm_visit_id: 1, ampm: "PM" }), // different period
    row({ crm_visit_id: 2, visit_date: "2026-07-23" }), // different day
    row({ crm_visit_id: 3, double_crm_id: 9999 }), // different double partner
    row({ crm_visit_id: 4, agent_crm_id: 8888 }), // different primary agent
  ];
  const collapsedDistinct = collapseDuplicateDoubleVisitSubmissions(distinctDims);
  assert.equal(collapsedDistinct.length, 4, "rows differing on any grouping dimension are never merged");

  // 4. Short/generic comments (".", "-", blank) must NEVER be used to group rows — the
  // conservative gate exists precisely because reps legitimately reuse filler comments across
  // genuinely different real visits (confirmed production example: Ahmed Ashraf / Saad Mohamed,
  // 5 separate "." campaign entries spread over more than an hour).
  const genericComment = [
    row({ crm_visit_id: 101, comment: "." }),
    row({ crm_visit_id: 102, comment: "." }),
    row({ crm_visit_id: 103, comment: "  " }),
    row({ crm_visit_id: 104, comment: null }),
  ];
  assert.equal(
    collapseDuplicateDoubleVisitSubmissions(genericComment).length,
    4,
    "short/blank comments never fingerprint a duplicate group — every row is kept",
  );

  // 5. Tie-break: when crm_save_date is identical (or both missing), the lower crm_visit_id
  // (issued first by the CRM) wins.
  const tie = [
    row({ crm_visit_id: 555, crm_save_date: "2026-07-23T01:00:00" }),
    row({ crm_visit_id: 222, crm_save_date: "2026-07-23T01:00:00" }),
  ];
  const collapsedTie = collapseDuplicateDoubleVisitSubmissions(tie);
  assert.equal(collapsedTie.length, 1);
  assert.equal(collapsedTie[0].crm_visit_id, 222, "on an exact save-time tie, the lower crm_visit_id wins");

  // 6. Case-insensitive, whitespace-trimmed comment matching (production example: "Gehaz obour "
  // with a trailing space, saved verbatim both times).
  const whitespaceVariant = [
    row({ crm_visit_id: 301, comment: "Gehaz obour ", crm_save_date: "2026-07-23T01:00:00" }),
    row({ crm_visit_id: 302, comment: " gehaz OBOUR", crm_save_date: "2026-07-23T01:05:00" }),
  ];
  assert.equal(
    collapseDuplicateDoubleVisitSubmissions(whitespaceVariant).length,
    1,
    "comment matching trims whitespace and ignores case",
  );
}
