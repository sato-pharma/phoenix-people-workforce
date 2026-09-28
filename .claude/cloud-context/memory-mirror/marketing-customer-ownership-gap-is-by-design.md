---
name: marketing-customer-ownership-gap-is-by-design
description: "The unowned marketing customers were one 2026-06-20 seed import, NOT a code bug — do not 'fix' the gap as a defect. owner_hr_id is a VISIBILITY control (writing it is a production permissions change), area_id grants sight too and is the right instrument for a cross-line shared customer, and the gap was ultimately closed by AREA not owners — so measure it with `owner_hr_id is null AND area_id is null`, never unowned-count. Holds the evidence routes for placing a customer, the owner rulings, and the CRM/duplicate traps that manufacture false findings."
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f9d1d5e-92b5-4eaa-a238-ad2fc773fd35
  modified: 2026-09-26T02:30:36.141Z
---

## The gap is by design — do not "fix" it as a defect

Measured on prod: the unowned `marketing_customers` rows (155 of 175 active at the time) were **all
created on one 2026-06-20 seed import** with `created_by_hr_id` NULL. **Every customer created through the
app since has an owner** — the write path is correct (`service.ts` sets `owner_hr_id` on create), so there
is no leak to plug. The ownerless state is deliberate and load-bearing: `buildReusableMarketingPharmacies`
gives seeded rows no owner/area and `evidence_status='missing'` "so they belong to nobody's list", and the
query filters them out with `.not("owner_hr_id","is",null)`. The gap was inert — those 155 carried one
request between them (rejected).

## The two controls, and why AREA is usually the right one

- **`owner_hr_id` is a VISIBILITY control, not a label.** `canSeeMarketingCustomer` reads
  `owner_hr_id`/`manager_hr_id`, so writing it puts the customer in that rep's marketing-request dropdown —
  **a bulk backfill is a production permissions change, and a wrong guess lets marketing spend be raised
  against the wrong shop.** The sanctioned single-row path is the Super Admin **"validate on behalf of"**
  flow (actor must be Super Admin server-side; target must be an ACTIVE employee whose job function is in
  `marketingCreatorRoles`; only `owner_hr_id` moves; audit columns keep naming the admin).
- **AN AREA GRANTS SIGHT TOO, and it is usually the right answer — do not reach for `owner_hr_id` first.**
  `canSeeMarketingCustomer` ([service.ts:4264](src/lib/marketing-requests/service.ts)) falls through to
  `Number(row.area_id) === viewerAreaId` (the "territory route", 2026-08-19 ruling), and
  `assertMarketingCustomerIsInScope` uses the same predicate — so a customer with `area_id` set and
  `owner_hr_id` NULL is visible to **every rep on that patch, on every line**, and they can raise requests
  against it. `public.areas` is **NOT line-scoped for this** (one area code holds reps of all three lines),
  which makes area the correct instrument for a **cross-line shared customer** — it satisfies the owner's
  "never shift, you just select and highlight" exactly, where naming one owner would pick a line.
- 🔴 **The whole gap was ultimately closed by AREA, not owners — so a "still unowned" count is NO LONGER the
  measure of the gap. Query `owner_hr_id is null AND area_id is null` instead** (that reached 0: every active
  row ended up owned or area-only-visible). These assignments were applied to prod deliberately, per the
  owner's instruction, and are marked in `validation_notes` (`Owner assigned…`/`Cover assigned…` markers,
  separable per batch); **do not undo or re-run them.** Rollback of any batch = set
  `owner_hr_id`/`manager_hr_id`/`line_id`/`area_id` back to NULL for its marked ids.

## Placing a customer: four columns, and the evidence routes in order

- **Four columns move together** — the app create path sets `owner_hr_id`, `manager_hr_id`, `line_id` and
  `area_id` all from the owner employee, so a backfill writing only `owner_hr_id` leaves the row
  half-configured (the rep sees it but request validation reads `line_id`/`area_id` too). Leave
  `created_by_hr_id`/`updated_by_hr_id` untouched when there is no human actor (audit columns stay truthful).
