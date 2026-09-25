---
name: marketing-customer-ownership-gap-is-by-design
description: "The 155 ownerless marketing customers are one 2026-06-20 seed import, not a code bug — and assigning owners changes production visibility"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f9d1d5e-92b5-4eaa-a238-ad2fc773fd35
  modified: 2026-08-19T21:03:34.272Z
---

**Do not "fix" the unowned `marketing_customers` as if it were a defect.** Measured on prod
2026-08-19: 155 of 175 active rows have `owner_hr_id` NULL, and **every one of them was created on
2026-06-20 with `created_by_hr_id` NULL** — a single seed import. **All 20 customers created through
the app since (2026-08-02 onward) have an owner. 20/20.** The write path is correct
(`service.ts` sets `owner_hr_id: ownerHrId` on create), so there is no leak to plug.

**The ownerless state is deliberate and load-bearing.** `service.ts` (`buildReusableMarketingPharmacies`)
documents it: seeded rows "carry no owner, no area and `evidence_status = 'missing'`, so they belong
to nobody's list", and the query filters them out with `.not("owner_hr_id","is",null)`. Linking one
would park the customer on "Not Usable Yet" for a reason the rep never caused.

**AN AREA GRANTS SIGHT TOO, AND THAT IS USUALLY THE RIGHT ANSWER — do not reach for `owner_hr_id`
first.** `canSeeMarketingCustomer` ([service.ts:4264](src/lib/marketing-requests/service.ts)) falls
through to `Number(row.area_id) === viewerAreaId` — the "territory route" added by the 2026-08-19
ruling. So a customer with `area_id` set and `owner_hr_id` NULL is visible to **every rep on that
patch, on every line**, and `assertMarketingCustomerIsInScope` uses the same predicate, so they can
raise requests against it. `public.areas` is **NOT line-scoped for this purpose**: 140 rows, 140
distinct codes, one row per code — area 1089 (Alex East) holds active Anti Infective, Pedia AND CNS
reps. That makes area the correct instrument for a **cross-line shared customer**: it satisfies
"never shift, you just select and highlight" exactly, where naming one owner would pick a line.
Verified on prod 2026-08-19. **The whole 155-row gap was ultimately closed this way, not by owners.**

**`owner_hr_id` is a VISIBILITY control, not a label.** `canSeeMarketingCustomer` reads
`owner_hr_id`/`manager_hr_id`, so writing it puts the customer in that rep's marketing-request
dropdown — i.e. a bulk backfill is a production permissions change, and a wrong guess lets spend be
raised against the wrong shop. The sanctioned path is the Super Admin **"validate on behalf of"**
flow, which is guarded: actor must be Super Admin server-side, target must be an ACTIVE employee
whose job function is in `marketingCreatorRoles`, and audit columns keep naming the admin —
`owner_hr_id` is the only column that moves.

**The gap is inert.** Those 155 carry **1 request between them** in two months
(`MKT-REQ-20260811-FF5B0719`, raised by A-9, and it is **rejected**). The 20 owned customers carry 8.

**How to answer it if he wants it closed: `ireports360_visits`.** It has `agent_hr_id` against
`contact_name`, so the CRM knows who calls on a doctor when marketing does not. Matching on
Arabic-normalized exact name (`replace(translate(lower(x),'أإآٱى','ااااي'),'ة','ه')` + collapse
whitespace) gives, out of 155: **64 single active assignable rep · 13 whose only match has RESIGNED ·
38 matching 2+ reps · 40 no match.** Only the first 64 are safe to pre-fill. Sent as an XLSX with a
locked dropdown per his standing rule (2026-08-19) — never guess the other 91.

**APPLIED TO PROD 2026-08-19 — the 64 safe ones only. Do NOT undo, do NOT re-run.** At the owner's
instruction, `marketing_customers` went **20 owned → 84** (155 unowned → 91). Verified after:
`partially_set = 0`, 34 distinct reps, `marketing_requests` unchanged at 9. Each assigned row carries
its evidence and rollback in `validation_notes` (marker: `Owner assigned 2026-08-19%`), so
`select ... where validation_notes like 'Owner assigned 2026-08-19%'` re-identifies the exact 64.
**Rollback = set `owner_hr_id`, `manager_hr_id`, `line_id`, `area_id` back to NULL for those ids.**

**Four columns move together, not one.** The app's own create path sets `owner_hr_id`,
`manager_hr_id`, `line_id` and `area_id` all from the owner employee, so a backfill that writes only
`owner_hr_id` leaves the customer half-configured — the rep would see it but request validation reads
`line_id`/`area_id` too. `created_by_hr_id`/`updated_by_hr_id` were deliberately left untouched: there
was no human actor, and fabricating one would break the "audit columns stay truthful" invariant.

