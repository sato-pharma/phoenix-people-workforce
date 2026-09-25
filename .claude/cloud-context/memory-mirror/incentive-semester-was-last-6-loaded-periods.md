---
name: incentive-semester-was-last-6-loaded-periods
description: "The incentive payout window was `allTimeTrend.slice(-6)` — the last six months of data that happened to exist — so 27 of 83 reps were scored over a shorter semester than their colleagues"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4a13ab2c-b77b-4e77-a1ed-2dd1db5c413b
  modified: 2026-08-04T02:00:34.381Z
---

Found and fixed 2026-08-04 (PR #1689). The 2026 payout CURVE was never wrong; the number fed into
it was.

`src/lib/employee-portal/service.ts` computed the semester as `allTimeTrend.slice(-6)`, then
`semesterSales/semesterTarget` → `overviewAchievementPercent` (misleadingly named — it IS the
semester figure, not an all-time one) → `calculateIncentive2026` → the EGP a rep reads.

**Measured in production, `v_employee_portal_sales`, H1 2026:** 56 reps had all 6 months, **26 had
5 (missing June), 1 had 4 (missing January and June)**. June was half-loaded — 55 reps against 82
in every other month, and 2 batches where other months had 3. So a third of the field force was
being scored over a different-length semester than their colleagues, on the same screen, with no
indicator.

🔴 **The latent one was worse:** the moment a July sheet is approved, `slice(-6)` becomes
February–July — three H1 months plus one H2 month summed into one achievement — and nothing in the
code would notice.

**Fix:** `src/lib/incentives/semester.ts` declares H1 = months 1-6 and H2 = 7-12 as fixed period
sets, anchors on the rep's LATEST period (not the calendar — on 2026-08-04 the calendar said H2
while the data ended in June, and anchoring on the calendar would have hidden the H1 result reps
are actually paid on), and separates three facts that must not be conflated:
`present` / `missing` (elapsed, no data — a real gap) / `remaining` (not happened yet).

An incomplete window renders a named, plain-language notice above the payout rather than hiding the
figure — hiding leaves a rep with no information; naming the month fixes the real harm, which is a
partial figure being read as settled.

Related: [[no-data-must-never-render-as-absence-or-zero]] (same principle, different module).
`src/lib/incentives/scheme-2026.ts` stays owner-locked and was never opened.
