---
name: marketing-system-validated-means-no-human-looked
description: "A marketing customer at `system_validated` was never checked by a person — it proves GPS + a timestamped photo and nothing else; `validated_by_hr_id` is NULL on every such row."
metadata: 
  node_type: memory
  type: project
  originSessionId: faedc714-ba73-4daa-a9e9-810ee2b0f383
  modified: 2026-08-23T18:10:38.041Z
---

`resolveMarketingSystemValidationStatus` (`src/lib/marketing-requests/service.ts`) grants
`system_validated` **automatically**, with no human in the loop. It returns `system_validated` when
the customer's and the pharmacy's `evidenceStatus` are both `complete`, and `evidenceStatusFromInput`
calls that `complete` on exactly five things: a captured location, a photo timestamp, a photo
captured-at, a photo name, and photo bytes.

So the word "validated" here means only: **a rep stood in front of a building and took a
timestamped photo with GPS on.** `validated_by_hr_id` is **NULL on every `system_validated` row** in
production — that column is only populated for `sfe_validated`, which a human does clear.

It does **not** check: contact name, mobile, distributor-code resolution, whether the marketing area
maps to any Direct Order area, or whether the same shop already exists. All of those are
deliberately flag-only (see [[system-flags-expenses-never-rejects]] for the same standing rule).

Verified live 2026-08-22 on all 22 active validated customers: **9 had no mobile, 1 had no contact
at all, 3 were duplicate names** — including محمد رويشة captured by two *different* reps, which no
per-rep screen can surface. The owner's own example, حضانه النيل, is in the database **twice**: same
rep, 8 minutes apart, ~20m apart, both auto-passed.

**Why:** the owner asked "how can the admin check their data is full or not" and the honest answer
was that nothing had checked it. Reading `system_validated` as "a manager approved this" is the
mistake that makes the whole register look unnecessary.

**How to apply:** never tell the owner a `system_validated` record has been reviewed. When
completeness matters, check the fields yourself — the admin register at
`/admin/marketing-requests/validated-customers` exists for exactly this and separates blockers
(name, address, GPS, a linked pharmacy, a mappable area) from warnings (photo, evidence, contact,
mobile, distributor code, duplicate). The verdict **informs and never blocks** — owner's ruling,
"Don't block." See [[duplicate-pharmacy-test-is-name-and-gps-not-brick]] for how duplicates are
actually judged.

**Who may open that register: SUPER ADMIN ONLY** — owner ruling 2026-08-22, in his words, "Super
admin only, SFE cannot do this thing. Only super admin." This is deliberately **narrower** than
`assertMarketingCustomerDatabaseAccess`, which admits Super Admin **and** SFE Manager. Do not
"align" the two — the Customer Database is a read, while the register carries a Transfer button that
**writes a pharmacy into Direct Orders** (`entry_source = 'marketing_transfer'`, plus a pending
`direct_order_pharmacy_validations` row). Reading customer rows is not authority to create a record
in a second module. `tests/validated-customer-transfer.test.ts` keeps `SFE Manager` in
`FORBIDDEN_ROLES`, so re-widening it turns the PR red.

## The status on screen is the LINK's status, not the customer's (found 2026-08-23)

Both marketing screens read `validation_status` off **`marketing_customer_pharmacies`** — the
customer↔pharmacy link — and **that table has no GPS, no photo and no evidence column at all**
(`id, customer_id, pharmacy_id, distributor_code_id, validation_status, validation_notes, active,
created_by_hr_id, updated_by_hr_id, created_at, updated_at`). So a link can read `system_validated`
while the customer behind it is `pending` with nothing whatsoever captured. **That is what a
"system validated customer with no location or evidence" actually is** — not a failure of the
evidence gate, a different row.

