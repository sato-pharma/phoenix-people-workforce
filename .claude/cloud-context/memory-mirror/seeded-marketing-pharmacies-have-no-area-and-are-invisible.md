---
name: seeded-marketing-pharmacies-have-no-area-and-are-invisible
description: "Marketing visibility is TERRITORIAL (area_id), not ownership — and every one of the 2026-07-02 seeded pharmacies has area_id NULL, so they are invisible to every rep in the system and cannot be captured."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-21T00:31:57.358Z
---

**Visibility for BOTH marketing customers and pharmacies is the same territorial rule.**
`canSeeMarketingCustomer` and `canReuseMarketingPharmacy` in
`src/lib/marketing-requests/service.ts` are byte-for-byte the same predicate:

1. hierarchy on `owner_hr_id` / `manager_hr_id`, **or**
2. `row.area_id === viewerAreaId`, where the viewer's area is `employees.area_id`.

Branch 2 is the owner's 2026-08-19 ruling — *"they must be assigned to areas, because the employee
resigns and another one is hired in his place, he finds his customers automatically"* — and it is
deliberately **line-agnostic**. See [[marketing-customers-belong-to-areas-not-people]].

**So `owner_hr_id` does NOT grant sight of a row, and a NULL owner does not hide one.** A customer
with an `area_id` is already visible to every rep on that patch. Do not "fix" a stuck marketing row
by backfilling owners — that is the busywork the ruling abolished, and it changes nothing.

**The real trap: `area_id` is NULL on every seeded pharmacy.** Measured on production
`ozucdzovmcqvepbozvqf` 2026-08-21:

| cohort | pharmacies | with `area_id` |
| --- | --- | --- |
| app-captured (`evidence_status = complete`) | 20 | **20 (100%)** |
| 2026-07-02 seeded, no owner | 281 | **0 (0%)** |

The app always writes `area_id` on capture; the seed never did. With `owner_hr_id`, `manager_hr_id`
**and** `area_id` all NULL, both branches fail — those shops are invisible to **every** rep, and only
a `scope === "system"` viewer (Super Admin) can see them. That, not missing ownership, is why a
seeded link cannot be worked.

**How to apply:**

- To make a seeded pharmacy workable, backfill **`area_id` only**. Do not invent `line_id` (the rule
  is line-agnostic and one shop serves every line) and do not invent `owner_hr_id` (it is the audit
  record of who actually captured — the app stamps it at capture time).
- Derive the area from `marketing_pharmacy_distributor_codes.mapped_area_code` (master-map resolved)
  and **require it to agree with the linked customer's own `area_id`** before writing. On the 39
  owner-held links, 33 agreed and **6 contradicted** — codes are not geographic
  ([[pharmacy-code-numbers-are-not-geographic]]), so an unchecked backfill would have routed six
  shops to the wrong governorate. The 6 were left NULL with an `Area unresolved 2026-08-21:` note.
- **Applied to production 2026-08-21, the whole seeded population — every row decided, none left
  untouched.** Three tiers, each with its own note prefix so confidence stays auditable and each is
  separately reversible:

  | Note prefix | Rows | Basis |
  | --- | --- | --- |
  | `Area backfilled 2026-08-21` | **200** | code's master-map area **and** linked customer's area agree |
  | `Area inferred 2026-08-21` | **22** | one source only — 14 from the code (no linked customer), 8 from the customer (code unresolvable) |
  | `Area resolved 2026-08-21` | **58** | the two contradicted; **the code won** (see the address test below) |
  | `Retired 2026-08-21` | **1** | حضانة زمزم — unresolvable from either side, retired instead |

  Pharmacies with an area went **20 → 300 of 300 active — every live shop now has one.** **All 131
  pending links are routable (0 unrouted)** — 106 with both halves in one area, 25 split across two
  (shop in one rep's patch, doctor in another's; each sees their own half, which is correct). **75
  active reps** now have visible work.

**Retiring a pharmacy must also deactivate its `marketing_pharmacy_distributor_codes` rows** — the
same trap as [[customer-pharmacy-link-grain-is-customer-plus-code]]'s وليد كمال orphan, one table
over. A live code row on a dead shop leaves that distributor code registered to nothing. After the
2026-08-21 retirement the whole graph is clean: **0 live codes on dead pharmacies, 0 live links on
dead pharmacies, 0 live links on dead customers.** Re-run those three counts after any retirement.

**When the code and the customer disagree, the CODE wins — measured, not assumed.** Against the
`captured_address` of the 15 app-captured pharmacies that also carry a code, the code's master-map
area matched the real address **14 times out of 15** (the miss was Sohag 1 vs Sohag2, adjacent
sub-areas). The customer's `area_id` is where the **doctor** practises; the code describes the
**shop**. A doctor legitimately sends scripts across an area boundary, so a contradiction is usually
not an error at all.

**Do NOT validate a pharmacy's area against `marketing_pharmacies.area_id` on captured rows.** That
column is set from the **capturer's own `employees.area_id`**, which is a patch for a rep but a
**REGION for a manager** — so captured rows hold values like `Egypt`, `Cairo`, `Giza`, `Delta (1)`,
`Alex-BHR`. A naive comparison reports 13 of 15 "disagreements" that are really the same place at two
levels of the hierarchy. Compare against `captured_address` / `extracted_governorate_name` instead.

