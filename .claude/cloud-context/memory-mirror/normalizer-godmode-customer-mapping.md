---
name: normalizer-godmode-customer-mapping
description: "God-mode customer mapping build (geo cache, distance confidence, propagation, auto-apply, clusters) — shipped 2026-07-02, prod-live."
metadata: 
  node_type: memory
  type: project
  originSessionId: 8d4ec560-91a9-4b4d-b0cc-588bcdee97b1
  modified: 2026-07-24T10:07:19.164Z
---

Shipped 2026-07-02 across two PRs: **#728** (foundation, no migration) + **#732** (auto-apply + migration). Both merged to main, live in prod. (#730 was the stacked PR 2, closed/superseded — a squash-merged PR 1 left a phantom Phase 1-3 duplicate commit, so PR 2 was rebuilt via cherry-pick onto fresh main as `feat/customer-mapping-autoapply` → #732.)

**What it does** (all in `src/lib/sales/normalizer/`):
- `customer-normalize.ts` — customer-only name key (taa marbuta ة→ه, hamza ؤ/ئ, strips صيدلية/د/dr prefixes). NEVER fold this into `normalizeAliasKey` (that is the stored-alias persistence key).
- `pharmacy-chains.ts` — chain dict (elezaby/19011/seif/misr/roshdy/care), branch-aware; chain names never fuzzy-match non-chain.
- `pharmacy-geocode.ts` — cache-first geocoding in `geo_locations` (source_type=`pharmacy_address`), each pharmacy geocoded ONCE, 150 live-call cap.
- `brick-centroids.ts` — one-time brick centroids in `geo_locations` (source_type=`brick_centroid`, key=brick_id) with region SANITY GATE (mismatch stored as geocode_status='region_mismatch', excluded from distance tiers); free field-GPS enrichment from marketing_pharmacies captures.
- `geo-validate.ts` — pure distance-tier scorer: <5km=95, <15km=85, markaz=80, gov→region=70, Sharkia D2/D3=58, mismatch=12/10, unknown gov=35. Exports GeoSignals.
- `customer-propagate.ts` — deterministic cross-distributor twin matching BEFORE AI (exact name=90, +address overlap=93, chain-branch aware, ambiguity suppressed).
- `customer-suggest.ts` — shared pipeline (propagate→AI→geo) used by BOTH ai-suggest route and auto-map route.
- `auto-apply.ts` — multi-signal gate. Env `SOS_AUTO_ACCEPT_MIN` (floor 90/default 95). Button-triggered ("Auto-map high-confidence"), NEVER silent. Single-signal 95 never auto-applies.
- `customer-clusters.ts` — group unknowns by geocode gov/markaz (territory-text fallback), one-brick-per-group UI.

**CRITICAL one-time op:** brick centroids are EMPTY until an admin clicks **"Build geo index"** in `/sales/normalizer` (POST `/api/sales/normalizer/brick-centroids`, 600 geocodes/run, re-invoke to finish). Until built, confidence falls back to markaz/governorate tiers (still real, not distance-level 95/85). This is required to unlock full distance confidence.

**Migration `20260703090000`** (applied+verified staging izhmxvgiktiafqusolot AND prod ozucdzovmcqvepbozvqf): adds `source_of_sales_customer_map.confidence` + `.mapped_by` (both nullable) and `sos_backfill_import_rows_from_customer_map(distributor,customer)` RPC — set-based, fills brick/area/region on import rows WHERE brick_id IS NULL only (never overwrites), service_role-only. Backfill ("heal history") is opt-in on save/add/import; bulk import >2000 mappings skips it. Code tolerates pre-migration state (retries without cols; RPC failure non-fatal).

**Follow-up fix (PR #754, 2026-07-03):** `ai-suggest` route delegates customer kind to the same heavy `suggestCustomerBricks` pipeline as `auto-map` but shipped with NO `maxDuration`, so first-run (cache empty) timed out → Vercel non-JSON error page → client bare `res.json()` threw "Unexpected token 'A' … is not valid JSON". Fix = `maxDuration=300` on ai-suggest (match auto-map) + guard the one unguarded `res.json()` in normalizer-workspace.tsx. Lesson: ANY route calling the customer pipeline needs `maxDuration=300`; every client fetch here uses `.catch(()=>null)` except that one did not.

Builds on [[la003-la004-confidential-products]] geography rules and [[sos-brick-authoritative-geography]]. Prior confidence work: geo-validate governorate-only version (PR #649) was superseded by this distance-tier rewrite.

**2026-07-24 retrain after [[reallocation-668-bricks-full-plan-live]]:** confirmed the core name/brick matcher needs NO retraining ever — `loadCrosswalks()`/`loadSalesReferenceData()` reads `source_of_sales_bricks/blocks/areas/regions` live, filtered `active=true`, no cache, so a reallocation is "trained" the instant it's committed. The ONLY real stale artifact is the brick-centroid cache (`geo_locations`, source_type=`brick_centroid`) — new/reassigned brick_ids start with zero coverage. Checked the actual 668-row reallocation for the one real risk case (same brick_id kept but block/area reassigned, which WOULD leave a silently-wrong cached centroid since the endpoint only fills gaps, never refreshes existing rows) — verified zero such rows in the plan; every brick with a changed block/area also got a brand-new brick_id, so there's no silent-staleness case this time, only gaps.

Ran `POST /api/sales/normalizer/brick-centroids` (Super Admin) via a local dev server against prod (dev-auth cookie, standard pattern per [[local-browser-verify-gotchas]]). **Gotcha: `curl -X POST` gets `{"error":"csrf_blocked"}` without an explicit `-H "Origin: http://localhost:3000"` header** — proxy.ts's same-origin CSRF check (see [[nextjs16-proxy-csrf]]) fails closed when Origin/Referer are both absent, which curl does by default. Result: coverage went from 439 cached/354 success (of 668 active bricks) to 772 cached/631 success; 277 newly geocoded, 56 region-mismatched (normal ~17% rate, consistent with the pre-existing ~19%), 0 remaining. The 439→772 jump (+333) is bigger than the 229 raw "uncached active bricks" gap because `getBrickCentroidCoverage()`'s `cached` count includes orphaned rows for now-retired brick_ids (104 of them — matches the 90+14 deactivated-bricks count from the two live batches exactly) that `buildBrickCentroids()` correctly ignores since it only iterates currently-active bricks.
