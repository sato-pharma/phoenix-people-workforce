---
name: crm-visits-join-to-bricks-both-maps-now-filled
description: "CRM→brick maps (doctor + locality): the 08-28 GPS matcher read governorate/road names as towns (251 pulled back 09-16); localities translated and mapped 09-16; owner ruled Qena BY REP AREA 09-16 (unmapped on lists 3,998→180 = 108 contacts + 72 pharmacies; owner list xlsx/unmapped-contacts-and-pharmacies-2026-09-16-after-qena.xlsx); HIGH confidence only, Medium owner-banned"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4270e050-2e27-40cc-b434-84336bd82518
  modified: 2026-09-16T13:52:08.380Z
---

**UPDATED 2026-09-16 — the 08-28 doctor matcher read GOVERNORATE, road and "Bahri" words as TOWNS.**
"Menofia"→منوف, "Qalyubia"→قليوب, "Kafr El-Sheikh Governorate"→كفر الشيخ, "Damietta Governorate"→دمياط,
"Sohag Governorate"→مدينة سوهاج, "Alexandria - Marsa Matrouh Rd"→مرسى مطروح, "Al Agamy Al Bahri"→بحرى,
"Port Said street"→بور سعيد. So Ashmoon/El Bagour doctors sat under Menouf, Tookh under Qalyub, etc.
**251 pulled back** 2026-09-16 16:00 Cairo (marker `AUTO-GPS-2026-08-28-REVERTED-2026-09-16`, pre-image
`crm_backup_20260916.customer_brick_resolutions_pre`, evidence `…customer_brick_pullback_list`). Rule
that made it safe: brick in that governorate-town set, locality mapped elsewhere, NO address names the
brick's town AS a town, AND a strict majority of addresses name the locality's town — the looser rule
would have misplaced Banha/Maghagha/Shobra/Mostorod doctors. **Any future auto-match must strip
governorate/road/"Bahri" tokens before matching a town name.** Same day: CRM localities mapped
(`AUTO-TRANSLATE-2026-09-16`, 163 rows) took unmapped list doctors 3,998 → 377; 15 El Maragha doctors
filed under the Maghagha locality got their own brick (`AUTO-ADDRESS-2026-09-16`) — a locality can
hold a neighbouring governorate's town, so check typed addresses against the rep's area.
16:17 same marker: 18 more contacts (Naser 11, Meet Okba 6, El sabteya 1) where the typed address
named one brick in the rep's area AND every check-in agreed. What is left is 22 localities, each held
for a stated reason (Qena = two city bricks, RULED below; Heliopolis = area of 27 bricks; the rest
name no brick, span several, or conflict with check-ins/rep area). Count pharmacies APART — the first
report said "377 doctors" when 1 in 3 were pharmacies.

🔒 **16:46 OWNER RULED QENA — by each REP'S AREA. Settled; never re-raise.** Qena city has two
bricks and the addresses only say "Qena", so he chose the rep: Qena 1 reps (Gehad Khalifa, Hayam
ElAadel) → Qena 1's مدينة قنا; the Qena 2 rep (Ghada Mohamed) → Qena 2's مدينة قنا - قنا 2. 179
doctor-level INSERTS (152 + 27, none had a row), marker `OWNER-RULE-QENA-2026-09-16`; undo = delete by
that marker. Ghada's other 26 already sat on Qena 2's brick from the GPS map, so the rule agreed with
it. The Qena LOCALITY row stays unmapped on purpose — it is ambiguous, so it is solved per doctor.
**Two consequences:** a Qena contact added later arrives unmapped (apply the same rule — the rep's
area — without asking again), and a brick written this way does NOT follow a reassignment between a
Qena 1 and a Qena 2 rep. After: 180 unmapped on lists = 108 contacts (87 PM, 21 AM) + 72 pharmacies in
21 localities, re-read live 16:51 as the identical set to the sheet.

**UPDATED 2026-08-28 — the headline of this memory has flipped. Read the new state first.**

| Table | Admin tab | Rows mapped | Universe |
| --- | --- | --- | --- |
| `ireports360_crm_customer_brick_resolutions` | Customer Mapping | **3,617** (was 0) | 14,716 CRM contacts |
| `ireports360_crm_region_brick_resolutions` | Region Mapping | **105** (was 0) | 303 CRM regions |

**Visit coverage after both writes: 58,018 of 89,010 real customer visits (`visit_type = 0`) =
65.2%** — 47,265 via the region map, 31,547 via the doctor map, overlapping.

So a rep's visits **can** now reach bricks for those 3,617 doctors — 20.6% of the 17,498 doctors on
plans, 31.6% of plan entries. Join `crm_contact_id`, and **always filter `status = 'mapped'`**: a
`pending` row with a null brick is an explicit non-decision, not an unmapped doctor.
Every written row carries `resolved_by_hr_id = 'AUTO-GPS-2026-08-28'` (that column is written but
never read by the app) so machine-derived rows stay distinguishable from a human admin decision
forever. Pre-state backed up in `zz_backup_crm_customer_brick_resolutions_20260828`.