**FIXED on prod 2026-08-21 — 15 of the 20 captured shops were retagged from region to patch.** Only
2 had been right, both captured by a Medical Representative (a rep's `area_id` IS a patch); the other
18 came from District Sales Managers and one Product Manager. The fix is mechanical: the shop's
distributor code carries `mapped_area_code`, and **`areas.code` holds exactly that code** — so
`areas.code = mapped_area_code` resolves the patch directly. It agreed with the capture's own
Google-resolved `extracted_area_name` on 15 of 18. Note prefix `Area retagged 2026-08-21`.

**`GZ5` is Helwan-Maadi, not Giza.** The letter prefix is the REGION; the area is the whole code. I
briefly read `GZ5` as contradicting a Maadi address — it does not. Always resolve the code through
`areas.code` before calling it a conflict.

**OWNER RULE 2026-08-21 — when a shop's REGISTERED DISTRIBUTOR CODE disagrees with its own GPS /
Google-resolved area, the CODE WINS.** Asked directly and answered in three words: *"registered
distributor code"*. This extends the earlier code-beats-customer ruling to code-beats-**capture**,
which is the stronger claim — a live GPS fix loses to the distributor's registered account. Applied
to the last 2 conflicts: `الشعب` → `UE4` Assuit 2 (over Google's *Asyut 1*), `صيدلية العروبة - عابدين`
→ `UE6` Sohag2 (over Google's *Sohag 1*; POS **and** Ibn Sina both resolve UE6 there). Note prefix
`Area resolved 2026-08-21`.

**The rule only decides when the code actually resolves — and when it doesn't, the authority is
`source_of_sales_bricks`, NOT the GPS.** `مصطفى القاضى الجديده` has a POS code (`1552116`) that is
`reference_status = matched` but `master_match_kind = 'unresolved'`, `mapped_area_code` NULL.

**I got this one wrong first and had to correct it on prod the same night.** I reasoned from the
capture GPS (Kotour) plus a sibling Kotour shop whose code resolves `D14`, and wrote `D14 Gharbia 1
(Tanta)`. Wrong. **Brick `B192-11` "قطور" maps to `D15` / region `D1`** — Kotour belongs to **Gharbia
2 (Mahalla)**, per [[sos-bricks-are-the-authority-for-branch-to-area]]. The code's own registered
`raw_area` (*المحلة الكبري*) said Mahalla too; I had discounted it as drift. Corrected to `D15`
(area id 1104) with note prefix `Area CORRECTED 2026-08-21`. **Query the brick table before inferring
an area from coordinates.** A shop's town can sit in a different sales area than the nearest city
suggests, and the sibling-shop shortcut is not evidence — `الشفاء` is also in Kotour yet its code
resolves `D14`, which the owner's code-wins rule leaves standing.

**Never fabricate a master mapping to clear an `unresolved`.** The resolver is
`public.phx_resolve_marketing_pharmacy_codes(p_code_ids uuid[])` — SECURITY DEFINER, idempotent,
safe to re-run on an explicit id list (never pass NULL: that re-verdicts all ~317 codes). Re-run on
`1552116` returned `unresolved` again, correctly: it has **no row at all** in
`source_of_sales_customer_map`, which carries 28,681 PS customers — i.e. the shop has no sales
history under that code. `mapped_customer_code` stays NULL. The `NULL` vs `'unresolved'` distinction
is load-bearing: NULL = the resolver never ran; `'unresolved'` = it ran and found nothing.

Prod 2026-08-21: **0 codes never resolved, 8 `unresolved`.** All 8 shops still have a defensible
area — 7 from their linked customer, this one from the brick. A brick-vs-map contradiction sweep over
all 300 shops found only **2** rows, both the known locked Fayoum/Beni Suef case
([[fayoum-beni-suef-golden-rule-per-line]]) — left untouched.

**All 20 captured shops now sit on a patch — 0 on a region, 300/300 shops with an area, 0 on an
inactive area.** Retagging costs the capturer nothing: a DSM keeps sight through `owner_hr_id`
hierarchy, not through the area.
- **`marketing_pharmacy_distributor_codes` joins on `pharmacy_id` directly, not only through the
  link's `distributor_code_id`.** Resolving codes only via the link hid a code area on 14 pharmacies
  that have no link — they looked unresolvable and were nearly abandoned. Always join by
  `pharmacy_id` when asking "what area is this shop in".
- A wrong area is **caught at capture time**, not silently accepted: the blocking governorate check
  (#2231) compares the capture against the code's registered region. That is what makes a
  single-source `Area inferred` write acceptable — invisible-to-everyone is strictly worse.
- **Nothing was promoted, and that is correct** — `usable_links` stayed at **180**, active customers
  at **163**, evidenced pharmacies at **16**, and the 39 owner-held links stayed `pending`. Granting
  visibility is not forging evidence; both halves still need a real photograph.
- Roughly **1 in 5 seeded shops has a code that contradicts its customer's area** (6 of 39 in the
  first pass, 52 of 243 in the second). Never blanket-apply the code's area without the agreement
  test.
- Undo is exact per tier, since every target was NULL beforehand — drop only the tier you doubt:
  `update marketing_pharmacies set area_id = null, validation_notes = null where validation_notes like 'Area backfilled 2026-08-21%';`
  `update marketing_pharmacies set area_id = null, validation_notes = null where validation_notes like 'Area inferred 2026-08-21%';`
  `update marketing_pharmacies set validation_notes = null where validation_notes like 'Area unresolved 2026-08-21%';`

Both halves must still be photographed for a link to promote — see
[[marketing-link-status-is-frozen-at-write-time]] and
[[marketing-links-were-backfilled-from-a-sheet-not-the-database]].
