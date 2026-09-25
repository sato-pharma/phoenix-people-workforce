---
name: governorate-region-canonical-resolver
description: "Never index GOVERNORATE_TO_REGION directly — use resolveGovernorateRegion. Raw exact-match lookups silently rejected 'Al-Sharqia'/'Kafr El-Sheikh'/Arabic names (PR #1414, MERGED)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c032c84b-807f-41e4-a721-3834372cb0c6
  modified: 2026-07-29T07:50:25.890Z
---

**Status: PR #1414 confirmed MERGED 2026-07-28T09:45:13Z** (re-verified 2026-07-29 via `gh pr view`). The fix and data recovery below are live.

**Rule:** governorate → Phoenix region must ALWAYS go through
`resolveGovernorateRegion()` in `src/lib/sales/normalizer/geo-validate.ts`, which wraps
`resolveGovernorate()` from `src/lib/geo/egypt-locations.ts` (the codebase's canonical
Egypt geography resolver — handles Arabic, `Al-`/`El-` prefixes, hyphens, spelling drift).
Never index `GOVERNORATE_TO_REGION` or test `AMBIGUOUS_GOVERNORATES` directly. Both are
retained only for backward compatibility.

**Why:** shipped 2026-07-28 in PR #1414. Two call sites did
`String(gov).toLowerCase().trim()` then an exact dictionary lookup. Every shape the
geocoders actually return therefore failed to match — Google/LocationIQ send
`Al-Sharqia`, `Kafr El-Sheikh`, `Al-Qalyubia`, `Marsa Matrouh`, `The New Valley`, and
Arabic (`محافظة الدقهلية`), none of which equal a key:

1. `centroidPassesRegionGate` (`brick-centroids.ts`) — correct brick coordinates were
   stored as `geocode_status='region_mismatch'` and discarded. 68 of 141 rejected
   production centroids were this bug, not bad geocoding.
2. `scoreCustomerBrick` (`geo-validate.ts`) — customer→brick match confidence silently
   degraded: an Al-Sharqia pharmacy scored 35 ("governorate unknown") instead of 58, a
   Kafr El-Sheikh one 35 instead of 70. Nothing surfaced this; it just matched worse.

The outstation module had been calling `resolveGovernorate` correctly all along — the
sales geo code simply never did. When you see a governorate string compared by
lowercase equality anywhere, treat it as this bug.

**How to apply:**
- `resolveGovernorateRegion(raw)` → `{ canonical, regionCode, ambiguous }`.
  `ambiguous: true` means Sharqia (split D2/D3 — governorate alone must never resolve a
  region). `regionCode: null` on unrecognised/empty input, never a false accept.
- INPUT CONTRACT: pass a governorate-level field (Google `administrative_area_level_1`,
  LocationIQ `state`), NOT a full address. `resolveGovernorate` also matches town names,
  so a whole address could resolve via a town and mask a genuine mismatch.
- Keep the gate strict when changing it. A permissive gate is worse than the bug — a
  wrong pin beats no pin only in appearance. Genuine mismatches (Assiut vs an AB brick,
  Dakahlia vs UE, Cairo vs GZ, Suez vs GZ/OT) must stay rejected; there are tests.

**Data recovery already applied** (owner-approved, 2026-07-28): the code fix is
forward-only because `buildBrickCentroids` skips any brick that already has a
`geo_locations` row — the 68 stored rows needed a separate status flip. Done in BOTH
envs; coordinates untouched, only `geocode_status`. Backups
`public.geo_locations_brick_centroid_backup_20260728` (RLS enabled) exist in staging
(439 rows) and production (772 rows) — drop only after #1414 merges and one real
centroid build runs clean. See [[territory-management-module-plan]] for the coverage
numbers this feeds.
