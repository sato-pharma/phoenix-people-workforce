---
name: marketing-not-found-codes-have-three-root-causes
description: "A not_found marketing pharmacy code is usually a wrong distributor or a padding mistake, not a bad code — and chimipharm can NEVER match"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9f9d1d5e-92b5-4eaa-a238-ad2fc773fd35
  modified: 2026-08-21T00:37:49.622Z
---

Audited every `not_found` row in `marketing_pharmacy_distributor_codes` on prod 2026-08-19 and drove
23 → 8 (13 repaired here; 2 more vanished when another session deleted the `satotest`/`Hhhhh` test code
rows — **and later that day the same session deleted the orphans too**, so the pharmacies do NOT
survive: `satotest` + `Hhhhh`, their customers `satopharma test` (A-9) and `Sato` (PD-0006), and 2
cascaded contacts are all gone. Backed up, reversible, in five `marketing_rollback.*_2026_08_19`
tables with `anon`/`authenticated` revoked. Verified after: `marketing_requests` unchanged at 9). Almost none were "the rep invented a
code". Three recurring causes, in order of frequency:

**1. Wrong distributor picked, and some distributors can never match.**
`marketing_distributors` id 13 **`chimipharm` has ZERO rows in `marketing_pharmacy_code_references`** —
so *every* code ever entered under chimipharm is automatically `not_found`, regardless of correctness.
Same trap waiting on any distributor with a thin list (`egd 1002` 19 rows, `epda` 56, `mec` 141).
Nosiba B-1 hit this: entered `chimipharm/1511917`, the real shop was `POS/0001511917`.

**2. POS zero-padding applied to a code that is NOT a POS code.**
POS codes are 10 digits zero-padded (see [[pos-pharmacy-codes-are-zero-padded]]); Ibn sina codes are
exactly 6. Users pad an Ibn sina code to 10 and file it under POS — `0000428289` was really
`Ibn sina 428289`, `0000463630` was really `Ibn sina 463630`. **When a code looks not_found, also try
`ltrim(code,'0')` against the OTHER distributors**, not just `lpad(code,10,'0')` against the same one.

**3. Our reference list is stale, so the code is real and we just don't have it.**
Confirmed by `master_match_kind = 'exact'` while `reference_status = 'not_found'` — the master
resolver found it in `source_of_sales_customer_map` but the 07-29 reference import lacks it. Correct
repair is `reference_status = 'manual_approved'`, which clears the block **without asserting a
different shop**. See [[marketing-reference-list-is-a-point-in-time-import]].

**The gate is scoped to `not_found` ONLY** — `service.ts:1990`. So `matched` and `manual_approved`
both pass; there is no need to invent a match to unblock someone.

**How to identify the right shop, in order of strength:** the rep's captured GPS
(`marketing_pharmacies.captured_latitude/longitude/captured_address`, typically ±25m) beats the name,
which beats the code. `area_id` on that table is the SUBMITTER's coarse area, NOT the shop's — 286 of
309 are NULL, so never read geography from it. See
[[marketing-master-resolver-never-runs-automatically]].

**Uniqueness inside the GPS town is the test, not how distinctive the name looks** — and the town is
the TOWN, not the markaz. `عمرو` (POS `1501992`, B-94, on LIVE request `MKT-REQ-20260818-D9E88E15`,
EGP 550) looked undecidable at first: several البدرشين candidates named عمرو. It resolved once the
reverse-geocoded GPS was read literally — *"Madinet Al Badrashin"*, the town centre, 13.6m accuracy.
The rival عمرو rows sit in named VILLAGES of the same markaz (`الطرفاية`, `قلعة المرازيق`), which the
town label excludes; inside the town there is exactly one, `IS 407144 = عمرو`, and the name matches
bare-to-bare. Same test decided `الشفاء` (Kotoor). **Read the geocoded locality as evidence — markaz
and town share a name in Egypt and collapsing them is what makes a shop look ambiguous.**

**A code that appears in NEITHER the master NOR the reference list, in any padding form, is a dead
code — overwriting it destroys nothing.** Worth checking before you agonise: `1501992` was sitting on
TWO different pharmacies (`عمرو` and `هبه خالد`), which marks it as a copy-paste default rather than
a real code. Ibn sina `431302` on the تبارك row was equally absent everywhere.

