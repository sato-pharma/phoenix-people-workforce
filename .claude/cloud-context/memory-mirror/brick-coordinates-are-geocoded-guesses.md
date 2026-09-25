---
name: brick-coordinates-are-geocoded-guesses
description: "Brick lat/lng are Google guesses from the brick NAME, validated only at governorate level — but coverage of the LIVE map is 92.3% (644 of 698 active bricks), not the 34.8% recorded in July. That figure and every status count divide by 1,142 geo_locations rows of which 446 are ORPHANS, so always join source_of_sales_bricks before quoting one. The shared-pin rule was deliberately relaxed 2026-08-02 and is being honoured"
metadata: 
  node_type: memory
  type: project
  originSessionId: c032c84b-807f-41e4-a721-3834372cb0c6
  modified: 2026-07-28T12:18:19.071Z
---

**There is no real coordinate data for bricks anywhere in Phoenix.** `geo_locations`
(`source_type='brick_centroid'`) is populated by `src/lib/sales/normalizer/brick-centroids.ts`,
which sends the brick's NAME as text to Google Geocoding (`"<brick_name>, <area_name>, Egypt"`)
and stores whatever pin comes back. The only validation is `centroidPassesRegionGate` — a
**governorate-level** check. It cannot tell one district of Alexandria from another.

**Discovered 2026-07-28** when the owner spotted الحضرة الجديدة plotted in the wrong place on the
new Territory Management map.

**Two distinct failure modes:**
1. **Shared fallback pins** — when Google can't find an Arabic brick name it returns the city or
   governorate CENTRE. That passes the governorate gate. Measured in production: **302 of 699
   "usable" centroids sat on just 94 shared points**; worst single pin carried **16 bricks**
   (دمياط, بور سعيد, راس البر, الزرقا…). Another had الاقصر (Luxor) + سفاجا + القصير stacked on
   Aswan — 200–400 km apart. Another had الساحل الشمالي (North Coast) on Alexandria centre.
2. **Unique but wrong pins** — الحضرة الجديدة (central Alex) resolved to **Montaza** (far east
   Alex), ~6–7 km off. Unique, in the right governorate, so nothing catches it. **This class is
   still present and NOT detectable by any current rule.**

**Fixed 2026-07-28 (owner-approved, applied to BOTH envs):**
- Any centroid whose exact lat/lng is shared by 2+ bricks demoted `success` → **`shared_fallback`**.
  Production 699 → **397 success** / 302 shared_fallback / 73 region_mismatch. Staging 392 → 280.
  Backups `geo_locations_brick_centroid_backup2_20260728` (RLS on) in both.
- `brick-centroids.ts` now refuses to write `success` for a coordinate already claimed by another
  brick (`claimedCoordinates` set, seeded from cache + extended within the run), so it cannot
  regenerate. Status precedence: region_mismatch → shared_fallback → success.

**REAL coverage is 34.8% (397 / 1,142), not the 61.3% previously believed.** Per region:
CA 48.3 · D1 38.2 · OT 36.0 · D2 35.5 · GZ 28.5 · UE 27.5 · **AB 26.0**.

## RESOLVED 2026-07-28 — what actually works (877/1,038 = 84.5%)

⛔ **OWNER RULE: never use rep GPS as ground truth — check-ins can be spoofed/fraudulent.**
Do not propose `ireports360_checkins` as a source of brick truth again.

The working recipe, in `scripts/resolve-brick-pins.mjs` (worktree `_wt-geo-gov-fix`):

1. **Constrain to the AREA's governorate, never the region's.** This is the single biggest fix.
   Region AB spans Alexandria + Beheira + Matrouh, so a region-level gate accepted
   الحضرة الجديدة as "El-Gadeeda" in Beheira (50 km off) and الحضره البحريه as Marsa Matruh
   (250 km off). Two-pass: pass 1 probes bricks unconstrained to learn each area's modal
   governorate, pass 2 resolves every brick inside it. Cross-city leakage becomes impossible.
2. **Forward Geocoding with `components=country:EG|administrative_area:<gov>`** — a hard filter,
   not a hint. This is the ONLY method that separates sub-districts:
   سيدى بشر بحرى → Sidi Beshr Bahri, سيدى بشر قبلى → Sidi Beshr Qebli (different pins,
   `administrative_area_level_3`). Places collapses both onto one point.
