---
name: brick-pin-restore-2026-10-27
description: 6 of the 2 Aug check-in GPS brick pins put back to their earlier geocodes on production 2026-10-27 (owner-approved) — the rollback values of THIS change are inline
metadata:
  type: project
---

2026-10-27 ~20:10 Cairo, owner-approved by multiple choice ("Restore all 6"): six brick pins that the
2 Aug check-in GPS correction ([[brick-pin-corrections-2026-08-02]]) moved FARTHER from their area's
centre were put back to their prior lat/lon/provider in production `geo_locations`
(`source_type='brick_centroid'`). The 2 Aug memory note holds the values restored. Distance from area centre,
before → after 2 Aug: احمد عرابى 1.4→13.7 km, سخا 6.1→16.6, اسحاقة 2.0→12.5, سنهور 9.2→18.3,
ابو رواش 14.4→20.8, الشعراء 2.0→6.7. The other 16 corrections were left alone.

**Why:** owner rule — rep GPS is never ground truth (check-ins can be spoofed); these six were measurably worse.
**How to apply:** to undo THIS change, set these values back (all were `checkin_gps`, status `success`):

| id | brick | lat | lon |
|---|---|---|---|
| 3872 | B125-M1 سنهور | 29.40802 | 30.86563 |
| 4108 | B189-3 احمد عرابى | 30.07486 | 31.33561 |
| 4257 | B199-5 سخا | 31.04957 | 30.83895 |
| 4352 | B206-2 ابو رواش | 30.00256 | 31.17087 |
| 4357 | B207-12 الشعراء | 31.40428 | 31.73683 |
| 1674 | B90-90 اسحاقة | 31.24187 | 30.94715 |