**A seed row's `marketing_customer_pharmacies` link can supply the geography the row itself lacks.**
That is how `صيدلية خاصة بمستشفى تبارك للاطفال` was solved — the row had no GPS, but its linked
customer was `مستشفي تبارك المريوطيه`, and the master holds exactly one تبارك at المريوطية
(POS `0001533787`). Check that link before writing a seed row off.

**The 8 still open are unprovable, not unexamined — do not re-audit them from scratch.** All 8 are
seed rows from 2026-06-20 16:44–16:47: `created_by_hr_id` NULL, `evidence_status = 'missing'`, no
GPS, no area, `marketing_pharmacies.pharmacy_code` set to the distributor code itself — an import
artifact, never a field-captured shop.

**RE-VERIFIED on prod 2026-08-21 and the set is now 7** — حضانة زمزم was retired that night
([[seeded-marketing-pharmacies-have-no-area-and-are-invisible]]). Re-proved live rather than taken
from this note: all 6 real digit-codes are absent from `marketing_pharmacy_code_references` under
**every** distributor digit-normalized (`ltrim(regexp_replace(code,'\D','','g'),'0')` on both sides),
and absent from `source_of_sales_customer_map` under every distributor too. **Every distributor
family IS correctly mapped** — rebuilding the resolver's own `fam` CTE showed POS→`PS,PS-T`,
EGD→`EG,EG-BR,EG-HOS`, Ibn sina→`IS,IS-S,IS-T`, chimipharm→`CP`, so the resolver had a valid search
space in all 8 cases and genuinely found nothing. Root causes 1 and 2 are ruled out afresh; the codes
exist nowhere in Phoenix. Each still carries exactly 1 link and **0 requests**.

**What DID change: all 7 now carry an area** (`Area inferred 2026-08-21`, from the linked customer) —
AB4, GZ5 ×2, UE4, GZ1 ×2, AB3. That matters because they were invisible to every rep before, and
**new field evidence is the only thing that can ever close them** — a shop nobody can see is a shop
nobody will revisit. Do not read the areas as progress on the codes; the codes are unchanged.

**`master_match_kind = 'unresolved'` and `reference_status = 'not_found'` are different questions.**
Prod 2026-08-21 had 8 `unresolved`, of which 7 are this cohort and the 8th
(`مصطفى القاضى الجديده`, POS `1552116`) is a different class entirely — app-captured 08-17 with real
GPS and `reference_status = 'matched'`. It is in the reference list and merely has no sales history.
Do not lump it in with these 7. **Verified 2026-08-19: all 8 carry ZERO requests**, so they
block nobody and no spend rides on them. All 8 codes are absent from the master AND the reference
list under every distributor and every padding variant, so root cause 3 does not apply either — the
master does not know these codes. Exhausted without success: trigram `similarity()` with Arabic
normalization (`محمود عبدالله` scores 1.000 against TWO shops in different governorates — D24 and
GZ1 — which is the shape of the whole set), per-token `like` searches, and the customer linkage.
`الحداد/ المعادى` has no الحداد anywhere in Maadi; both زمزم rows are a hospital and a nursery, which
are not in a pharmacy master at all; `ROI-P-CC7FF70B600D` is a synthetic placeholder that can never
match. **Only new field evidence — a rep revisiting with GPS — can close these.**

**There is no rep on these rows to ask, and the marketing tables cannot tell you who to ask.** All 8
pharmacies and all 7 linked doctors have `owner_hr_id`, `manager_hr_id`, `line_id` and `area_id`
NULL — and that is systemic, not local: **155 of 175 active `marketing_customers` have no owner**
(measured 2026-08-19). The route that DOES work is `ireports360_visits` — it carries `agent_hr_id`
against `contact_name`, so the CRM knows who calls on a doctor even when marketing does not.
Exact-name hits: هاني نبيل الدكروري → Mostafa Galal B-59; ايهاب سمير لوقا → Rana Adel B-13;
حسام البصراتي → Fatma Gharib B-136 (Maadi, which corroborates `الحداد/ المعادى` + `المعادى2`);
هشام عبدالفتاح الفارّ → Ahmed Abdallah B-74. **Owner said 2026-08-19: do NOT contact these reps.**
Nothing was sent. The lookup is recorded so it need not be re-derived, not as a licence to act on it.

