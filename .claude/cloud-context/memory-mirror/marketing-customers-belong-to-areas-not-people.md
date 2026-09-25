---
name: marketing-customers-belong-to-areas-not-people
description: "OWNER RULE: a marketing customer is assigned to an AREA, never to a person, so it survives a resignation without a backfill"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9f9d1d5e-92b5-4eaa-a238-ad2fc773fd35
  modified: 2026-08-19T20:08:00.000Z
---

**OWNER RULE, stated 2026-08-19:** *"the customers are assigned to people. They must be assigned to
areas. Why? Because the employee resigns and another one is hired in his place, he finds his
customers automatically."*

**Why:** `canSeeMarketingCustomer` used to read `owner_hr_id` / `manager_hr_id` and nothing else, so
a customer was bound to a human being and died with them. A rep resigns → the row still points at
them → the replacement matches neither the identity test nor the hierarchy test → the customer goes
invisible to the person actually working the patch. The only repair was a manual ownership
backfill. **A whole session was spent doing that backfill by hand before he pointed out the model
itself was wrong.** Do not propose "assign the orphans to someone" as a fix again — that is treating
the symptom.

**How to apply:** territory (`area_id`) grants sight; `owner_hr_id` stays only as the audit record of
who captured and validated the row. The area test is **line-agnostic**, matching the ruling he made
for pharmacies the same day (`canReuseMarketingPharmacy`) — which also settles the cross-line
"treasure" case for free, with nothing shifted. See
[[cross-line-shared-customers-are-never-reassigned]].

**MERGED AND SHIPPED TO PRODUCTION 2026-08-19 21:29 Cairo** at his instruction ("merge it") —
PR #2223, squash commit `624fac94`, all four required checks green. **Do NOT revert.**
Test: `tests/marketing-customer-area-ownership.test.ts`, registered in `tests/run-tests.ts`; proved
by disabling the area branch and confirming the headline assertion fires.

**`public.areas` has TWO generations of rows and only one is usable.** 140 rows, 100 distinct names,
32 names duplicated. The **legacy** rows are low-id, carry a non-null `line_id`, use snake_case codes
(`menoufia_2`, `giza_giza_centers`). **They do NOT all hold zero active employees — corrected
2026-08-19 by counting on prod: legacy rows hold 36, canonical 74.** 23 sit on the seven REGION rows
(below) and **13 on `Head office`** (id `80`, `head_office`, line 4), which nothing else here
mentions. So emptiness is NOT the legacy test — use `line_id IS NULL` plus the markers. The **canonical patch** rows
are high-id (**1089**–1145 — corrected 2026-08-19; Alex East/Center/West are 1089/1090/1091, so do
NOT treat 1092 as the floor), have `line_id` **NULL**, use real codes (`AB1`, `D13`, `GZ1`) and hold
every active employee. **Identify a canonical row by the MARKERS (line_id NULL + real code + holds
active employees), never by the id range.** Worked example of the trap: "Alex East" exists THREE
times — id 26 (`alex_east_2`, line 1) and id 55 (`alex_east`, line 2) are legacy husks holding ZERO
employees, and only **1089 (`AB1`)** holds anyone (4 reps across lines 1, 2 and 3, plus RSM
PD-0001). Assigning a customer to 26 or 55 would grant visibility to nobody at all. **Verified 2026-08-19: no area name is served by two ids that both hold people**, which is
exactly what makes area-equality visibility safe — run that check again before trusting it. Because
the canonical rows are line-agnostic, all three lines' reps in one patch share ONE `area_id`
(Menoufia 2 = 1102 carries lines 1, 2 and 3), which is what makes the cross-line rule work.

**Low ids are REGIONS and managers sit on them** — Cairo=1, Giza=7, Upper Egypt=16, ALEX-BHR=23,
Delta (1)=29, Delta (2)=35, Egypt=42. The create path writes `area_id: owner.areaId`, so **a customer
created by a District Manager gets the manager's REGION written into an area column** — 18 production
rows were in that state, all app-created, none from a backfill. They still resolve through the
hierarchy route so nothing regresses, but they can never be inherited until they carry a real patch.

**THE 18 REGION ROWS WERE FIXED ON PROD 2026-08-19 at his instruction ("fix those 18 region rows").
Do NOT undo, do NOT re-run.** Zero region rows remain. **Only `area_id` moved** - `owner_hr_id`,
`manager_hr_id` and `line_id` were deliberately left alone (verified after: 0 rows where anything
else changed), because under this rule the owner is the capture record, not the access key.

