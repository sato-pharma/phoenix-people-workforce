---
name: marketing-validation-report-labels-the-link-not-the-customer
description: "The Validated tab shows LINK status, so 154 backfilled links make 82 ROI-C customers with no photo read as system_validated — customer-status screens show only 21"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3bae391f-d43d-4c21-9c4b-070fed06efee
  modified: 2026-08-23T16:47:44.411Z
---

**The two numbers disagree, and both are correct.** Query `marketing_customers.validation_status`
and you get **21** `system_validated`, every one with a photo, matching exactly 21 objects under
`customer/` in the evidence bucket. Query `marketing_customer_pharmacies.validation_status` and you
get **176** — of which **154 have no customer evidence at all**, spanning **82 distinct customers**.

`mapValidationReportRows` (`src/lib/marketing-requests/service.ts`) emits **one row per LINK** and
sets `validationStatus: link.validationStatus`; the customer is merely attached. So a customer whose
own row is `pending` / `evidence_status = 'missing'` / `evidence_photo_name` NULL still renders under
the Validated tab. **Before concluding evidence was lost, check which table's status a screen reads.**

**Where the 154 came from.** A backfill script, `created_at` 2026-07-02 07:39:28–29 Cairo — one
second, `created_by_hr_id` and `updated_by_hr_id` both NULL. The column default is `'pending'`, so
`system_validated` there was written deliberately. Its own `validation_notes` says so:

> Inferred from approved historical marketing requests — not GPS field-validated. Backfill script 2026-07-02.

All 82 customers carry `ROI-C-…` codes — the historical marketing-request import, given links so ROI
attribution had something to attach to. **This is not an upload failure and there is nothing to
recover.**

**Contained:** the Validated Customer Register (transfer to Direct Orders) filters
`marketing_customers.validation_status`, not the link's, so none of the 82 can be transferred.

**Which screen shows it.** The **Marketing Customer Database** is where the pairing is visible and
where the owner saw it: `getMarketingCustomerDatabaseWorkspace` puts `link.validation_status` in the
status column and `customer.evidence_photo_name` in the photo column, so a row reads "system
validated" beside an empty photo cell. **Both columns are correct — they read different tables.**

**Detection:** `isInferredFromHistory` (`src/lib/customer-pharmacy-mapping/readiness.ts`) matches the
substring `not GPS field-validated`. There is no `source` column — the note IS the signal. The
Customer Pharmacy Mapping page has always badged these. PR #2339 (2026-08-23) added the badge to the
portal validation workspace — right badge, wrong screen — and **#2342 the same day added the Customer
Database** and moved the badge into one shared component,
`src/components/marketing-requests/inferred-history-badge.tsx`. On the workspace it is gated on
**every** link being inferred, never *some*: the *some* reading would tell a rep who genuinely made
the visit that nobody ever did.

Related: [[marketing-system-validated-means-no-human-looked]] ·
[[marketing-evidence-gate-never-checks-photo-age]] ·
[[seeded-marketing-pharmacies-have-no-area-and-are-invisible]]