- 🔴 **Write the CUSTOMER's area into `area_id`, not the owner's — because a MANAGER's `employees.area_id` is
  REGION-level** (`Cairo`=1, `Giza`=7, `Upper Egypt`=16, `ALEX-BHR`=23, `Delta(1)`=29, `egypt`=42…), and
  area ids elsewhere are 1092–1145. When the owner is a rep on the same patch you may copy their area; when
  the owner is a manager/region-seat, take `area_id`/`line_id` from the patch and only owner/manager from the
  person. (An owned customer whose area differs from its pharmacy's master area is NORMAL — area follows the
  owner's seat, so the owner decides correctness, not the pharmacy link.)
- **Evidence routes, in this order:**
  1. **CRM `ireports360_visits`** — "does an ACTIVE rep visit this doctor?" FIRST, before any org-cover
     fallback (this was got wrong once: a resigned matched rep was handed to a manager while an active rep
     with 11 recent visits was ignored). A living rep who actually calls on the doctor beats a manager
     standing in for a vacancy.
  2. **Seat cover** when the matched rep resigned: `au.seats.parent_seat_id` (rep seat → parent DM/ADM seat
     → today's occupant), NOT `employees` (12 of 13 ex-reps had zero active colleagues on their own
     area+line). **Check the rep seat FIRST — it may have been REFILLED**, in which case the new occupant is
     the cover and no manager is involved.
  3. **`ireports360_visits.agent_name` encodes the patch in plain text** — `First.Last ( Area / Letter )` —
     use it when the seat is missing. **The letter is a CRM TEAM label, NOT the line** (A/E→Anti Infective,
     F/P→Pedia, C→CNS); read `employees.line_id` for the line. When the team label disagrees with the
     visit's own `crm_region_name`, the visit's region wins.
  4. **SoS master `source_of_sales_customer_map`** (`customer_code`→`area_code`, `active=true`) when
     `marketing_pharmacies` has null region/area and no GPS. `client_code` is unique only WITHIN a
     distributor. Resolving a code here does NOT propagate to `marketing_customers.area_id` — it is TWO
     writes, with the evidence into `validation_notes`.
  5. **`direct_order_pharmacies`** — the fourth route when sales, CRM and GPS are all empty: reps register
     shops there with brick/area/region already verified. (`0001…` codes are exclusively distributor `PS`.)

## Owner rulings (load-bearing)

- **Cross-line rivals → LEAVE UNOWNED and highlight.** "never shift, never shift, you just select and
  highlight" — two reps on a DIFFERENT line in the same area are a shared customer ("treasure"), not a
  contest; never reassign. [[cross-line-shared-customers-are-never-reassigned]]
- **Same-line rivals → assign only if not close** (≥2× or ≥+3 visits), else it is his call.
- **Deactivating a marketing customer is the owner's call.** The first-ever deactivation was 2026-08-20
  (a `وليد كمال` duplicate) — any doc saying "no row was ever deactivated" is stale from that date.
- Beni Suef/Fayoum judgement: `إسلام حسن غالى` went to Beni Suef (UE9) not Fayoum (GZ6) on the CRM region,
  though `employees.area_name` still said the pre-split "Fayoum-Beni Suef".
  [[public-areas-never-got-the-beni-suef-split]], [[fayoum-beni-suef-golden-rule-per-line]]. **GZ6 (1118) and
  UE9 (1145) have ZERO employees**, so the territory route is inert there — only the owner and chain see them.

## Traps that manufacture false findings

- 🔴 **`ireports360_visits.customer_name` is a DEAD column** (one distinct value across 122k rows) — **match
  on `contact_name`** (the doctor, 12,716 distinct). A join on `customer_name` returns silently EMPTY and
  looks like "no contests found". Verify any zero by relaxing the filter until the query provably fires.
- 🔴 **A CRM cross-check joined ONLY to ACTIVE employees MANUFACTURES false conflicts** — it drops the
  resigned/unmatched agent who is often the *strongest* visitor, leaving a same-named rep elsewhere in the
  country and making a correct assignment look wrong. Use `agent_name`'s embedded patch label +
  `crm_region_name` (both survive resignation) instead of the employee join.
- 🔴 **Cross-line "contests" are usually NAME COLLISIONS — check `contact_crm_id` before believing one.**
  `محمد صلاح` was 17 DIFFERENT doctors (17 distinct `contact_crm_id` in 17 towns). **No marketing customer
  stores a CRM id natively** (`marketing_customer_contacts.crm_code` is the only home, and most rows had
  none) — every CRM-derived owner is name-matched, so populate `crm_code` before trusting an ambiguous row.
  The disambiguator that works is the OWNER's own visits (lands on one id ~75% of the time); the rest are the
  SAME doctor registered twice (a re-registration — old id's visits stop, new id's begin → keep the id the
  owner currently calls on, note the superseded id).
- **`validation_notes IS NULL` silently eats rows from batch filters** — `notes not like 'x%'` evaluates to
  NULL, not TRUE, so a NULL-notes row vanishes without error. Always write
  `(validation_notes is null or validation_notes not like ...)`, and reconcile batch counts to the total.
- **Bucket/decision counts are NOT reproducible from a fresh SQL query** — the authoritative record is the
  `Confidence` column of the delivered workbook. Worse, **applying a batch CHANGES the buckets of the rows
  left behind** (the rule engine's last fallback asks "already owned?"), so freeze the ownership state
  (treat already-applied codes as unowned) before re-deriving, and assert the re-derivation reproduces the
  delivered sheet code-for-code.

## Duplicate marketing customers — the driver is UNREACHABILITY, not rejection

- 🔴 **"A rejection makes a rep mint a duplicate" is WRONG — do not repeat it.** Prod had 2 rejected requests
  in its whole history; one produced a duplicate, one did not (a sample of one). **The real driver is that
  the existing row cannot be REACHED** — an unowned seed row nobody can raise a request against forces a
  manager/PM to create a fresh row. This gap producing duplicates is a side effect of the ownership gap.
- **For CUSTOMERS the duplicate test is NOT name+GPS** ([[duplicate-pharmacy-test-is-name-and-gps-not-brick]]
  is the pharmacy test): GPS covers only the ~20 app-created rows (all seed rows have none, and some app rows
  share a reused capture), and a shared `crm_code` misses duplicates where CRM itself double-registered the
  doctor. Use **normalized-name trigram similarity within an area** (`pg_trgm` is on prod:
  `similarity(nname_a,nname_b) >= 0.45` + same `area_id`) — it surfaced every real case where exact-name and
  crm_code did not.
- **Which twin to keep is decided by REQUEST HISTORY, not evidence quality or recency** — keep the row
  carrying a `marketing_request`; deactivating the other strands nothing. Put
  `not exists (select 1 from marketing_requests where customer_id = c.id)` in the WHERE so the write no-ops if
  it changed underneath you. Note the kept row can be the WEAKER record (vaguer address, `pending` evidence) —
  flag evidence re-capture as follow-up. Deactivating the customer alone clears a duplicate `crm_code` (every
  visibility/duplicate query gates on `marketing_customers.active`; leave the contact row).
- **A cross-line duplicate with a LIVE pending request → escalate, never merge or deactivate** (the two CRM
  ids belong to different lines = the shared-customer rule, not a contest).

See [[marketing-not-found-codes-have-three-root-causes]] for why a CRM name match over-reports confidence
(the resigned trap: match count vs assignable count differ because some matches point at resigned reps).
