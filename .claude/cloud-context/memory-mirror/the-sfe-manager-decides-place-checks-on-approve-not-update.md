---
name: the-sfe-manager-decides-place-checks-on-approve-not-update
description: "SUPERSEDED 2026-11-19 — the SFE Manager (Khaled Bedair) now only RECOMMENDS on Place checks and decides nothing; the Super Admin alone decides, and his recommendations wait on /admin/field-crm/sfe-recommendations. History: from 2026-10-19 he approved, refused and restored exactly as the Super Admin; gated on phoenix_crm approve because he holds no update — never hand him update."
metadata:
  node_type: memory
  type: project
  originSessionId: 7c4e4a75-daf8-493b-a046-5ba699077a25
  modified: 2026-10-19T08:48:41.399Z
---

🔴 **SUPERSEDED 2026-11-19 (owner, ~08:10 Cairo):** *"in place checks make Khaled Bedair only able to recommend validation or not recommend, never able to take a decision, and the recommended by him goes separately in a separate page for admin decision."* `readsCompanyPlaceChecks` opens the board to him; `canDecideValidationReviews` is the Super Admin alone; his two buttons write `writer_role = 'sfe_manager'`; a check he recommended on moves to `/admin/field-crm/sfe-recommendations`. The rest below is history. Rules: `.claude/rules/phoenix-crm-place-decisions.md`.

Owner, 2026-10-19: *"show check place to sfe manager exactly as it in the admin account to be able validate approve and refuse"* — widening his own 2026-10-03 "only system admin can approve or reject". Same day, asked what the SFE Manager should get next, he picked *"Mock-location evidence"*: the phone's mock answer and the position cases are now in his evidence on the Place Checks screen.

`canDecideValidationReviews` (`src/lib/phoenix-crm/server/access.ts`) admits the Super Admin on `update` and the SFE Manager on `approve`; never a test account, never a district manager. The page, the Place Checks hub card and the seven decision routes are gated on `approve`.

**Why:** the SFE Manager holds `phoenix_crm` read + approve and no `update`. Giving him `update` would clear every gate at once and open every other `update` route in the module to him.

**How to apply:** when a Place checks gate goes red for the SFE Manager, never add `update` to his grant. Three things did NOT widen, each its own earlier ruling: seating a customer in a polyclinic (`canDecideSharedPlaces`, 2026-10-10), settling an integrity case (2026-10-09), and the email/in-app/Telegram notice of a new hold (Super Admin only). The device evidence is his on THIS screen only: `loadPlaceCheckIntegrity` has no tier (its seat scope throws for anyone else), while the integrity board and the Visit report still narrow him to `SFE_SOURCES` and leave `device_mocked` out of the select (`readsPositionCases`, 2026-10-02) — never widen `readsPositionCases` to give him the Place Checks evidence. Pinned by `tests/phoenix-crm-sfe-place-checks.test.ts`; account in `docs/phoenix-crm-validation-feedback.md`. Related: [[never-fire-bulk-emails-ever]].
