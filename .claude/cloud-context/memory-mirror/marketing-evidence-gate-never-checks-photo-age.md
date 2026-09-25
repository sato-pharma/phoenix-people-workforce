---
name: marketing-evidence-gate-never-checks-photo-age
description: "evidenceStatusFromInput grants system_validated on a photo's PRESENCE, never its age — anything that restores, replays or re-submits a capture must enforce freshness itself"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3bae391f-d43d-4c21-9c4b-070fed06efee
  modified: 2026-08-23T16:02:33.179Z
---

`evidenceStatusFromInput` in `src/lib/marketing-requests/service.ts` returns `complete` — and so
`resolveMarketingSystemValidationStatus` returns `system_validated` — when a GPS fix plus a
timestamped photo are merely PRESENT. **It never compares that timestamp to now.** A photo from last
week validates exactly like one taken two minutes ago.

The only thing that has ever stopped stale evidence reaching production is that the capture lived in
React state and died with the browser tab. **That is an accident, not a guard.** Any feature that
holds a capture and hands it back later — draft recovery, an offline queue, a retry, a bulk import,
a "duplicate this customer" button — must age the evidence out itself or it becomes a machine for
laundering visits that did not happen into the marketing request customer list, where sales then get
attributed against them.

**Where the rule now lives:** `src/lib/marketing-requests/validation-draft.ts`.
`MARKETING_DRAFT_EVIDENCE_MAX_AGE_MS` = **6 hours** (sized from real captures: field sessions run
minutes, 14:56→15:00 and 13:17→13:32 UTC). Evidence older than that is stripped on restore; the
typed half — Arabic name, area, distributor codes — survives 7 days because it asserts nothing about
where anyone stood. Age is measured from the capture's own stamp, never from when the draft was
written, so re-saving cannot refresh it. Added in PR #2339 (2026-08-23).

Regression test `tests/marketing-validation-draft.test.ts` asserts this against the REAL gate — a
yesterday capture must reach `evidenceStatusFromInput` as `"missing"`. Confirmed by sabotage:
forcing freshness true yields `actual: 'complete', expected: 'missing'`.

Related: [[marketing-system-validated-means-no-human-looked]] — `system_validated` already means no
human looked; if the evidence is also stale there is nothing behind the label at all.
