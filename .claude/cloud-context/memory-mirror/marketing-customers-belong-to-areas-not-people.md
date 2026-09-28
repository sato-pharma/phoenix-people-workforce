---
name: marketing-customers-belong-to-areas-not-people
description: "OWNER RULE: a marketing customer is assigned to an AREA (area_id), never to a person, so it survives a resignation with no ownership backfill — owner_hr_id stays only as the capture record. Never propose 'assign the orphans to someone.' Identify the usable canonical area row by MARKERS (line_id NULL + real code like AB1/D13 + holds active employees), never by id range — low ids are REGIONS and husks that grant sight to nobody. The area resolver mapped_area_code is the best BULK answer but the captured ADDRESS beats it when they disagree — surface the conflict, let him decide. master_match_kind='ambiguous' does NOT mean the area is unknown."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9f9d1d5e-92b5-4eaa-a238-ad2fc773fd35
  modified: 2026-09-25T23:46:12.803Z
---

**OWNER RULE, 2026-08-19:** *"the customers are assigned to people. They must be assigned to areas.
Why? Because the employee resigns and another one is hired in his place, he finds his customers
automatically."*

**Why:** `canSeeMarketingCustomer` used to read `owner_hr_id`/`manager_hr_id` only, so a customer was
bound to a human and died with them — a rep resigns, the row still points at them, the replacement
matches neither the identity nor the hierarchy test, the customer goes invisible. A whole session was
spent backfilling ownership by hand before he pointed out the MODEL was wrong. **Do not propose
"assign the orphans to someone" as a fix again — that treats the symptom.**

**How to apply:** territory (`area_id`) grants sight; `owner_hr_id` stays only as the audit record of
who captured and validated the row. The area test is **line-agnostic**, matching the pharmacy ruling
he made the same day (`canReuseMarketingPharmacy`), which also settles the cross-line "treasure" case
for free with nothing shifted ([[cross-line-shared-customers-are-never-reassigned]]). Shipped
PR #2223; `tests/marketing-customer-area-ownership.test.ts`. **Do NOT revert.**

## `public.areas` has TWO generations — identify canonical by MARKERS, never by id

Legacy rows are low-id, carry a non-null `line_id`, use snake_case codes (`menoufia_2`,
`giza_giza_centers`). Canonical patch rows are high-id, have `line_id` **NULL**, use real codes
(`AB1`, `D13`, `GZ1`) and hold every active employee. 🔴 **Identify a canonical row by the MARKERS
(line_id NULL + real code + holds active employees), never by the id range** (Alex East/Center/West
are 1089/1090/1091 — there is no clean floor). **Emptiness is NOT the legacy test** — legacy rows are
not all empty (e.g. `Head office` id 80 holds people).

- **A name can exist as several ids and only one holds anyone.** "Alex East" is id 26 and id 55 (legacy
  husks, ZERO employees) and **1089 `AB1`** (holds the reps). Assigning a customer to 26 or 55 grants
  visibility to **nobody**. Verify no name is served by two ids that both hold people before trusting
  area-equality visibility — that property is what makes it safe.
- **Low ids are REGIONS and managers sit on them** (Cairo=1, Giza=7, Upper Egypt=16, ALEX-BHR=23,
  Delta (1)=29, Delta (2)=35, Egypt=42). The create path writes `area_id: owner.areaId`, so **a
  customer a District Manager creates gets the manager's REGION in the area column** — it still resolves
  through the hierarchy route, but can never be inherited until it carries a real patch. (18 such prod
  rows were fixed to real patches 2026-08-19; only `area_id` moved.)
- Because canonical rows are line-agnostic, **all three lines' reps in one patch share ONE `area_id`**
  (Menoufia 2 = 1102 carries lines 1, 2, 3) — that is what makes the cross-line rule work.

## Resolving a customer's area

- **`marketing_pharmacy_distributor_codes.mapped_area_code` (the SoS master resolver output already on
  the row) is the best BULK answer — reach for it first.** CRM name-match is weak (answered 7 of 18);
  `source_of_sales_bricks.brick_name` is **Arabic**, so English locality strings from
  `extracted_area_name` never match it.
- 🔴 **But the captured ADDRESS beats the master when they disagree — surface the conflict and let him
  decide, never silently prefer the master.** He twice ruled for the address over the sales master
  (adjacent patches inside one governorate — Sohag 1/2, Assuit 1/2 — which is exactly where the master
  drifts). `mapped_area_code` is the best bulk answer, **not** a tiebreaker that overrides the address.
- 🔴 **`master_match_kind = 'ambiguous'` does NOT mean the area is unknown.** The resolver marks a code
  ambiguous when it matches more than one master row, but the rivals often agree on the AREA and differ
  only on the BRICK. For an area question, query `source_of_sales_customer_map` by `customer_code` and
  count DISTINCT `area_code` yourself rather than trusting `mapped_area_code` being null (measured: of 8
  ambiguous, 6 had all candidates in one area). `unresolved` really does mean no master row.
- **Ambiguity comes from ONE `customer_code` under TWO distributor variants of one family** (`IS`+`IS-S`,
  `PS`+`PS-T`) — never one distributor twice (`source_of_sales_customer_map` is UNIQUE on
  `(distributor_code, customer_code)`). The resolver joins the whole family via
  `marketing_roi_distributor_rollup`, which is why the siblings collide.
- **A customer named like a corporate contract is a LEGITIMATE shape — do not deactivate one.**
  `تعاقد شركة الكهرباء` is an active `customer_type='doctor'`; its only quirk is that its pharmacies span
  governorates so no single area follows from the master — he settles those by name.

## Two guards that shipped alongside the rule

- **Write-path scope (PR #2226):** the draft-create and resubmit paths had NO visibility guard — a raw
  `customerId` in the body could raise a spend request against anyone's patch. Both now call
  `assertMarketingCustomerIsInScope`, which reuses the READ predicate, not a stricter one — **if you can
  see a customer you may request for it, and if you cannot, you may not**, so picker and server can
  never disagree. The one row surviving purely on the company-wide role bypass is a Marketing Manager
  request — **that shape is what a stricter write rule would start blocking; ask the owner first.**
  `tests/marketing-request-customer-scope-guard.test.ts` pins the two call sites (a guard nothing calls
  was the whole defect).
- **Resolver keeps an agreed area (PR #2229, `phx_resolve_marketing_pharmacy_codes`):** it used to fill
  `mapped_*` only for exact/digit_normalized, discarding the area of an ambiguous row. Now an ambiguous
  row KEEPS `mapped_area_code`/`mapped_region_code` when all candidates agree, still with no identity
  (brick, distributor/customer codes stay null). **Area agreement and region agreement are INDEPENDENT**
  — a row can keep its region while its area stays null. The four verdict kinds are pinned by a CHECK
  constraint (a fifth needs its own migration). Nothing gates on `mapped_area_code IS NOT NULL`, so an
  area with no brick is never mistaken for a resolved identity.

## Reusable trap — SECURITY DEFINER ACL

A public SECURITY DEFINER function inherits EXECUTE from PUBLIC, and anon/authenticated are PUBLIC
members, so **revoking just those two is a no-op.** Revoke `from public, anon, authenticated`, then
explicitly re-grant `service_role` (revoking PUBLIC on a default ACL strips service_role too).
`CREATE OR REPLACE` preserves the live ACL, but the migration file must still stand alone — CI's
migration harness catches this.

See [[marketing-customer-ownership-gap-is-by-design]] for the backfill history this replaced.
