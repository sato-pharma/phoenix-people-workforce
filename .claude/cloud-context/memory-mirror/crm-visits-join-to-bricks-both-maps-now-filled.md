---
name: crm-visits-join-to-bricks-both-maps-now-filled
description: "Both CRM→brick maps are filled and live: the doctor map (ireports360_crm_customer_brick_resolutions, Customer Mapping tab) and the region map (ireports360_crm_region_brick_resolutions, Region Mapping tab) — join crm_contact_id and ALWAYS filter status='mapped'. Two owner locks: write HIGH confidence only, never Medium (settled, do not re-propose); and Qena is mapped by each REP'S AREA. Any auto-match must run a GPS geographic referee before writing (calibration passing is not every row passing) and strip governorate/road/'Bahri' tokens before matching a town. On a doctor/region disagreement prefer the doctor map."
metadata:
  node_type: memory
  type: project
  originSessionId: 4270e050-2e27-40cc-b434-84336bd82518
  modified: 2026-09-26T01:49:57.309Z
---

## Both maps are live — how to read them

Two maps place a CRM visit onto a brick, built from completely different evidence:

| Table | Admin tab |
| --- | --- |
| `ireports360_crm_customer_brick_resolutions` | Customer Mapping (per doctor) |
| `ireports360_crm_region_brick_resolutions` | Region Mapping (per CRM region) |

Both were filled from zero and together reach roughly two-thirds of real customer visits
(`visit_type = 0`). **Join `crm_contact_id`, and ALWAYS filter `status = 'mapped'`** — a `pending` row
with a null brick is an explicit non-decision, not an unmapped doctor. Every machine-written row carries
`resolved_by_hr_id = 'AUTO-…'` (a column written but never read by the app) so machine-derived rows stay
distinguishable from a human admin decision **forever**.

- **The two maps independently agree ~88.6%.** Where a visit is placed by BOTH, they name the same brick
  the large majority of the time — two maps from different evidence. 🔴 **When they DISAGREE, prefer the
  CUSTOMER (doctor) map** — a CRM region is a coarse locality, so a doctor near its edge legitimately sits
  in a neighbouring brick, and the doctor-level answer is the finer one.
- **The region route is ~48x cheaper per answer** (303 dropdown answers vs 14,716 contacts), so for the
  remaining unmapped contacts it is still the cheap route — the owner's XLSX-with-dropdowns rule.
- **Count pharmacies APART from doctors** — an early report said "377 doctors" when 1 in 3 were pharmacies.

## 🔒 OWNER LOCK — write HIGH confidence only, never Medium

Owner, 2026-08-28: *"The one you are confident with it, write it. The one that you are medium confident,
don't write it. And later on we will add the location. We will add every contact's location."* He raised
the fear himself — *"I am afraid the medium be away from the doctor, and I mislead the field force"* — and
the measurement backed him. **Do not re-propose the Medium tier, including its GPS-confirmed subset** (he
was shown that subset — same measured safety as High — and still said no). **The gap is closed by real
per-contact locations later, not by inference; do not offer to extend the GPS inference.**

## 🔒 OWNER RULED QENA — by each REP'S AREA. Settled; never re-raise.

Qena city has TWO bricks and the addresses only say "Qena", so the owner chose the rep: **Qena 1 reps
(Gehad Khalifa, Hayam ElAadel) → Qena 1's مدينة قنا; the Qena 2 rep (Ghada Mohamed) → Qena 2's مدينة قنا -
قنا 2.** The Qena LOCALITY row stays unmapped on purpose — it is ambiguous, solved per doctor. **Two
durable consequences:** a Qena contact added later arrives unmapped — **apply the same rule (the rep's
area) without asking again** — and a brick written this way does NOT follow a reassignment between a Qena 1
and a Qena 2 rep.

## The GPS geographic referee — run it before writing any batch

🔴 **A tier passing calibration is not the same as every row in it passing.** The matcher's headline
accuracy was scored against **the visiting rep's area**, which is **circular for Medium** — Medium is
exactly the tier where the rep's area broke the tie, so that test grades the answer against its own input.
The honest referee saw **neither the address nor the rep**: raw GPS — take each brick's centre from its
HIGH-confidence doctors' check-ins only, then ask how far a row sits from its assigned brick and whether
another brick is nearer (High measured leave-one-out as the control, since adjacent bricks make "a
neighbour is nearer" happen to correct answers too).

- **Why Medium is unshippable:** ~41% of Medium's bricks have **fewer than 3 High anchors, so no referee
  can check them at all** — precisely where the matcher had least to go on; and among the checkable, a
  *different brick nearer by >20 km* (a real mislead) was **High 0.5% vs Medium 6.6% — 13x.**
- **The referee also caught 17 already-written HIGH rows** placed 24–42 km from their own check-ins with
  another brick 0–1 km away; they were pulled back to `status='pending'`, `brick_id=null`. **So run the
  geographic referee over any future batch before writing it — not just the accuracy test.**

## Reusable matching rules

- 🔴 **Any auto-match must strip GOVERNORATE, road and "Bahri" tokens before matching a town name.** The
  08-28 doctor matcher read governorate/road/"Bahri" words as towns — "Menofia"→منوف, "Kafr El-Sheikh
  Governorate"→كفر الشيخ, "Alexandria - Marsa Matrouh Rd"→مرسى مطروح, "Al Agamy Al Bahri"→بحرى — so
  Ashmoon/El Bagour doctors sat under Menouf, etc. 251 were reversed on 09-16.
- **The safe governorate-town pullback rule:** revert only where the brick is in the governorate-town set,
  the locality is mapped elsewhere, NO address names the brick's town AS a town, AND a strict majority of
  addresses name the locality's town. The looser rule would have misplaced Banha/Maghagha/Shobra doctors.
- **A locality can hold a neighbouring governorate's town — check typed addresses against the rep's area**
  (15 El Maragha doctors filed under the Maghagha locality needed their own brick).
- **The region map's own method:** `region-brick-suggest.ts` scores two signals (transliterated NAME + the
  organogram AREA of the visiting reps) and calls a region `confirmed` only when both agree — but a third
  GPS referee **overruled 5 of 143 "confirmed"** (worst: Domiat, suggested brick 25 km away while another
  sat 1 km off), so **two-signal `confirmed` was ~4.5% wrong among the checkable ones.** Only rows where all
  three signals agree were written; the engine-confirmed-but-GPS-uncheckable rows were deliberately NOT
  written, since the checkable ones already failed at 4.5%.

## Traps

- **`sales_ops_rollup_by_brick` is EMPTY — do not reach for it.** The sales half is healthy:
  `source_of_sales_fact_rollup` carries `brick_id` on ~99.4% of rows; `direct_value` is direct-orders only,
  **NOT a general value column**; the line join is by label (`cns`→`CNS`, `anti_infective`→`Anti Infective`,
  `pedia`→`Pedia`).
- **`visit_type = -8` is an office day and carries no geography by design;** ~99.9% of `visit_type = 0`
  visits carry a `crm_region_id`.
- 🔴 **There is NO stored per-doctor coordinate anywhere** — `ireports360_checkins.lat/lon` is per
  check-in and `geo_bricks` is empty — so **never render a map pin from a raw check-in**; it shows only
  where a rep stood on one day.

See [[gps-checkins-are-a-partial-feed-never-score-a-rep-on-them]],
[[sos-bricks-are-the-authority-for-branch-to-area]], and
[[the-sales-geography-has-no-governorate-layer]] — there is no governorate column to join, at all.
