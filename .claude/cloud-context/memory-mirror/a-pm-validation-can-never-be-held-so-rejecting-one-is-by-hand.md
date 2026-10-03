---
name: a-pm-validation-can-never-be-held-so-rejecting-one-is-by-hand
description: "Only AM places get the automatic Google check (googleCheckApplies), so a DOCTOR's (PM) validation is never held and never reaches the Super Admin's Validation reviews page - rejecting one means inserting the review row first, then calling phoenix_crm_decide_validation_review."
metadata:
  node_type: memory
  type: project
  originSessionId: 1c636daf-110b-4389-9c03-0494427e6107
  modified: 2026-10-03T15:20:05.835Z
---

`googleCheckApplies(listType)` in `src/lib/phoenix-crm/google-place-rules.ts` returns true for **`AM`
only** — hospitals and units. A **PM** customer (a doctor) is validated straight through: no Google
lookup, no `phoenix_crm_validation_reviews` row, nothing on
`/admin/field-crm/validation-reviews`. That is deliberate — a private clinic usually has no Google
listing at all, so holding every doctor would hold everything.

**The consequence:** there is no button anywhere that rejects a doctor's validation. The page only
decides reviews that already exist.

**How to reject one (done on 2026-10-03 for Youssef Abokhedra, B-113, SEAT-PED-REP-D12):**

1. `insert into phoenix_crm_validation_reviews (seat_id, customer_id, place_id, is_test, kind,
   status, google, created_by_hr_id)` — `kind` `'validation'`, `status` `'pending'`,
   `created_by_hr_id` the **rep's** id, and `google` holding the real evidence measured by hand.
2. `select phoenix_crm_decide_validation_review(jsonb_build_object('review_id', …, 'actor_hr_id',
   'B-10', 'decision', 'reject', 'note', …))` — it retires the place, sends the customer back to
   `pending` ("To validate"), and writes `validation_review_rejected` + `place_retired` +
   `customer_pending`.
3. The RPC does **not** restamp the visits — the app does that in TypeScript
   (`restampVisitLocationsQuietly`). Call `phoenix_crm_restamp_visit_locations` yourself with
   `location_flag = 'no_place'`, `place_id` null, `distance_meters` null for each visit to that
   customer, or every one keeps a distance measured against a retired place.

**The visit survives**: it stays in `phoenix_crm_countable_visits` after the customer goes back to
pending (verified — his 03 Oct visit on هبه حبيب still counts).

**Why the review row rather than a direct update:** it keeps the rep's own screens reading
`not_confirmed` in the system's automated wording, which is
[[the-rep-never-feels-checked]] — golden rule #1, "do not show the rep that a person is accepting or
rejecting". Related: [[a-phoenix-crm-validation-is-checked-against-google-maps-never-ireports360]].