**APPLIED TO PROD 2026-08-19 — the 13 "resigned" ones too, at his instruction ("apply the 13
resigned ones to their current cover"). Do NOT undo, do NOT re-run.** `marketing_customers` went
**84 owned → 97** (91 unowned → 78). Verified after: `partially_set = 0`, all 8 owners AND all 8
managers active, `marketing_requests` unchanged at 9. Marker is **`Cover assigned 2026-08-19%`** —
deliberately different from the 64's `Owner assigned 2026-08-19%`, so the two batches stay separable.
Same rollback (four columns back to NULL). **12 of the 13 landed on a MANAGER, not a rep** — that is
a materially different assignment from the 64 and he was told so.

**ASK "does an ACTIVE rep visit this doctor?" BEFORE falling back to org cover — this was got wrong
once.** The first pass tested only "is the MATCHED CRM agent still employed?", and when the answer was
no it went straight to the seat model. That skips the obvious question. `بيتر فتحي` was handed to a
District Manager covering an empty Pedia seat while **B-13 Rana Adel Abdelmoly aly (active, Anti
Infective, Assuit 2) had visited that doctor 11 times, most recently 4 days earlier** — more recently
than the resigned rep ever did. Corrected on prod 2026-08-19; that row's note carries both readings.
**A living rep who actually calls on the doctor beats a manager standing in for a vacancy.** Note the
side effect: her line/area differ from the departed rep's, so `line_id`/`area_id` move too — a doctor
can legitimately be seen by two lines.

**Those two flips were applied and then REVERTED the same day — do NOT re-apply them.** `هشام حسن`
B-59 → B-105 and `هاني الخولي` B-126 → B-7 were flipped on "yes flip those two", then rolled back on
his ruling **"never shift, never shift, you just select and highlight"**: both rivals are on a
DIFFERENT LINE in the same area, which is a shared customer, not a contest. Live values today are the
originals, **B-59 and B-126**. Both readings are in each row's `validation_notes`, which is why a
truncated read of that note looks like a half-applied write — read the whole note before "fixing" it.
Full rule: [[cross-line-shared-customers-are-never-reassigned]].

**Scope the rival audit to YOUR OWN batches.** Run across all 97 owned rows it returns 18 rivals over
15 customers, and 10 of those are false alarms: customers created in the app where
`created_by_hr_id = owner_hr_id`, i.e. the rep who validated the customer owns it and a second
visiting rep is expected. Filter on the `validation_notes` markers to see only what was auto-assigned.

**Five of the 64 are contested and were auto-assigned anyway — they should have been "you decide".**
A second ACTIVE rep also visits: `هاني الخولي` (assigned B-126, but **B-7 Aya Ibrahim** has 19 visits
to 2026-08-11) and `هشام حسن` (assigned B-59, but **B-105 Mariem Hany** has 17 visits to 2026-08-19)
are the two strong ones; `خالد حليمه` (vs B-164), `محمد احمد قطب` (vs B-1) and `وليد الريس`
(vs PD-0005) are 1–2 stale visits and probably fine. Re-find them with the audit query: join both
batches to `ireports360_visits` on the normalized name and keep rows where an **active** agent other
than `owner_hr_id` appears.

**Cover for a vacated patch comes from `au.seats.parent_seat_id`, not from `employees`.** The
`employees` route fails outright here: 12 of the 13 ex-reps had **zero** active colleagues on their
own area+line, and 4 had `area_id` cleared on resignation. The seat model answers every time — look
up the ex-rep's REP seat, then read its parent (the DM/ADM seat) and who occupies it today. **Check
the rep seat first though: it may have been REFILLED**, in which case the new occupant is the cover
and no manager is involved (that was `يسري ابو النجا` → B-130 Yasmine Samy on SEAT-CNS-REP-D11).

**`ireports360_visits.agent_name` encodes the patch in plain text — use it when the seat is missing.**
Format is `First.Last ( Area / Letter )`, e.g. `Amany.Ahmed ( Assuit 2 / P )`,
`Eman.Ahmed ( Helwan-Maadi / E )`. That recovered the area for the 4 ex-reps with no seat and no
`area_id`. **The letter is a CRM team label, NOT the line** — measured: `A` and `E` both map to
line 1 Anti Infective, `F` and `P` both to line 2 Pedia, `C` to line 3 CNS. Read `employees.line_id`
for the line, never the letter. **And when the team label disagrees with the visit's own
`crm_region_name`, the visit wins** — B-127's label said "Cairo West" but her one visit to this
doctor was in Shobra El Khima, i.e. Qalubeya, which is what `employees.area_id` said too.

**Write the CUSTOMER's area into `area_id`, not the owner's.** The 64 could copy `area_id` straight
off the owner because the owner was a rep on that same patch. A **manager's** `employees.area_id` is
REGION-level (`Cairo`=1, `Giza`=7, `Upper Egypt`=16, `ALEX-BHR`=23, `Delta (1)`=29) and writing it
would put a region id in a column that everywhere else holds area ids (1092–1145). The 13 therefore
take `area_id`/`line_id` from the patch and only `owner_hr_id`/`manager_hr_id` from the person.

**One judgement call is flagged in its own note:** `إسلام حسن غالى` went to **Beni Suef (UE9, 1145)**
under B-1 Nosiba Salah, not Fayoum (GZ6, 1118) under AI-0007. `employees.area_name` still says the
pre-split `"Fayoum-Beni Suef"`, but all 5 CRM visits are in region `"Bani Swif"` and the ex-rep's
label is `( Bani Sweif / E )`. See [[public-areas-never-got-the-beni-suef-split]]. The alternative
reading is written into that row's `validation_notes` if it ever needs flipping.

**The bucket counts are NOT reproducible from a fresh query — read the delivered XLSX instead.**
Re-deriving the buckets on 2026-08-19 gave 13/47/77/18 where the workbook says 40/38/64/13, because
the original match was stricter than the obvious `contact_name` + Arabic-normalize join. The
authoritative record of which rows are in which bucket is the `Confidence` column of
`marketing-customer-owner-assignment.xlsx` (`1`, `1b`, `2`, `3`), built by `build-owner-sheet.cjs`
from a saved tool-result. **Do not re-bucket from SQL and assume it matches what he was sent.**

**APPLIED TO PROD 2026-08-19 — third and last bulk batch, 47 rows, at his instruction ("apply the 47
now"). Do NOT undo, do NOT re-run.** `marketing_customers` went **97 owned → 144** (78 unowned → 31).
Marker: **`Owner assigned 2026-08-19 (second batch%`** — three markers now exist, one per batch, and
they stay separable on purpose. Verified after: 47/47 rows have `manager_hr_id`/`line_id`/`area_id`
**identical to the owner's own `employees` row**, 0 half-stamped, 0 orphan seats, every owner active,
and the 31 still-unowned codes match the expected list character for character. Same rollback (four
columns back to NULL).

**The line test is what decided this batch, not the visit count.** Rules applied, in order: sole
active CRM visitor → assign; several visitors but the pharmacy's `mapped_area_code` puts the customer
in one region → keep only the reps working that region (a name matching reps in 2+ regions is 2+
different people, not a shared customer); rivals on DIFFERENT lines → **leave unowned and highlight**;
rivals on the SAME line → assign only if not close (≥2× or ≥+3 visits), else his call; no CRM visit at
all → successor holding that line+area seat, or the single rep covering the area, or a rep who already
owns another customer at the same pharmacy.

**The 31 left are 16 + 15, and the 16 must STAY unowned.** 16 are cross-line shared customers,
deliberately blanked on his instruction ("blank the 16 shared rows and highlight them only") — filling
one would pick a line and erase the other from view. The remaining 15 are genuinely unanswerable: 10
with no evidence of any kind (seed rows, never visited, no request, 2–3 reps cover the area — the
question is purely *which line*), 4 where one name matches reps in several regions, 1 real same-line
contest (`محمد كمال درويش`, Atef Sherif 5 visits vs Rana Adel 4 more-recent, both Anti Infective).

**Applying a batch CHANGES the buckets of the rows left behind — freeze the ownership state before
re-deriving.** The rule engine asks "does this shop already have an owner?" as its last fallback, so
after the 47 landed, one still-open row (`ROI-C-C7E946CB1925`) silently acquired an answer it did not
have on the sheet he was shown. Rebuilding the remaining questions must treat the already-applied
codes as unowned (`decisions.json` is the list). Caught by a guard, not by eye — always assert the
re-derivation still reproduces the delivered sheet's answers code-for-code before trusting its
leftovers. This is a SECOND, separate reason the buckets are not reproducible from a fresh query.

**A pharmacy code the marketing resolver cannot place usually resolves in the SALES master.**
`marketing_pharmacies.pharmacy_code` values come from the monthly uploads, so
`source_of_sales_customer_map` (`customer_code` → `area_code`, `active = true`) answers where a shop
is when `marketing_pharmacies` has null `region_name`/`extracted_area_name` and no GPS. That
recovered the area for all but one of the 15 open rows on 2026-08-19 — e.g. `357887`
(`نور الاسلام الخيرية`) → AB2. Remember `client_code` is unique only WITHIN a distributor, so a code
can legitimately return the same area under both `IS` and `IS-S`.

**GAP CLOSED 2026-08-19 22:43–22:54 Cairo, by AREA, from the parallel session — 175 active rows are
now 144 owned + 30 area-only-visible + 1 genuinely blocked.** A 27-row area backfill at 22:43 plus
three individual rulings (22:48, 22:52, 22:54) gave every remaining unowned row an `area_id`, which
is what grants sight. **Consequence: a "still unowned" count is NO LONGER the measure of the gap** —
query `owner_hr_id is null and area_id is null` instead. This also silently retired the
"15 questions" workbook (`xlsx/marketing-ownership-LAST-15-2026-08-19.xlsx`), which had been sent
minutes earlier and became redundant on arrival. **When two sessions share this queue, re-read the
target rows before delivering a decision sheet built even 30 minutes ago.**

**GAP FULLY CLOSED 2026-08-19 23:57 Cairo — `invisible_to_everyone = 0`, and 175 active rows are now
144 owned + 31 area-only.** The last holdout was `احمد الدالي` (`ROI-C-2C348E079C52`), whose pharmacy
`حضانة زمزم` (POS `0001511111`) had no sales row, no CRM visit and no GPS — all three of the usual
evidence routes empty, which both sessions confirmed independently.

**THE FOURTH EVIDENCE ROUTE: `direct_order_pharmacies`.** When sales, CRM and GPS are all empty, look
there — reps register shops in it with a **brick, area and region already verified**. `حضانة زمزم`
sits there five times (`DOP-000022` active/verified/trusted plus four inactive duplicates), all
brick `B192-1`, area **D15**, doctor `د هبة المهدي`, address المحلة الكبرى, all created by B-154, the
Pedia DM for that patch; `source_of_sales_bricks` confirms `B192-1` = المحله الكبرى in D15. That
resolved it: `source_of_sales_customer_map` id **736845** now maps `PS`/`0001511111` → D15/`B192-1`
(source `direct-order-evidence-hadanat-zamzam-2026-08-19`, confidence 90), and the customer carries
`area_id` 1104. **The `0001…` code format is exclusively distributor `PS`** — 28,640 rows, nothing
under any other. **Beware the decoy:** `مستشفى زمزم` is a DIFFERENT shop, in AB2 Alexandria.

**AUDITED 2026-08-20: all 31 area-only assignments are CORRECT.** 30 of 31 are corroborated by the
sales master through the linked pharmacy's own code; 24 of the 25 notes claiming "the code resolved
in the master" are literally true. **The one exception is `ملاك غالي عبد المسيح`
(`ROI-C-3013A7BC82EF`, GZ5): its note's stated evidence is FALSE** — code `GIZ137637` resolves
nowhere (no `GIZ%` code exists in the master at all; 2 marketing pharmacies carry that prefix and
neither resolves). The area is still right, via an exact system-unique NAME match —
`ص. محمد عبد الهادي جبر` under distributor `SF` code `1500018837`, address المعادي = Maadi = GZ5.
An audit correction is appended to that row's `validation_notes`; treat it as inferred, not proven.

**A CRM cross-check joined only to ACTIVE employees MANUFACTURES false conflicts — this nearly
produced three wrong findings.** Filtering `ireports360_visits` → `employees … employment_status =
'active'` drops the resigned or unmatched agent who is often the *strongest* visitor, leaving only a
same-named rep elsewhere in the country and making a correct assignment look wrong. Use
`agent_name`'s embedded patch label (`Gerges.Sameh ( Sohag 1 / F )`) and `crm_region_name` (the
town) instead — those survive resignation. Worked examples: أحمد النحاس (Tahta = Sohag, correct),
اشرف ابراهيم (Diarb Negm = Sharkia, correct), محمد موافي سعد (Balteem = Kafr El-Sheikh, correct).

**Resolving a code in the SoS master does NOT propagate to `marketing_customers` — it is two writes.**
Nothing reads the map into `marketing_customers.area_id`; that column is set directly, with the
evidence written into `validation_notes`. Expect to do both halves every time.

**`تعاقد الكهرباء جليم` (`ROI-C-F030C41D6796`) is a KEEPER — the owner ruled twice, do not
deactivate it.** Ruled at 22:54 (area Alex East) and again at ~23:50 when a decision sheet of mine
wrongly recommended deactivating it. It is a corporate-contract customer, and its sibling
`تعاقد شركة الكهرباء` (`ROI-C-25BD12B92D1E`) is active and owned by B-55 — assigned by my own 47
batch, which is what proved the shape legitimate. **No `marketing_customers` row has EVER been
deactivated (0 of 175) — TRUE ONLY UNTIL 2026-08-20, when the FIRST one was deactivated; see the وليد كمال entry at the end of this file.**

**Two of the 15 are data quality, not ownership.** `تعاقد الكهرباء جليم` (`ROI-C-F030C41D6796`) means
"Glim electricity contract" — a note typed into the doctor field in the seed import, linked to three
unrelated pharmacies in **three different regions** (CA2, AB1, D12); it wants deactivating, not an
owner. `احمد الدالي` (`ROI-C-2C348E079C52`) hangs off `حضانة زمزم`, a neonatal incubator unit whose
code `0001511111` is in neither CRM nor the sales master; 21 unrelated `زمزم` pharmacies exist
nationwide, so the name cannot place it either. Both were sent as open questions with the finding
written into the row, not guessed.

**`تامر حسني طاحون` and `تامر حسنى طاحون` are ONE doctor entered twice** (`ROI-C-3C8F1EA7C2B6` /
`ROI-C-EAFB43D6D468`) — codes differ only by ي vs ى, same pharmacy, same two visiting reps. Both sit
in the untouched 16. Not merged; flagged only.

**Watch the resigned trap:** the CRM match count and the *assignable* count differ (77 vs 64) because
13 matches point at resigned reps. Filtering `employees` by `employment_status = 'active'` AND a
marketing-capable `job_title` is what separates them — a raw CRM join silently over-reports
confidence. See [[marketing-not-found-codes-have-three-root-causes]].

**AUDIT of all 144 owned rows, 2026-08-20 — no assignment was wrong, but three traps surfaced.**
Population: 20 app-created + 64 first batch + 13 cover + 47 second batch. Structurally perfect —
0 owners missing from `employees`, 0 inactive owners, 0 half-stamped rows, 0 fake `area_id`, and
**0 rows with a NULL `area_id`**. Owner-seat consistency: `manager_hr_id` and `line_id` match the
owner's own `employees` record on 144/144; `area_id` matches on the 111 CRM batches and
deliberately differs on the 13 cover rows (customer's patch, by design) and on 18 app rows whose
owner is a *region-seated manager* (`egypt`=42, `cairo`=1, `giza`=7, `delta_1`=29, `delta_2`=35,
`alex_bhr`=23, `upper_egypt`=16) while the customer carries the precise area — that is correct, not
drift.

**`ireports360_visits.customer_name` IS A DEAD COLUMN — match on `contact_name`.** 122,577 rows,
**exactly one distinct `customer_name`** (34,590 empty strings + 87,987 NULLs). `contact_name` is the
doctor, 12,716 distinct. A CRM audit joined on `customer_name` returns silently EMPTY and looks like
"no contests found". Verify any zero here by relaxing the filter until the query provably fires.

**Cross-line "contests" are usually NAME COLLISIONS — check `contact_crm_id` before believing one.**
Only 3 active reps out-visit an owner and all 3 are cross-line (0 same-line, so the never-shift rule
is not in play). But `محمد صلاح` is **17 DIFFERENT DOCTORS** — 17 distinct `contact_crm_id`, in 17
different towns (Imbaba, Mataria, Menouf, Kafr Sakr, 6th October, El Khosous, Zagazig, Ma-adi…).
Owner B-161 holds id `101426` in El Khosous, his own patch; the two "rivals" hold `97558` (6th
October) and `100960` (Kafr Sakr) — other people entirely. `هاني الخولي` is the genuine 2-id
cross-line pair, already flagged and reverted. See [[cross-line-shared-customers-are-never-reassigned]].

**No marketing customer stores a CRM id — 0 of 144 have `marketing_customer_contacts.crm_code`, and
only 17 have a contact row at all.** So a marketing row can NEVER be pinned to a CRM contact id; every
CRM-derived owner is name-matched. **27 of the 111 CRM rows sit on an ambiguous name** (12 first
batch, 15 second). In all 27 the owner personally visits one of the same-named doctors, so no owner
is a stranger to the name — but which doctor the row *means* is unprovable from stored data. Populate
`crm_code` before trusting these rows further. See [[marketing-not-found-codes-have-three-root-causes]].

**7 second-batch rows have an owner who never visited the doctor — all legitimately.** 4 had only a
resigned/terminated visitor (`أسامة صبحى`, `احمد سلمان`, `رضا عبدالرازق عريضه`, and the B-168 half of
`مستشفى دار الولادة`), 3 had a CRM agent with NULL `agent_hr_id` whose label patch nonetheless names
the owner's own area (`( Sharkia / E )`→B-186 Sharkia 1, `( Alex East / E )`→AI-0002 Alex East,
`( Cairo East 2 / F )`→B-161 Cairo East 2). The one ACTIVE non-owner visitor, B-74 on
`مستشفى دار الولادة`, has a single out-of-patch visit against the Alex Center owner's patch — right
call. **The unmatched-agent CRM label is real evidence; do not discard a row because `agent_hr_id` is
NULL.**

**A customer's area disagreeing with its pharmacy's master area is NORMAL, not a defect** — 23 of 144.
A doctor sits in the owner's patch while their scripts dispense in the neighbouring area (UE1/UE2,
UE3/UE4, AB1/AB2, CA3/CA4…). Area follows the OWNER's seat by construction, so the owner is what
decides correctness, not the pharmacy link. Only `مستشفى الصدر العام` (D26 vs CA2/D21/D22/D23) spans
four areas — a generic hospital name matching several pharmacies, same collision class as above.

