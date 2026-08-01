import assert from "node:assert/strict";

import {
  collapseDuplicateVisitSubmissions,
  collapseDuplicateVisitSubmissionsLiveShape,
} from "../src/lib/crm/reads.ts";

// The iReports360 mobile client saves one real-world stop as several CRM records. The duplicate
// key is the CONTACT: per the owner's standing rule (2026-08-01) a rep never visits the same
// contact twice in a day, so one rep + one contact + one day + one visit type is one real stop,
// while rows naming DIFFERENT contacts are different real visits however alike they look.
//
// This replaced a rule that fingerprinted duplicates by identical COMMENT TEXT and never looked
// at the contact. Reps type one generic comment for every doctor, so ordinary fieldwork collapsed
// into a single row: measured in production (July 2026) that rule matched 119 groups of which only
// 21 shared a contact, and 166 of the 199 rows it dropped each month were real visits. The cases
// below are drawn from that production data and exist to stop the comment rule coming back.

type Row = {
  crm_visit_id: number;
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  double_crm_id: number | null;
  visit_date: string;
  visit_type: number | null;
  comment: string | null;
  crm_save_date: string | null;
};

function row(partial: Partial<Row> & { crm_visit_id: number }): Row {
  return {
    agent_crm_id: 1433,
    contact_crm_id: 98440,
    double_crm_id: 1425,
    visit_date: "2026-07-13",
    visit_type: 0,
    comment: "اخدت وعد بالكتابه",
    crm_save_date: null,
    ...partial,
  };
}