🔒 **OWNER RULE 2026-08-28 — write HIGH confidence only, never Medium.** His words: *"The one you
are confident with it, write it. The one that you are medium confident, don't write it. And later
on we will add the location. We will add every contact's location."* He raised the fear himself —
*"I am afraid the medium be away from the doctor, and I mislead the field force"* — and the
measurement backed him. **Do not re-propose the Medium tier**, including the GPS-confirmed subset
of it: he was shown that subset (265 of 691, same measured safety as High) and still said no. The
gap gets closed by real per-contact locations later, not by inference.

**Why the fear was right — and why the ORIGINAL calibration could not have found it.** The
matcher's 98.1% region accuracy was scored against *the visiting rep's area*, which is **circular
for Medium**: Medium is exactly the tier where the rep's area broke the tie, so that test grades the
answer against its own input. The honest referee is one that saw **neither the address nor the rep**
— raw GPS: take each brick's centre from its HIGH-confidence doctors only, then ask how far a row
sits from its assigned brick and whether another brick is nearer. High is measured leave-one-out as
the control, because bricks are small and adjacent so "a neighbour is nearer" happens to correct
answers too (19.3% of High).

| Referee verdict | High | Medium |
| --- | --- | --- |
| median distance to its own brick | 0.7 km | 1.2 km |
| 90th percentile | 8.1 km | **18.1 km** |
| another brick nearer by **>20 km** (would mislead) | **0.5%** | **6.6%** — 13x |
| beyond 50 km | 0 | 3 |
| **no referee available at all** (brick has <3 High anchors) | 113 of 3,634 | **284 of 691 = 41%** |

That 41% is the real reason Medium is unshippable: the thinly-anchored bricks are exactly where the
matcher had least to go on, and they cannot be checked by any means available.

**The referee also caught 17 rows of already-written HIGH** — doctors placed 24-42 km from where
their own check-ins sit, with another brick at 0-1 km. Pulled back to `status='pending'`,
`brick_id=null`, marked `AUTO-GPS-2026-08-28-REVERTED` (3,634 → 3,617). **A tier passing calibration
is not the same as every row in it passing** — run the geographic referee over any future batch
before writing it, not just the accuracy test.

**THE REGION MAP, filled 2026-08-28 — and the method that made it safe.** `region-brick-suggest.ts`
already scores two signals (transliterated NAME + the organogram AREA of the visiting reps) and only
calls it `confirmed` when both agree: 143 of 303. A **third** referee the engine cannot see was
added — GPS: each brick has a real centre now (median of its written doctors' check-ins), and a CRM
region has one too (median of its own contacts' check-ins). **That third signal OVERRULED 5 of the
143 "confirmed"**, the worst being `Domiat` — 834 visits, suggested brick 25 km away while another
sat 1 km off. So **`confirmed` from two signals was ~4.5% wrong among the checkable ones.** Written:
the **105** where all three agree (median 0.1 km from the brick centre, worst 5.2 km), marked
`resolved_by_hr_id = 'AUTO-GEO-2026-08-28'`, backup in
`zz_backup_crm_region_brick_resolutions_20260828`. NOT written: the 5 GPS overruled, and **33 that
the engine confirmed but no GPS could check** — deliberately, since the checkable ones failed at
4.5%.

**The two maps independently agree 88.6% of the time.** Where a visit is placed by BOTH, they name
the same brick on 18,422 of 20,794 — two maps built from completely different evidence. **When they
disagree (2,372 visits), prefer the CUSTOMER mapping**: a CRM region is a coarse locality, so a
doctor near its edge legitimately sits in a neighbouring brick, and the doctor-level answer is the
finer one.

**Still true:** the region route remains ~48x cheaper per answer (303 dropdown answers vs 14,716),
and 99.9% of `visit_type = 0` visits carry a `crm_region_id`. `visit_type = -8` is an office day and
carries no geography by design.
`sales_ops_rollup_by_brick` is **empty** — do not reach for it. The sales half is healthy:
`source_of_sales_fact_rollup`, 99.4% carrying `brick_id`; `direct_value` is direct-orders only and
is NOT a general value column; the line join is by label (`cns`→`CNS`, `anti_infective`→`Anti
Infective`, `pedia`→`Pedia`).

**How to apply:** for the remaining ~11,000 unmapped contacts, the region route is still the cheap
one (owner XLSX-with-dropdowns rule). Do not offer to extend the GPS inference — the owner has
closed that door and is planning real per-contact locations instead. There is **no stored
per-doctor coordinate** anywhere: `ireports360_checkins.lat/lon` is per check-in and `geo_bricks` is
empty, so never render a map pin from a raw check-in — that shows where a rep stood on one day.
See [[gps-checkins-are-a-partial-feed-never-score-a-rep-on-them]],
[[sos-bricks-are-the-authority-for-branch-to-area]], and
[[the-sales-geography-has-no-governorate-layer]] — there is no governorate column to join, at all.
