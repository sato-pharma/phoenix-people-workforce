---
name: crm-visit-type-maps-there-are-three-not-two
description: "The CRM visit-type AV/CP classification now lives in ONE table, src/lib/crm/visit-type-meaning.ts (unified 2026-09-13, was three drifting copies). Classify a new code ONCE there. It is read TWO ways deliberately: the compliance/money path leniently (unknown → CP = working time), the attendance deduction path strictly (unknown → no flag → judged on punch timing). -4 is the only LEAVE type; everything else classified is CP. Nothing alerts on an unmapped visit type."
metadata:
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-09-26T01:03:59.139Z
---

## Current state — ONE table

The visit-type AV/CP classification lives in a single source: **`src/lib/crm/visit-type-meaning.ts`**
(unified 2026-09-13, replacing three copies that had drifted). **A new visit-type code is classified
ONCE, in that file** — pinned by `tests/crm-visit-type-meaning.test.ts`. Use its exported accessor; do not
re-read raw Sets/Maps.

## 🔴 It is read TWO ways, on purpose

- **Compliance / money-attribution path reads it LENIENTLY:** an unknown code defaults to **CP (working
  time)** (`?? "CP"`). This is the numerator side — an unlisted code still counts as a worked day.
- **Attendance deduction path reads it STRICTLY (whitelist):** an unlisted code sets **no flag**, so no
  deduction-cancel fires and the day is judged on **punch timing alone**.

That divergence is **deliberate**, not a drift to "fix": silently cancelling a deduction for an
unclassified code is the riskier default, so the deduction path fails to punch-timing rather than to a
free skip. `leaverVisitTypeStatus` also reads it strictly and reaches nothing live in `src`/`app`.

## Durable classification facts

- **`-4` is the ONLY leave type.** Everything else that is classified is **CP / working time** — including
  `-5` (Public Holiday) and `-6` (Casual Leave), owner ruling 2026-08-21, and `-15` (Health Day), owner
  ruling 2026-08-01. `0` is counted separately. See
  [[public-holiday-and-casual-leave-are-working-days]] for which classification actually reaches salary.
- **In the deduction module, leave and field-visit both CANCEL a deduction** (`digest-reconcile.ts`: both
  `hasCrmLeave` and `hasCrmFieldVisit` → `skip`). So a leave-vs-field-visit misclassification is **cosmetic
  for money** — it changes only the reason string and the day-report label, never the deduction outcome.
  That is why `-7` is classified CP even though its comment text is genuinely ambiguous
  (`classifyAmbiguousComment` can read some rows as leave): it matches the money path and costs nothing.
- 🔴 **Nothing alerts on an unmapped visit type.** `crm/unmapped-alert.ts` covers unmapped AGENTS, not
  unmapped visit types — so a brand-new code silently takes the two defaults above (CP on the money side,
  fall-through on the deduction side) until a human classifies it in `visit-type-meaning.ts`.

See [[ireports360-undocumented-visit-type-codes]].