**Two were applied on NAME ALONE, at the owner's explicit instruction 2026-08-19** — `احمد العشرى` →
POS `0001529791` [AB4], `محمد الباجورى` → POS `0001544713` [CA1]. I flagged that the geography is
uncorroborated (seed rows carry no GPS/address/area) and he confirmed anyway; both `validation_notes`
record the prior value and say the name was the sole evidence. **If either ever looks wrong, that note
is the rollback.** Do not treat these two as precedent for name-only matching in general.

**UPDATE 2026-08-22 — the 8th row above (`مصطفى القاضى الجديده`, POS `1552116`) is now DEACTIVATED,
and the reason overturns a rule stated earlier in this file.** Owner ruled it a duplicate of
Nermeen Salah's `القاضى` (`MKT-PHA-20260822-9736ED77`), and the proof was the code itself: both rows
carry the **identical POS `1552116`**. Same distributor, same number — one shop. The code is still
live, still `matched`/`unresolved`, now on Nermeen's active row. **Do not re-audit it as a new
finding; it is the same code that was already examined.** Ahmed Elsayed Ahmed's `الشفاء`
(`MKT-PHA-20260817-E0D3A790`) was deactivated the same night. Both are soft-deletes
(`active = false`, audit rows written), reversible.

**The GPS-beats-name rule in this file has an exception: check whether the submitter reused ONE
coordinate across several rows before trusting it.** Ahmed captured BOTH his Qotour shops at the
byte-identical point `30.96825, 30.96003` with the same coarse address, 2026-08-17 12:38 — two
different shops, one pin. Nermeen's three Qotour rows are three distinct points with plus-code
street addresses. So "±25m accuracy" describes the *device*, not the *discipline*; a repeated
coordinate across a submitter's rows means the GPS carries no per-shop information at all and the
name or the code has to decide. **Group a submitter's rows by rounded lat/lon before using GPS as
the strongest evidence.**

**A resolved code can be stranded by a de-duplication.** Ahmed's `الشفاء` held **Ibn sina `361157`**,
`matched`/`exact`, mapped to area D14, brick `B193-5`, region D1 — the only fully-resolved code on
either الشفاء row. Nermeen's surviving `الشفاء الجديدة` held only POS `1558287`, which is
`not_found`. Deactivating the duplicate would have parked the one working code on a dead record, so
on the owner's instruction the code row was **repointed** (`pharmacy_id` updated, audit row carries
the old id for an exact reversal) onto `MKT-PHA-20260822-1B087E4D`. **Before deactivating any
duplicate pharmacy, compare the distributor codes on both rows — the record you are deleting may
hold the better code, and they are often under DIFFERENT distributors, so neither is wrong.**

Qotour is now 3 active rows, all Nermeen's, all Gharbia 1 (D14): `الشفاء الجديدة`
(Ibn sina 361157 exact + POS 1558287 not_found), `القاضى` (POS 1552116 matched/unresolved),
`محمد منديشة` (POS 1507324 exact). **OPEN, owner sending 2026-08-23:** the real shelf POS codes for
`القاضى` and `الشفاء الجديدة`, because neither POS number resolves. Until they do, transferring
either shop to Direct Orders reproduces the حضانه النيل fault —
[[marketing-transfer-writes-no-distributor-link-when-the-code-is-unresolved]].

**CLOSED 2026-08-23 by audit, not by the owner's shelf reading — do not keep waiting for it.**
The line above says "OPEN, owner sending 2026-08-23". It is answered; the two shops had opposite
root causes.

**`القاضى` → POS `0001507348` (`السيد عطية القاضى ن.م`), brick `B192-11`, area `D15`.** Six
independent checks, all on prod `ozucdzovmcqvepbozvqf`:
1. It is the **only** القاضى inside Qotour town in the whole `D1` region. The other 17 القاضى rows
   sit in D11, D12, D13, D16, D17, or Samannoud — the town-uniqueness test in this file, applied.