**The authority that resolved them was NOT the CRM and NOT the geocoded locality - it was
`marketing_pharmacy_distributor_codes.mapped_area_code`,** the Source-of-Sales master resolver's
output already stored on the row. All 18 linked pharmacies resolved with
`master_match_kind = 'exact'`. Reach for that column first next time: the CRM name-match answered
only 7 of the 18, and `source_of_sales_bricks.brick_name` is **Arabic**, so English locality strings
from `extracted_area_name` never match it.

**Two rows disagreed with their own geocode, and THE OWNER RULED FOR THE ADDRESS - the sales master
was wrong for both shops.** Flipped on prod the same day at his instruction ("the address is right for
both, flip them"): `انجي جاد` Sohag2 -> **Sohag1** (1127), `علاء عزت` Assuit 2 -> **Assuit 1** (1125).
Rollback to the master answer: `public.zz_rollback_flagged_areas_2026_08_19`.

**So `mapped_area_code` is the best BULK answer, not a tiebreaker that beats the captured address.**
I had reasoned the opposite - that `extracted_area_name` is only a Google locality whose resemblance
to a Phoenix area name is coincidence - and he overruled it on both rows. When the two disagree,
**surface the conflict and let him decide**; do not silently prefer the master. Both were adjacent
patches inside one governorate (Sohag 1/2, Assuit 1/2), which is exactly where the master drifts.
Rollback for all 18 region moves: `public.zz_rollback_region_areas_2026_08_19` (anon/authenticated
revoked on both tables).

**CLOSED 2026-08-19 by PR #2226** (was: the draft write path had **no customer visibility guard at
all** — `createMarketingRequestDraft` and the resubmit path loaded the customer by id and checked
only that it existed and was `active`, so a raw `customerId` in the request body could raise a spend
request against anyone's patch). Both paths now call `assertMarketingCustomerIsInScope`, which reuses
the READ predicate above rather than a stricter one of its own — **if you can see a customer you may
request for it, and if you cannot, you may not** — so the picker and the server can never disagree.
Measured on prod before shipping: **0 of the 9 `marketing_requests` rows would have been refused** —
8 raised by the customer's own owner (passing on identity AND area), and MKT-REQ-20260811-FF5B0719
by A-9 Marketing Manager, the ONLY row that survives purely on the company-wide role bypass. **If a
stricter write rule is ever wanted, that request shape is the one it starts blocking** — check with
the owner first. Test: `tests/marketing-request-customer-scope-guard.test.ts`, which pins the two
call sites as well as the predicate, because a guard nothing calls was the whole defect.

**THE 31 NEVER-OWNED ROWS WERE ASSIGNED ON PROD 2026-08-19** at his instruction ("apply the 31 with
your prefilled answers"): **27 given an area**, 20 of those also a line, spread over 19 patches that
all have a live rep. `owner_hr_id` was left NULL on every one on purpose - nobody captured them, and
the area is what grants sight. Rollback: `public.zz_rollback_unowned_areas_2026_08_19` (all 31).
After this, **every active marketing customer has an area except 4**.

**Of the 4 I first called unanswerable, only ONE really was.** `محمد كمال درويش` -> **Assuit 2** on his
call (3 of 4 codes and the most recent visit). `محمد هاني` -> **Alex Center (AB2)**, see the ambiguity
rule below. `احمد الدالي` - the genuine dead end: POS code `0001511111` has NO row in
`source_of_sales_customer_map` under any distributor, no CRM visit, no GPS. Left active with a note
saying not to guess; it looks like a real hospital nursery. `تعاقد الكهرباء جليم` -> **Alex East (AB1)** on his call, decided on the NAME (Glim is eastern
Alexandria) because the codes could not answer. **End state: 175 active customers, 174 with an area,
1 without - and that 1 is `احمد الدالي`, blocked on an external fact, not on a decision.**

**`master_match_kind = 'ambiguous'` DOES NOT MEAN THE AREA IS UNKNOWN - check before believing it.**
The resolver marks a code ambiguous when it matches more than one master row, but the rival rows
often agree on the AREA and differ only on the BRICK. Measured on prod 2026-08-19 across every active
marketing pharmacy code: **8 ambiguous, of which 6 have all candidates in ONE area** and only 2
genuinely disagree; `unresolved` is 9 and those really do have no master row. So for an area question,
query `source_of_sales_customer_map` by `customer_code` and count DISTINCT `area_code` yourself
instead of trusting `mapped_area_code` being null. Worked example: code `357887` exists under
distributor `IS` (brick B177-1, `sheet-verified`) and `IS-S` (brick B108-73) and both are area `AB2`.

**A customer named like a corporate contract is a LEGITIMATE shape here - do not deactivate one.**
I proposed deactivating `تعاقد الكهرباء جليم` ("electricity contract, Glim") as not-a-doctor and was
wrong: the sibling `تعاقد شركة الكهرباء` is active, `customer_type = 'doctor'`, and already carries
Menoufia 1. Its real problem is only that its 3 pharmacies resolve to 3 governorates (Alex East,
Menoufia 1, Nasr City), so no single area follows from the master. He settled it as Alex East on the name.

**THE RESOLVER ITSELF WAS FIXED - PR #2229, branch `codex/marketing-resolver-keeps-agreed-area`,
migration `20260819234500_resolver_keeps_an_agreed_area.sql`.** `phx_resolve_marketing_pharmacy_codes`
decided its whole verdict from `count(distinct brick_id)` and then filled `mapped_*` ONLY for
exact/digit_normalized - so an ambiguous row was written back with every mapped column null and the
area was discarded. Now an ambiguous row KEEPS `mapped_area_code`/`mapped_region_code` when all
candidates agree, and still gets no identity (brick, distributor code, customer code stay null). The
four verdict kinds are unchanged - there is a CHECK constraint pinning them, so a fifth value would
have needed a second migration.

**MERGED AND APPLIED TO PROD 2026-08-19 at his instruction ("merge it" then "apply it").** Squash `7657fcaa`, live on Railway (healthz revision confirmed). The note above records the CODE change; these are the facts it was missing — **merging did not apply it**, the migration was run separately by MCP, and the live function body was then verified byte-identical to the repo file (normalized md5 `52b82051e95ce578e6bf37b9d44796ad`). The backfill is NOT part of the migration by design: it is a separate explicit RPC call over the ambiguous ids so the repair runs through the shipped path. Result: **6 of 8 gained an area** (330379 CA2, 356648 AB3, 357887 AB2, 358838 AB1, 401019 D13, 449347 D13), **7 gained a region** — `368283` disagrees on area but both candidates sit in region `UE`, which is the independent region test earning its keep — and the 294 `exact` rows were untouched. `333525` and `368283` still carry no area, correctly. **No customer's visibility changed today**: all 175 active customers had already been given areas by hand that evening, so the gain is that the NEXT one will not lose its territory. Checked before applying: nothing anywhere gates on `mapped_area_code IS NOT NULL`, so an area with no brick cannot be mistaken for a resolved identity — direct-orders only writes these columns or projects them into a DTO. Rollback: `public.zz_rollback_resolver_2026_08_19` (old function body) and `public.zz_rollback_ambiguous_codes_2026_08_19` (the 17 ambiguous+unresolved rows).

**Ambiguity comes from ONE customer_code under TWO distributor variants in the same family** - `IS`
and `IS-S`, `PS` and `PS-T`. It cannot come from one distributor twice: `source_of_sales_customer_map`
has a UNIQUE on `(distributor_code, customer_code)`. The resolver joins on the whole family via
`marketing_roi_distributor_rollup`, which is why the siblings collide.

**Proof, in the order it was taken:** a read-only dry run of the new logic over real prod rows (6 of
8 ambiguous gain an area, the 294 exact rows change in NOTHING, 0 rows anywhere lose an area);
then the RPC run end to end on staging (287 rows, 0 changes); then a seeded three-step case on
staging - rival brick + same area -> `ambiguous` with the area KEPT and brick null; rival moved to a
different area -> NO area (but region still kept, the two agreements are independent); rival removed
-> back to `exact` byte-for-byte. Staging left clean, 0 proof rows.

**CI's migration harness caught a real defect I had missed:** a public SECURITY DEFINER function
inherits EXECUTE from PUBLIC, and anon/authenticated are PUBLIC members, so revoking just those two
is a no-op - it must be `from public, anon, authenticated` then an explicit re-grant to service_role
(revoking PUBLIC on a default ACL strips service_role too). Live ACL on both databases was already
correct because CREATE OR REPLACE preserves it, but the file must stand alone.

See [[marketing-customer-ownership-gap-is-by-design]] for the backfill history this replaced.