3. **Run Places AND forward geocoding, then SCORE and pick the best**, don't take whichever
   answers first. Score: admin_level_3/sublocality/neighborhood = 4, locality/admin_2 = 3,
   route/premise = 1, establishment/POI = 0; −1 if `partial_match`. Neither provider wins
   outright — geocoding separates bahry/qibli, Places gets العصافرة right where geocoding
   returns a hotel.
4. **Query with the BARE brick name.** The internal area label ("Alex Center", "Dakahlia 2") is
   not a real place and degrades matches. Owner suggested governorate-first ordering — TESTED on
   7 bricks, makes **zero** difference (identical coords; only a partial_match flag moved).

Result: success 397 → **877**, region_mismatch → **0**, worst coordinate pile-up 16 → **3**
(3 = legitimate sibling sub-bricks of one district, not a fallback).

⚠️ **Still not perfect and cannot be made so by name lookup:** العصافرة بحرى resolves to Azarita
(west-central) instead of the east coast under every method tried. Sub-district bricks whose name
Google doesn't model will always need a human to move the pin. Plan a review/correct-the-pin
screen; do not promise per-brick correctness from geocoding.

**Why the obvious fixes do NOT work (checked, do not redo):**
- `marketing_pharmacies` (the `field_gps` provider's source): **287 rows, 1 with GPS**. Dead —
  this is why field_gps has produced zero centroids ever.
- `ireports360_checkins`: 91,906 rows, 100% real GPS, 92 reps — but has **no brick column**.
  Linkage runs contact → `ireports360_visits.crm_region_id` → brick via
  `ireports360_crm_region_brick_resolutions`, which is **EMPTY in both envs**.
- CRM region names are ENGLISH transliterations ("Mahalla", "Tanta", "Shebeen El Kom"); brick
  names are Arabic. **0 of 293 CRM regions match a brick name exactly.** A manual/assisted
  mapping is unavoidable — and another session already owns it (branch
  `codex/crm-region-template-current-bricks`, PR #1410 merged: region-mapping template must
  offer CURRENT bricks). **Do not duplicate that work.**

**So brick-level GPS truth is BLOCKED on that CRM region → brick mapping being populated.** Once
it is, the rebuild is: median lat/lon of check-ins per brick, written as provider `field_gps`,
which should outrank every geocode.

**Rule going forward:** never let an unverified pin drive an allocation finding. The Territory
Management "closer to another area" output was showing false positives caused purely by geocoder
error — see [[territory-management-module-plan]]. Related:
[[governorate-region-canonical-resolver]] (the governorate gate itself),
[[sos-brick-authoritative-geography]], [[locationiq-geocode-provider]].

## 2026-09-04 — investigated: no defect, and the denominator was the whole problem

**Coverage of the live territory map is 92.3%, not 34.8%.** Measured over the 698 ACTIVE bricks,
which is what the map renders:

| | active bricks |
| --- | --- |
| `success` | **644 (92.3%)** |
| `shared_fallback` | 50 |
| `region_mismatch` | **0** |
| no centroid at all | **4** |

**Three different denominators give three different answers, and two of them are wrong.**

| denominator | figure | what it measures |
| --- | --- | --- |
| 397 / 1,142 rows | 34.8% | recorded July 2026 — **rows, including dead ones** |
| 949 / 1,142 rows | 83.1% | same table after the 2026-08-02 re-geocode — **still rows** |
| **644 / 698 active bricks** | **92.3%** | **the live map** |

**🔴 446 of the 1,142 `brick_centroid` rows are ORPHANS** — `source_key` values with no matching
row in `source_of_sales_bricks`. That is **39% of the table**. They are counted by every status
tally that reads `geo_locations` alone, and they are the sole reason a shared-pin sweep looked
alarming: 43 shared pins / 93 rows unjoined, **13 pins / 32 rows** joined to live bricks. All 13
region_mismatch rows are orphans too. **Join `source_of_sales_bricks` before quoting any centroid
count.**

## The guard: not leaking, but the two writers disagree

`buildBrickCentroids` (`src/lib/sales/normalizer/brick-centroids.ts`) seeds `claimedCoordinates`
from `loadBrickCentroids()`, which loads **every** centroid row regardless of status — so the guard
is fully seeded. It then only processes `pending` = bricks with **no cached centroid at all**
(**4** today). **It never revisits an existing row**, which is why a re-run cannot demote or repair
anything already written.

**The module and the repair script apply DIFFERENT rules, and the module's is stricter:**

| | rule for a shared coordinate |
| --- | --- |
| `brick-centroids.ts` (module) | **any** coordinate already claimed → `shared_fallback` |
| `scripts/resolve-brick-pins.mjs` | only if it spans **different areas** or carries **> 4 bricks** |

The script's narrower rule is the deliberate and better one — sibling bricks subdividing one
district legitimately share a pin. The disagreement is **latent, not active**: with 4 bricks
pending, a hand-run would judge only those, by the stricter rule. But it means new bricks are held
to a standard the existing 694 are not. Align the module to the script's test if either is touched.

**Two more things the read turned up, neither currently biting:**
- **Pass 1 (field-GPS enrichment) writes `geocode_status: "success"` unconditionally**, never
  consults `claimedCoordinates` and never adds to it — so a Pass-2 geocode landing on a field-GPS
  point would not be detected as shared either. Inert today: provider `field_gps` has **0 rows** in
  production (`checkin_gps` has 22, `manual` 2).
- **The builder is Super Admin, manual, POST-only** (`/api/sales/normalizer/brick-centroids`) and
  on **no cron**. Nothing re-geocodes on a schedule, so the data only moves when someone runs it.

**`success` means "not a detected fallback", never "verified correct".** Validation is
governorate-level only, so the *unique but wrong* class (الحضرة الجديدة → Montaza, ~6 km) is still
undetectable by any rule in the system, and 0 region_mismatch among live bricks does not mean 0
wrong pins.

## What I got wrong first, and why it is the lesson

An earlier pass this same session wrote this section up as **🔴 the guard is leaking**, citing 93
rows on 43 shared pins and "سنورس (Fayoum) stacked onto Damietta, 350 km apart". All of it was
wrong:

- the count never joined the brick table, so 39% orphans were counted as live pins;
- the rule had been **deliberately relaxed**, with the reasoning written in the code, which I had
  not read before calling it broken;
- **سنورس there is `B207-17`, area D26 — Damietta.** I recognised a Fayoum town name and trusted my
  own map of Egypt over the brick table, which is the exact error in
  [[address-matching-beats-paid-ai-and-geocoding-hurts]].

**A defect is a claim, and needs the same proof as a figure.** See
[[staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones]].

## 🔴 The orphans DO break one thing: Geo readiness reads 949 / 698, and the button is dead

`getBrickCentroidCoverage()` builds its numerator and denominator from **two different
populations**:

- `success` / `cached` / `mismatch` count **every `geo_locations` row** — all 1,142, orphans
  included.
- `totalBricks` is `loadSalesReferenceData().bricks` — **live bricks only**, ~698.

`normalizer-workspace.tsx:583` renders that pair directly, so the Super Admin's Source-of-Sales
normalizer shows:

> **Geo readiness: 949 / 698 bricks located (13 flagged)**

More bricks located than exist, and all 13 "flagged" are orphans whose brick is gone.

**The functional half is worse than the cosmetic one.** Line 584 gates the action on
`success < totalBricks` — `949 < 698` is **false**, so the **"Build geo index" button never
renders**. It is permanently replaced by the green *"distance-level confidence active"* label. That
button is the **only** UI path to `buildBrickCentroids()`, which is itself the only scheduled-by-
nobody way to geocode the **4 active bricks that still have no centroid at all**. The counter being
wrong is what hides the work the counter exists to prompt.

**The fix is small and local:** `getBrickCentroidCoverage` already awaits `loadSalesReferenceData()`,
so it holds the live brick ids. Filter `cachedRows` to rows whose `source_key` is in that set
before counting. Correct output today: **success 644, cached 694, mismatch 0, totalBricks 698** —
which renders "644 / 698 bricks located" and brings the button back for the 4 that are missing.

**FIXED 2026-09-04 — PR #3093**, branch `codex/brick-geo-readiness-count` (worktree; the primary
tree had another session active). `getBrickCentroidCoverage` now filters to rows whose
`source_key` matches a live brick — the same key the builder writes at `brick-centroids.ts:348`,
`source_key: brick.brickId`. The counting moved into a pure exported
`summarizeBrickCentroidCoverage(brickIds, rows)` so the invariant is testable with no database, and
`tests/brick-centroid-coverage.test.ts` is registered in `tests/run-tests.ts`. Proved RED by
reverting the filter — the headline assertion fires with *"coverage reported 11 located of 10
bricks"*. Read path only: no write, no migration, and the 446 orphan rows are left in place, since
they are harmless once they are not counted.