export async function runCrmDuplicateVisitCollapseTests() {
  // 1. THE REGRESSION THAT MATTERS. Production rep B-124 (crm 1433) with DSM B-118 (crm 1425) on
  // 2026-07-13: nine different doctors between 11:54 and 15:40, every row carrying the same
  // generic comment "اخدت وعد بالكتابه" ("took a promise to prescribe"). These are nine real
  // visits. The old comment-based rule collapsed them to one.
  const realDayOfWork = [
    row({ crm_visit_id: 1206769, contact_crm_id: 98440, crm_save_date: "2026-07-13T11:54:43" }),
    row({ crm_visit_id: 1206810, contact_crm_id: 98457, crm_save_date: "2026-07-13T13:11:07" }),
    row({ crm_visit_id: 1206839, contact_crm_id: 98459, crm_save_date: "2026-07-13T13:43:19" }),
    row({ crm_visit_id: 1206840, contact_crm_id: 104498, crm_save_date: "2026-07-13T13:44:13" }),
    row({ crm_visit_id: 1206857, contact_crm_id: 98462, crm_save_date: "2026-07-13T13:59:41" }),
    row({ crm_visit_id: 1206868, contact_crm_id: 104585, crm_save_date: "2026-07-13T14:08:08" }),
    row({ crm_visit_id: 1206887, contact_crm_id: 104499, crm_save_date: "2026-07-13T14:18:48" }),
    row({ crm_visit_id: 1206946, contact_crm_id: 104496, crm_save_date: "2026-07-13T14:58:14" }),
    row({ crm_visit_id: 1206997, contact_crm_id: 98461, crm_save_date: "2026-07-13T15:40:03" }),
  ];
  assert.equal(
    collapseDuplicateVisitSubmissions(realDayOfWork).length,
    9,
    "nine different contacts are nine real visits — identical comment text must NEVER group them",
  );

  // 2. A genuine duplicate: the same contact saved twice, half a minute apart (the real
  // production signature — true re-saves land ~30s apart). Earliest submission survives.
  const genuineDuplicate = [
    row({ crm_visit_id: 1213518, contact_crm_id: 98440, crm_save_date: "2026-07-23T01:24:40" }),
    row({ crm_visit_id: 1213536, contact_crm_id: 98440, crm_save_date: "2026-07-23T01:25:12" }),
  ];
  const collapsed = collapseDuplicateVisitSubmissions(genuineDuplicate);
  assert.equal(collapsed.length, 1, "same rep + contact + day collapses to one stop");
  assert.equal(collapsed[0].crm_visit_id, 1213518, "the EARLIER submission is kept");

  // 3. Comment text is irrelevant in BOTH directions: same contact still collapses even when the
  // comments differ completely, because the rep cannot have visited that contact twice.
  const sameContactDifferentComments = [
    row({ crm_visit_id: 401, comment: "اخدت وعد بالكتابه", crm_save_date: "2026-07-13T09:00:00" }),
    row({ crm_visit_id: 402, comment: "بيكتب تيبوفورتين", crm_save_date: "2026-07-13T09:04:00" }),
  ];
  assert.equal(
    collapseDuplicateVisitSubmissions(sameContactDifferentComments).length,
    1,
    "same contact collapses regardless of differing comment text",
  );

  // 4. Single-agent rows are NOT immune — a rep logging one contact twice alone is the same
  // artifact. (The old rule skipped every row without a double partner.)
  const singleAgentRepeat = [
    row({ crm_visit_id: 501, double_crm_id: null, crm_save_date: "2026-07-13T09:00:00" }),
    row({ crm_visit_id: 502, double_crm_id: null, crm_save_date: "2026-07-13T11:00:00" }),
  ];
  assert.equal(
    collapseDuplicateVisitSubmissions(singleAgentRepeat).length,
    1,
    "a solo rep repeating one contact in a day is still one visit",
  );

  // 5. Ride-along credit survives. When one stop was saved both solo and with a manager, the
  // row carrying the double partner wins even though it was saved later — dropping it would
  // erase the manager's coaching credit (DV analytics, probation DV, the "DV" calendar marker)
  // while leaving the visit count unchanged.
  const soloAndRideAlong = [
    row({ crm_visit_id: 601, double_crm_id: null, crm_save_date: "2026-07-13T09:00:00" }),
    row({ crm_visit_id: 602, double_crm_id: 1425, crm_save_date: "2026-07-13T09:03:00" }),
  ];
  const keptRideAlong = collapseDuplicateVisitSubmissions(soloAndRideAlong);
  assert.equal(keptRideAlong.length, 1);
  assert.equal(keptRideAlong[0].crm_visit_id, 602, "the ride-along row wins so coaching credit is kept");

  // 6. Different day, different rep, or different visit type are all different records. A regular
  // visit and a campaign for one contact are different KINDS of record, not a duplicated one.
  const distinctDims = [
    row({ crm_visit_id: 1, visit_date: "2026-07-14" }),
    row({ crm_visit_id: 2, agent_crm_id: 8888 }),
    row({ crm_visit_id: 3, visit_type: -8 }),
    row({ crm_visit_id: 4 }),
  ];
  assert.equal(
    collapseDuplicateVisitSubmissions(distinctDims).length,
    4,
    "rows differing on rep, day, or visit type are never merged",
  );

  // 7. A row with no contact to key on is never grouped — it cannot be proven duplicate.
  const noContact = [
    row({ crm_visit_id: 701, contact_crm_id: null }),
    row({ crm_visit_id: 702, contact_crm_id: null }),
  ];
  assert.equal(
    collapseDuplicateVisitSubmissions(noContact).length,
    2,
    "rows without a contact_crm_id are always kept",
  );

  // 8. Tie-break: identical save times (or none at all) fall back to the lower crm_visit_id,
  // which the CRM issues in submission order.
  const tie = [
    row({ crm_visit_id: 555, crm_save_date: "2026-07-13T01:00:00" }),
    row({ crm_visit_id: 222, crm_save_date: "2026-07-13T01:00:00" }),
  ];
  const collapsedTie = collapseDuplicateVisitSubmissions(tie);
  assert.equal(collapsedTie.length, 1);
  assert.equal(collapsedTie[0].crm_visit_id, 222, "on an exact save-time tie, the lower crm_visit_id wins");

  // 9. The live camel-case adapter (the rep-day drill-down, which handles both its live-API and
  // mirror sources in that shape) applies the identical rule, and the live API's datetime
  // visitDate groups with the mirror's pure DATE form.
  const liveShape = [
    { agentID: 1433, contactID: 98440, doubleID: 1425, id: 1206769, saveDate: "2026-07-13T11:54:43", visitDate: "2026-07-13T00:00:00", visitType: 0 },
    { agentID: 1433, contactID: 98440, doubleID: 1425, id: 1206775, saveDate: "2026-07-13T11:55:10", visitDate: "2026-07-13", visitType: 0 },
    { agentID: 1433, contactID: 98457, doubleID: 1425, id: 1206810, saveDate: "2026-07-13T13:11:07", visitDate: "2026-07-13", visitType: 0 },
  ];
  assert.deepEqual(
    collapseDuplicateVisitSubmissionsLiveShape(liveShape).map((visit) => visit.id).sort(),
    [1206769, 1206810],
    "live-shape adapter: same contact collapses across date formats; a different contact survives",
  );
}
