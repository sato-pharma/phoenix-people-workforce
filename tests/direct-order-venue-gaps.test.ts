import assert from "node:assert/strict";

import {
  countVenueGaps,
  isMissingPharmacist,
  type VenueGapCandidate,
  venueHasGap,
} from "../src/lib/direct-orders/venue-gaps.ts";

function venue(overrides: Partial<VenueGapCandidate> = {}): VenueGapCandidate {
  return {
    crmContactId: 1,
    distributorCodes: [{}],
    doctorName: "حسين عبدالعظيم",
    verificationStatus: "verified",
    ...overrides,
  };
}

export function runDirectOrderVenueGapsTests() {
  // ── A blank pharmacist is a MISSING pharmacist ───────────────────────────────────────────────
  // The whole reason this predicate exists rather than a bare `=== null`. A row saved with a space
  // in the box is not a recorded pharmacist, and counting it as filled makes the chip disagree with
  // the empty column the reader can see on the report — with the chip being the one believed.
  assert.equal(isMissingPharmacist(venue({ doctorName: null })), true, "null is missing");
  assert.equal(isMissingPharmacist(venue({ doctorName: "" })), true, "empty string is missing");
  assert.equal(isMissingPharmacist(venue({ doctorName: "   " })), true, "whitespace only is missing");
  assert.equal(isMissingPharmacist(venue({ doctorName: "\t\n" })), true, "other whitespace is missing too");
  assert.equal(isMissingPharmacist(venue({ doctorName: "محمد ابو القاسم" })), false, "a real Arabic name is present");
  assert.equal(isMissingPharmacist(venue({ doctorName: " Dr Anwar " })), false, "a padded real name is still present");

  // ── Each gap answers only its own question ───────────────────────────────────────────────────
  // A venue missing a pharmacist must not be counted as uncoded, unlinked or pending as well —
  // that is how one hole inflates four chips and the reader stops trusting all of them.
  const onlyPharmacist = venue({ doctorName: null });
  assert.equal(venueHasGap(onlyPharmacist, "pharmacist"), true, "the gap it has");
  assert.equal(venueHasGap(onlyPharmacist, "uncoded"), false, "not also uncoded");
  assert.equal(venueHasGap(onlyPharmacist, "unlinked"), false, "not also unlinked");
  assert.equal(venueHasGap(onlyPharmacist, "pending"), false, "not also pending");

  assert.equal(venueHasGap(venue({ distributorCodes: [] }), "uncoded"), true, "no codes is uncoded");
  assert.equal(venueHasGap(venue({ crmContactId: null }), "unlinked"), true, "no crm id is unlinked");
  assert.equal(
    venueHasGap(venue({ verificationStatus: "pending_review" }), "pending"),
    true,
    "pending_review is pending",
  );
  assert.equal(
    venueHasGap(venue({ verificationStatus: "rejected" }), "pending"),
    false,
    "rejected is NOT pending — it has been decided, and counting it as awaiting a decision would ask an admin to confirm a venue already ruled false",
  );

  // ── Counting matches the filter, which is the entire point ───────────────────────────────────
  // The chip and the list are driven by the same predicate, so the count can never claim 37 while
  // the filtered list shows a different 37.
  const rows: VenueGapCandidate[] = [
    venue(),                                                   // clean
    venue({ doctorName: null }),                               // pharmacist
    venue({ doctorName: "  " }),                               // pharmacist (blank)
    venue({ distributorCodes: [] }),                           // uncoded
    venue({ crmContactId: null, doctorName: null }),           // unlinked AND pharmacist
    venue({ verificationStatus: "pending_review" }),           // pending
  ];
  const counts = countVenueGaps(rows);
  assert.equal(counts.pharmacist, 3, "three rows have no pharmacist, blank included");
  assert.equal(counts.uncoded, 1, "one uncoded");
  assert.equal(counts.unlinked, 1, "one unlinked");
  assert.equal(counts.pending, 1, "one pending");

  for (const gap of ["pharmacist", "uncoded", "unlinked", "pending"] as const) {
    assert.equal(
      rows.filter((row) => venueHasGap(row, gap)).length,
      counts[gap],
      `the ${gap} chip's number must equal what the ${gap} filter shows — they share one predicate precisely so they cannot drift`,
    );
  }

  // A venue may carry more than one gap and is counted under each. It is one venue with two holes,
  // not a double count of one hole.
  const both = venue({ crmContactId: null, doctorName: null });
  assert.equal(venueHasGap(both, "pharmacist") && venueHasGap(both, "unlinked"), true, "counted under both");

  assert.deepEqual(
    countVenueGaps([]),
    { pending: 0, uncoded: 0, unlinked: 0, pharmacist: 0 },
    "an empty registry reports zeros, never undefined — the chips render on these numbers",
  );
}
