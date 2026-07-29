import assert from "node:assert/strict";

import {
  describeOverlap,
  findRequestOverlaps,
  windowMonths,
  type OverlapCandidate,
} from "../src/lib/marketing-requests/request-overlap.ts";

// Guards the double-count detector. Production carries 89 overlapping pairs across 37 requests, so
// the risk is real — but a detector that fires on every shared customer would be ignored within a
// week, which is why "all three keys must intersect" is tested as hard as the positive case.

function candidate(over: Partial<OverlapCandidate>): OverlapCandidate {
  return {
    payDate: "2026-08-01",
    pharmacyIds: ["ph-1"],
    productIds: [10],
    requestCode: "PHX-0001",
    requestId: "r1",
    roiDurationMonths: 3,
    status: "approved",
    ...over,
  };
}

function testWindowMonthsRollsTheYear() {
  assert.deepEqual(windowMonths("2026-11-01", 4), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.deepEqual(windowMonths("2026-08-15", 1), ["2026-08"]);
  assert.deepEqual(windowMonths(null, 3), [], "no pay date means no window");
}

function testDetectsGenuineDoubleCount() {
  const subject = candidate({ requestId: "a", requestCode: "PHX-A" });
  const other = candidate({ payDate: "2026-09-01", requestCode: "PHX-B", requestId: "b" });

  const [overlap] = findRequestOverlaps(subject, [other]);
  assert.ok(overlap, "same pharmacy + product + overlapping months must be detected");
  assert.equal(overlap.requestCode, "PHX-B");
  assert.deepEqual(overlap.sharedPharmacyIds, ["ph-1"]);
  assert.deepEqual(overlap.sharedProductIds, [10]);
  assert.deepEqual(overlap.overlappingMonths, ["2026-09", "2026-10"]);
}

function testAllThreeKeysMustIntersect() {
  const subject = candidate({ requestId: "a" });

  assert.equal(
    findRequestOverlaps(subject, [candidate({ pharmacyIds: ["ph-9"], requestId: "b" })]).length,
    0,
    "a different pharmacy attributes different rows — not an overlap",
  );
  assert.equal(
    findRequestOverlaps(subject, [candidate({ productIds: [99], requestId: "b" })]).length,
    0,
    "a different product attributes different rows — not an overlap",
  );
  assert.equal(
    findRequestOverlaps(subject, [candidate({ payDate: "2027-06-01", requestId: "b" })]).length,
    0,
    "a non-overlapping window attributes different periods — not an overlap",
  );
}

function testInertRequestsCannotContest() {
  const subject = candidate({ requestId: "a" });
  for (const status of ["draft", "rejected"]) {
    assert.equal(
      findRequestOverlaps(subject, [candidate({ requestId: "b", status })]).length,
      0,
      `${status} money is not committed, so it cannot contest a sale`,
    );
  }
}

function testIncompleteSubjectNeverWarns() {
  // Warning on a half-built draft would fire on every request mid-entry.
  assert.equal(findRequestOverlaps(candidate({ payDate: null, requestId: "a" }), [candidate({ requestId: "b" })]).length, 0);
  assert.equal(findRequestOverlaps(candidate({ pharmacyIds: [], requestId: "a" }), [candidate({ requestId: "b" })]).length, 0);
  assert.equal(findRequestOverlaps(candidate({ productIds: [], requestId: "a" }), [candidate({ requestId: "b" })]).length, 0);
}

function testNeverSelfReports() {
  const subject = candidate({ requestId: "same" });
  assert.equal(findRequestOverlaps(subject, [candidate({ requestId: "same" })]).length, 0);
}

function testDescriptionIsHumanReadable() {
  const subject = candidate({ requestId: "a" });
  const [overlap] = findRequestOverlaps(subject, [candidate({ payDate: "2026-09-01", requestCode: "PHX-B", requestId: "b" })]);
  const text = describeOverlap(overlap);
  assert.match(text, /PHX-B/, "must name the contesting request");
  assert.match(text, /counted for both/i, "must state the actual consequence");
  assert.doesNotMatch(text, /ph-1|\bid\b/i, "must not print raw ids at a requester");
}

export function runMarketingRequestOverlapTests() {
  testWindowMonthsRollsTheYear();
  testDetectsGenuineDoubleCount();
  testAllThreeKeysMustIntersect();
  testInertRequestsCannotContest();
  testIncompleteSubjectNeverWarns();
  testNeverSelfReports();
  testDescriptionIsHumanReadable();
}