**GZ6 Fayoum (1118) and UE9 Beni Suef (1145) hold a customer each but have ZERO employees** — nobody
gains territory-route sight of those two rows; only the owner and their chain see them. Not a defect,
but the territory route is inert there. See [[fayoum-beni-suef-golden-rule-per-line]].

**CRM ids POPULATED for the 27 ambiguous rows — PROD, 2026-08-20.** `crm_code` had never been used:
0 of 144 owned customers carried one and only 17 had a contact row at all, all app-created. So this
needed **27 NEW `marketing_customer_contacts` rows**, not an UPDATE — `marketing_customers` has no CRM
column, and `marketing_customer_contacts.crm_code` is the only home. Shape copied from
`service.ts:5287`: `contact_code` = `MKT-CON-YYYYMMDD-` + 8 upper hex, `contact_name` = the customer's
display name, `created_by_hr_id` **NULL** (no human actor, same convention as the ownership batches).
All 27 carry their derivation and a `ROLLBACK: delete this contact row` line. Verified after the
write: 27 rows, 0 missing a code, 0 pointing at a non-existent `contact_crm_id`, 0 whose owner never
visited that id, 0 customers with two contact rows, 44 active contacts total. Negative control passed
— a nonsense id makes both assertions fire.

**The disambiguator is the OWNER's own visits, and it works: 20 of 27 land on exactly one id.**
The other 7 are the SAME doctor registered TWICE in the CRM (same owner, same region), not two people
— and the pattern is a re-registration: the old id's visits stop and the new id's begin. Chosen id is
the one the owner currently calls on; the superseded id is written into the row's `notes` so nothing
is lost. `مركز يقظة` is the clean case (98226 ends 2026-07-27, 107425 begins 2026-08-03 →
**107425**). `عمرو درويش` inverts it — 105073 is a same-day 1-visit duplicate, so the established
85323 wins; **owner-only visit counts tied at 1 each and only the all-agent totals (5 vs 1) broke it**.