2. Registered address `قطور المحطه شارع الجيش` matches Nermeen's GPS (`XX94+QVH, El-Khalig,
   Madinet Qotour`), ~80 m from her already-confirmed `محمد منديشة` at `قطور المحطه`.
3. **It has real sales** — 2 periods (2026-01, 2026-02), 4 units, in
   `source_of_sales_customer_directory_rollup`. A live shelf account, not a registration.
4. Same brick `B192-11` as منديشة.
5. Unclaimed — no `marketing_pharmacy_distributor_codes` row anywhere holds it.
6. The naming pattern matches منديشة exactly: the master carries the **full personal name**
   (`السيد عطية القاضى ن.م`), the marketing row the **short trade name** (`القاضى`). Searching the
   master for the trade name alone is what hid this for a week.

**The code currently on the row, POS `1552116`, is the wrong shop.** Its reference row registers it
at **`الشين- قطور` — Al-Sheen VILLAGE, not the town** — and it is the **only one of POS's 19 Qotour
reference rows with no master identity and no sales at all**. It cannot win the owner's
code-beats-GPS rule, because that rule decides an *area* for a code that resolves; this one resolves
to nothing (`mapped_area_code` NULL). Note this overturns nothing — it means the code was
mis-entered, which is root cause 1/2 of this very file.

**`الشفاء الجديدة` → there is NO POS account. Stop looking for one.** Proved by exhaustion, not by
failing to find it: POS has exactly **19** Qotour rows in `marketing_pharmacy_code_references`, and
**all 19 are now individually named against the master** — none is الشفاء. The POS/PS-T population of
the town centre (`شارع الجيش` / `المحطة`) is exactly four shops: القاضى, منديشة, `عسكر`, and
`شاكر محمد طلبه عيد`. The shop's real account is the **Ibn sina `361157`** it already holds
(`matched`/`exact`, `قطور قطور`, `B193-5`, `D14`). **POS `1558287` is a dead code** — absent from the
master AND the reference list under every padding, and zero sales. The repair is to **retire it, not
replace it**; per this file, overwriting a dead code destroys nothing.

**Consequence to decide before applying, not after:** adopting `0001507348` moves `القاضى` from
`D14` to **`D15` (Gharbia 2, Mahalla)** under the owner's code-wins rule — consistent with the
earlier `B192-11 → D15` correction in
[[seeded-marketing-pharmacies-have-no-area-and-are-invisible]]. Its neighbour `الشفاء الجديدة`
stays `D14` on its Ibn sina code, 80 m away. **Qotour town genuinely straddles two bricks in the
master** (`B192-11`→D15, `B193-5`→D14) — that split is pre-existing, it is not introduced by this
change, and it should not be "tidied".

Assigning `0001507348` will land `reference_status = 'not_found'` even though it is correct — the
07-29 POS reference import lacks it (it appears only under `overseas`, address-less, from
`Phoenix_All_Customers_Distributors.xlsx`). That is **root cause 3 above**; the repair is
`manual_approved`, not inventing a reference row.

**APPLIED TO PRODUCTION 2026-08-23, owner said "apply". Three writes, three audit rows, all
reversible. Do not undo.**

| Row | Before | After |
| --- | --- | --- |
| `القاضى` POS code (`ffcb3a90-…`) | `1552116`, matched/**unresolved**, ref_id 8553 | **`0001507348`**, manual_approved/**exact**, PS, **D15**, `B192-11` |
| `الشفاء الجديدة` POS code (`51a36a83-…`) | `1558287`, not_found/unresolved, **active** | **retired** (`active = false`) — not replaced |
| `القاضى` pharmacy (`6c87b8b4-…`) | `area_id` 1103 (**D14**) | **1104 (D15, Gharbia 2 Mahalla)** |

🔴 **The resolver settled it independently, and that is the proof worth keeping.**
`phx_resolve_marketing_pharmacy_codes` returned **`exact`** on `0001507348` first try, populating
`PS` / `D15` / `B192-11` — the same mapping predicted from the master. The same function had
returned `unresolved` on `1552116` every time it was ever re-run. **The verdict came from the
system, not from the reasoning.** Rollback values are written verbatim into each row's
`validation_notes` and into `audit_logs.old_values` (actor `SUPER-ADMIN`, entity types
`marketing_pharmacy_distributor_code` ×2 and `marketing_pharmacy` ×1).

**Both shops are now transferable to Direct Orders — the حضانه النيل fault cannot recur here.**
The capture gate is at `service.ts:2140`/`2167`, **not** the `1990` cited earlier in this file (the
file moved). It throws `pharmacy_code_not_found` for `code.active === false` *before* the
`not_found` check, so **retiring the dead code removed it from the picker entirely** rather than
leaving it there to be force-through with an override note. القاضى passes as `manual_approved`;
الشفاء الجديدة passes on Ibn sina `361157` (`matched`). Neither needs an override reason.

**Two PRE-EXISTING leaks found by the post-change integrity sweep — NOT caused by this change, and
deliberately left alone.** `live codes on dead pharmacies` came back **2**, where
[[seeded-marketing-pharmacies-have-no-area-and-are-invisible]] requires 0:

- `مصطفى القاضى الجديده` (`MKT-PHA-20260817-8FB05F56`, deactivated 08-22 16:29) still holds POS
  `1552116` **active** — `code.updated_at` is 08-17, i.e. never touched by the consolidation.
- `صيدليه حضانه النيل` (`MKT-PHA-20260822-A45F0F4E`, deactivated 08-22 16:10) still holds EGD
  `0000` **active**.

Both are the 08-22 duplicate-consolidation session hitting the exact trap this file already warns
about. Timestamps prove authorship — **check `code.updated_at` against the pharmacy's
deactivation time before blaming your own write.** After this change `1552116` is registered to
nothing live at all, since its only live home was the القاضى row.

**`محمد منديشة` has the same D14/D15 mismatch القاضى just had** — pharmacy `area_id` D14, code
`1507324` resolving `D15`/`B192-11`. Untouched: the owner named two shops, not three. One line
fixes it if he wants it.

**CLEANUP APPLIED 2026-08-23 ("fix anything needs to be fixed regarding this matter"). Three more
writes, three more audit rows — six in total for the day. Every integrity check now reads 0.**

| Fix | Row | Change |
| --- | --- | --- |
| Orphan | POS `1552116` on dead `مصطفى القاضى الجديده` | `active = false` |
| Orphan | EGD `0000` on dead `صيدليه حضانه النيل` (`A45F0F4E`) | `active = false` |
| Area | `محمد منديشة` (`9b9203aa-…`) | `area_id` 1103 (D14) → **1104 (D15)** |

🔴 **The class was TINY, and measuring it first is what made the fix safe.** Before writing anything
the sweep counted **1 area mismatch out of 289 resolved pharmacies** and **2 orphan codes, both with
zero live links** — so this was three rows, not a bulk change needing an announcement. **Always size
the class before deciding whether §8's bulk-change rule applies.** The 2026-08-21 retag really was
thorough; منديشة and القاضى were 08-22 captures that came in on the capturer's area.

Final state, all verified 0: live codes on dead pharmacies, live links on dead pharmacies, live
links on dead customers, active pharmacies with no code, active pharmacies with no area, **and
area-disagrees-with-an-exact-code**.

🔴 **Moving a pharmacy's area does NOT hide it from the rep who captured it — check `owner_hr_id`
before fearing it does.** Nermeen `B-154` is a **District Sales Manager whose own `area_id` is D12
(Menoufia 1)**, yet she owns all four Qotour/Shibin rows via `owner_hr_id`, so branch 1 of
`canReuseMarketingPharmacy` keeps them visible to her no matter what area they carry. The area move
only changes which *territory* reps additionally see them — which is the point of getting it right.

**Two neighbouring shops legitimately end up in different areas.** `القاضى` + `محمد منديشة` are D15
(brick `B192-11`); `الشفاء الجديدة`, 80 m away, is D14 (brick `B193-5`). That is the master's own
brick split for Qotour town, applied consistently under the code-wins rule. **Do not "tidy" it.**

**Checked and CLEARED — not a defect:** `حضانه نور المصطفي` carries POS `0001000000` resolving
`exact`, which looks like a placeholder that matched spuriously. It is a **genuine master row**
(`PS 0001000000`, brick `B201-1`, D12), as is `حضانة زمزم`'s `0001511111` (`PS`, D15). Odd-looking
round codes here are real. No false-`exact` problem exists.

**LEFT ALONE DELIBERATELY — the live `صيدليه حضانه النيل` (`MKT-PHA-20260822-AB011209`) still
carries EGD `0000`.** Retiring it would be a REGRESSION: it is the shop's only active code, and an
active pharmacy with no code cannot be put on a request at all. `0000` is a placeholder the rep
entered, and the capture gate already handles it correctly — it forces a written override reason
rather than passing silently. Searched and **not findable in Phoenix**: no `النيل` row anywhere in
the master sits in Shibin el Kom (the five `النيل` rows are Banha ×2, Menouf ×2, Tala), and none is
a nursery pharmacy. **Only Nermeen re-reading the shelf can close this one** — it is the same
"unprovable" class as the 7 seeds, except app-captured with real GPS and a live link, so field
evidence CAN close it. That is why the not_found count is 8 and not 7.
