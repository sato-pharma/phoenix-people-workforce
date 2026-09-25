---
name: organogram-phantom-seat-fix-2166-live-on-prod-2026-08-16
description: "PR #2166 (organogram phantom-seat Fix 1 + vanish-guard Fix 2) is LIVE on prod as of 2026-08-16; do not undo."
metadata: 
  node_type: memory
  type: project
  originSessionId: 0aa539e7-1a4c-4b0e-bc7d-ae3b0a6dbee4
  modified: 2026-08-15T23:27:05.060Z
---

**PR #2166 `da99a17d` LIVE on prod 2026-08-16, do NOT undo.** Merged and shipped; the
currently-serving revision `b833efe1` (PR #2165, another organogram fix that stacked on
top) contains `da99a17d` byte-identical on both touched files.

Two changes in `src/lib/reports/`:
- **Fix 1** (`organogram-safety.ts`): `suppressFilledVacancyRows` now also matches occupancy
  on a **manager-agnostic** identity `level|line|area` — but ONLY for MANAGER-level seats
  (DSM/RSM/NSM) via `occupiedManagerSeatIdentityKeys` + the `isManagerLevelSeat && identityKey`
  gate. Rep seats stay manager-aware on purpose (a broad rep area repeats under different DSMs;
  the first version over-suppressed and reded the `["Pedia","Pedia"]` hardening test). Also a
  manager-less placeholder for an area that has a real-manager record is dropped (Heliopolis dup).
- **Fix 2** (`organogram-view-model.ts`): a member reporting straight to the line leader (NSM)
  with no vacant-seat marker no longer vanishes — routed to the Unassigned Manager lane.

IMPORTANT scope: Fix 1 only affects the **Vacancies report + CEO-landing open-seat count**,
NOT the org-chart page — see [[organogram-has-two-data-paths-suppress-only-hits-vacancies]].
Regression file `tests/organogram-phantom-seat-suppression.test.ts` (registered in
`tests/run-tests.ts`), break-the-fix confirmed, check:harden green (783 tests, build 73s).