Live counts 2026-08-23: 180 `system_validated` links across 101 customers, of which **154 links /
82 customers have zero evidence of any kind** — no GPS, no `evidence_photo_name`, no
`marketing_evidence_files` row. All 154 carry the honest note *"Inferred from pending/rejected
historical marketing requests — not GPS field-validated. Backfill script 2026-07-02."* By contrast
every `marketing_customers` (21) and `marketing_pharmacies` (22) row that is *itself*
`system_validated` **does** have GPS and a photo — the registers are clean, the link table is not.

**A DESK validation is the same lie by a different route, and the badge missed all of it until
PR #2347** (merged and live in production 2026-08-23 21:10 Cairo, revision `4766ce99`). The two writers word their own confession differently — the backfill says *"not GPS
field-validated"*, a desk entry says *"Location chosen from map search — no field GPS or live
photo"* — and `INFERRED_HISTORY_MARKER` matched only the first. Production 2026-08-23: **11 desk
links across 6 customers, which is EVERY `sfe_validated` link there is.** Five of those six hold a
map-search coordinate and no photo, so they read as field-proven; the sixth,
`ROI-C-7986552D8DC1`, has no coordinate at all — a 2026-08-21 owner merge (`B-10`) attached desk
links to a backfilled customer, and the `every` rule then saw a non-backfill link and dropped the
badge it had been showing.

Fixed by adding `isDeskValidated` **beside** `isInferredFromHistory` in
`src/lib/customer-pharmacy-mapping/readiness.ts` — never by widening the old one, because the
Customer Pharmacy Mapping page's "Inferred" filter is about ORIGIN and would relabel 11 desk links
as backfill rows. `customerFieldEvidenceGap` asks the union and returns which reason
(`inferred` / `desk` / `mixed`); the badge is `NotFieldValidatedBadge`. The `every`-not-`some` rule
is unchanged and must stay — `some` would call a rep who really made the trip a liar.

**Blast radius is one rejected request.** Of the 83 customers that show a green validated status on
zero evidence, exactly **1** has ever been used: `MKT-REQ-20260811-FF5B0719`, status **rejected**.
Zero live requests, zero `marketing_roi_request_facts` rows. The 286 zero-evidence pharmacies touch
that same single rejected request. Nothing was approved or paid on an unevidenced customer.

**How to apply:** when asked "how did a validated customer end up with no evidence", check
`marketing_customer_pharmacies` before the register — and answer with the note text, which admits
it. Never widen the badge to `some`. Related: [[a-narrowed-select-disarms-every-gate-downstream-of-it]].

## A person's Approve is `admin_approved`, a link-only status (owner decision 2026-09-17, PR #3937)

The Approve button on `/admin/customer-pharmacy-mapping` (open to the Super Admin **and the CEO**)
used to write `system_validated`, so a human ruling sat under the no-human label with only an
`Approved…` note to tell it apart. Asked as multiple choice, the owner chose a **new status**, not a
reuse of `sfe_validated` (the desk status: its 17 production links were 11 desk entries + 6 siblings
that inherited one). Named `admin_approved`, never `admin_validated` — the existing "Admin
validated" badge already means a DESK validation.

Only `marketing_customer_pharmacies` may hold it; the customers and pharmacies checks stay
four-valued. `LINK_STATUS_PRECEDENCE` (`code-link-reach.ts`) is the one validated list for links —
the picker, the draft guard and the unlink-fallout SQL read it — and the mapping module's
`CUSTOMER_PHARMACY_VALIDATED_STATUSES` is a test-pinned copy.

**LIVE:** the links check was widened on production 2026-09-17 19:21 Cairo (by the owner's approval) and
PR #3937 merged 19:22 — the customers and pharmacies checks were confirmed untouched.

**How to apply:** the migration went on production BEFORE the code deployed, or every Approve would
have failed the check constraint. Production had **0** Approve-button approvals when this was written;
any made since are found by the `Approved: ` / `Approved by ` note stamp and are HIS to relabel —
never by SQL on your own initiative.