**`هشام حسن` explains the old B-59 vs B-105 "contest" — it was never a contest.** B-59 visited the
shared record 62715 until 2026-02-23, then created/moved to his OWN record 97274 from 2026-03-07,
while B-105 kept calling on 62715 (17 visits, to 2026-08-19). Two CRM records, one doctor, one rep
each. Stored 97274 (the owner's live record) with 62715 noted. See
[[cross-line-shared-customers-are-never-reassigned]].

**STILL UNLINKED: the other 84 CRM-assigned rows** (52 first batch + 32 second) whose names are unique
in the CRM. They are not ambiguous, so nothing is at risk — but they carry no `crm_code` either, and
linking them is the same one-statement job keyed on `customer_code`.

**SECOND PASS 2026-08-20 — the remaining 84 unique-name rows: 81 linked, 3 cannot be.** Total now
**108 of the 111 CRM-assigned rows carry a `crm_code`**; 125 active contact rows exist overall
(17 pre-existing app rows + 108 written today). Verified: 0 codes pointing at a non-existent
`contact_crm_id`, 0 customers with two contact rows, and **0 `crm_code` claimed by two different
marketing customers** — so no duplicate-customer pair surfaced through the CRM link. This pass was
written as one `INSERT ... SELECT` with the resolution computed in SQL, not a hand-typed VALUES list.

**The 3 that CANNOT be linked have no CRM visit under their name at all** — not ambiguous, absent:
`احمد البليدي` (`ROI-C-1765293EBFD6`) and `احمد عاطف عبدالجواد` (`ROI-C-1BEE00AD9DD7`), both owner
B-182 in CA1, and `محمد فتحى عيسى` (`ROI-C-5F9C9EEAB43A`), owner CN-0001 in CA2. Their owners came
from somewhere other than the CRM, so a CRM id will never exist for them unless the rep registers the
doctor. Do not "fix" these by attaching a near-match id.

**7 of the 81 have a unique name but an owner who never visited it** — the same 7 the audit found
(`أسامة صبحى`, `احمد الحوشي`, `احمد سلمان`, `بهاء محمد عمر`, `رضا عبدالرازق عريضه`,
`مستشفى السلام العام`, `مستشفى دار الولادة الماترنتيه`). **Uniqueness of the name is what makes those
ids certain, NOT the owner's visits** — their notes say so explicitly, so a later reader does not
mistake them for the owner-visit-derived majority.

**Still unlinked by design: the 13 cover rows and the 20 app-created rows.** The cover rows' only CRM
visitor is a resigned rep (that is why they are cover), and the app rows were typed by a manager in
the UI. Both are linkable by the same method if wanted — neither was in scope for this pass.

**THIRD PASS 2026-08-20 — cover (13) and app (20) linked too. 133 of 144 owned rows now carry a
`crm_code`.** Remaining 11 are unlinkable: 8 app + 3 second-batch whose names appear NOWHERE in
`ireports360_visits`. Per batch: first 64/64, second 44/47, cover 13/13, app 12/20. Verified: no
`crm_code` points at a non-existent `contact_crm_id`.

**App rows need an UPDATE, not an INSERT — 17 of the 20 ALREADY had a contact row** (the app writes
one whenever a speciality or mobile was entered, `service.ts:5284`). Only 3 needed a row created.
Writing blind INSERTs here would have produced two contact rows per customer. Always check
`marketing_customer_contacts` for an existing row before inserting.

**`validation_notes IS NULL` on 2 app rows silently ate them TWICE.** `notes not like 'Owner
assigned%'` evaluates to NULL, not TRUE, so those rows vanish from any batch filter without error —
first in a survey (18 instead of 20), then again in the UPDATE because a stray
`validation_notes is distinct from null` survived a redraft. Always write
`(validation_notes is null or validation_notes not like ...)`, and **reconcile the batch counts to
144 before trusting any of them**.

**A cover row's discriminator is the RESIGNED rep named in its own note, never the owner** — the
owner is a stand-in who by definition never visits. Two cover rows needed adjudication:
`محمد حسين عبدالغنى` is ONE doctor registered **FOUR times** (88341, 97396, 102260, 105906 - all
B-52 Fiby Wagdy, all region Ebshwai, sequential re-registrations; live = 105906), and
`بيتر فتحي` is **TWO DIFFERENT DOCTORS** - 96138 in Tahta (Sohag, the resigned B-112's patch, which
this row covers) vs 87639 in Abanob (ASSIUT, B-13 Rana Adel). **The revert on that row was right but
its stated reason was wrong: the note calls it a doctor "seen by BOTH lines", and the contact ids and
regions say they are two different people ~100km apart.** Do not cite it as a cross-line example.

**DUPLICATE FOUND, not fixed — `وليد كمال` is ONE doctor with TWO marketing customer rows.**
`MKT-HCP-20260816-A5F808BC` and `MKT-HCP-20260818-E9AE3F1D`, same owner B-116, same area CA1, both
now resolving to CRM contact `99422`. This is exactly what the CRM link is for: a shared `crm_code`
is the cheapest duplicate detector this data has. **Left as-is** - deactivating a marketing customer
is the owner's call (see the `تعاقد الكهرباء جليم` ruling above). SUPERSEDED THE SAME DAY — the owner ordered this one deactivated; see the entry below.
Compare [[duplicate-pharmacy-test-is-name-and-gps-not-brick]] - for CUSTOMERS the test is a shared
`crm_code`, not name+GPS.

**FIRST EVER DEACTIVATION 2026-08-20 — `وليد كمال` `MKT-HCP-20260818-E9AE3F1D`, at the owner's
instruction.** `marketing_customers` is now 175 rows: **174 active, 1 inactive.** Any doc or memory
saying "no row has ever been deactivated" is stale from this date — the two lines above are corrected.

**Which twin to keep is decided by REQUEST HISTORY, not by evidence quality or recency.** The Aug 16
row (`MKT-HCP-20260816-A5F808BC`) survives because it carries `MKT-REQ-20260817-A60E46B0` (rejected
2026-08-17); the Aug 18 row had **no requests**, so deactivating it stranded nothing. Confirm this
with a `marketing_requests` count on BOTH rows before deactivating either — and put
`not exists (select 1 from marketing_requests where customer_id = c.id)` in the `WHERE` so the write
no-ops if that changed underneath you.

**The kept row is the WEAKER record, and that is a live follow-up.** The deactivated Aug 18 row had
`evidence_status = complete` and the precise address "16 Mansoura"; the surviving Aug 16 row is
`evidence_status = pending` with a vaguer address, and was created by B-10 rather than by the owner
B-116. **Evidence needs re-capturing on the Aug 16 row.** The reconstructed sequence: B-10 created it
Aug 16 → B-116 raised a request Aug 17 → REJECTED → B-116 re-created the customer Aug 18 with proper
evidence instead of reusing the first. **A rejection is what makes a rep mint a duplicate** — expect
more twins behind rejected requests.

**Deactivating the customer is enough to clear a duplicate `crm_code`** — the contact row was left
active and untouched, because every visibility and duplicate query gates on `marketing_customers.active`.
After the write: 0 crm_codes claimed twice, 143 owned active rows, 132 of them CRM-linked.

## Duplicate marketing customers: the driver is UNREACHABILITY, not rejection (2026-08-20)

I previously wrote "a rejection is what makes a rep mint a duplicate — expect more twins behind
rejected requests." **That is wrong and must not be repeated.** Prod has exactly **2 rejected
requests in its entire history** (9 requests total: 6 pending_approval, 1 approved, 2 rejected).
One produced a duplicate; the other produced none. A sample of one is not a pattern.

- `MKT-REQ-20260817-A60E46B0` -> وليد كمال — rejected, and B-116 then minted
  `MKT-HCP-20260818-E9AE3F1D`. Deactivated 2026-08-19.
- `MKT-REQ-20260811-FF5B0719` -> أحمد محمد عياد (`ROI-C-85CB25901B6F`, seed row, owner B-100,
  area 1100) — rejected 2026-08-11, **no duplicate followed**.

**The real driver, found by trigram search, is that the existing row cannot be reached** — which is
this file's ownership gap producing duplicates as a side effect:

- **مدحت ابو ربع, Giza-Giza Centers (1113).** `ROI-C-08EB425C845F` is an **unowned** seed row, so
  nobody can raise a request against it. DSM B-94 (Taha Mohamed) created
  `MKT-HCP-20260818-D34E996E` "مدحت حسن ابوربع" on 2026-08-18 with complete evidence and a request
  now `pending_approval`. Same doctor. CRM holds him **3 times**: 97266 + 93715 (both Mostafa.Galal,
  Giza-Giza Centers / **F** — a re-registration) and 62781 (Mariem.Ezzat, Giza Centers / **E**).
- **انجي جاد, Sohag1 (1127).** `ROI-C-CB272A9C1554` "انجي جاد عبداللة" is owned by **B-151 = Maria
  Sobhy**, who is literally the CRM agent calling on her (crm 85309, 10 visits Feb→Aug). Product
  Manager **A-10 (Nahed Hattab, P.M / E)** could not raise against another rep's customer, so on
  2026-08-18 he created `MKT-HCP-20260818-1105B9B3` "انجي جاد" (crm **107519**, 1 visit 2026-08-17
  by Marian.Samir, Sohag 1 / **C**) and raised `MKT-REQ-20260818-8C628BF4`, still pending.

**Do NOT deactivate either of those two.** Both carry a LIVE pending request, and in both cases the
second CRM id belongs to a **different line** (A vs C; F vs E) — that is the owner's *cross-line
shared customer = "treasure", never reassign* rule, not a contest. Escalate, don't merge.

**Third duplicate, inert:** تامر حسني طاحون — `ROI-C-3C8F1EA7C2B6` + `ROI-C-EAFB43D6D468`, both
active, both **unowned**, area 1102, seeded 60 seconds apart on 2026-06-20. Pure seed-import
artefact, zero requests, nothing depends on it.

**Unresolvable, and it does not matter:** `ROI-C-CFD7CB22FC70` "احمد سعيد النحاس" vs
`ROI-C-A31E83C2F5F8` "أحمد النحاس", both unowned in Sohag1 with no requests. CRM has **6 distinct
النحاس ids**, so a name cannot decide it. Leave alone.

### The two tests that fail here, and why

1. **GPS cannot see 89% of the table.** Only **20 of 175** rows have coordinates — exactly the
   app-created `MKT-HCP-%` rows. All **155** seed `ROI-C-%` rows have none. Any duplicate hunt built
   on distance silently covers only the app rows. (Of 5 pairs under 300m, only وليد كمال was a real
   duplicate; the rest are different doctors in one building.) Worse, `Ramzy Riad` and
   `Reda Solimany` (both owner A-10) share coordinates identical to 7 decimal places —
   `31.2438959, 29.9820828` — so one capture was reused and neither row's GPS is independent
   evidence.
2. **Matching on `crm_code` finds nothing, and that is a false negative.** Zero duplicate crm_codes
   across all 133 linked rows — but انجي جاد is a duplicate whose two rows hold 85309 and 107519.
   **When CRM itself registers a doctor twice, a crm_code equality test cannot see the duplicate.**
   Use normalized-name trigram similarity within an area (`pg_trgm` IS installed on prod):
   `similarity(nname_a, nname_b) >= 0.45` + same `area_id` surfaced all three real cases; exact-name
   equality surfaced only one. Cross-area at `>= 0.55` returned 10 pairs, all genuinely different
   (the "مستشفى … العام" hospital suffix is a decoy).
