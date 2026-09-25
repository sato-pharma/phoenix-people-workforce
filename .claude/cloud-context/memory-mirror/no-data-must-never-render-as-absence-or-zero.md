---
name: no-data-must-never-render-as-absence-or-zero
description: "Missing data and a real zero are different facts — the audit found the same confusion in attendance, exports and KPI chips; always ask the canonical detector and say 'unavailable'"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4a13ab2c-b77b-4e77-a1ed-2dd1db5c413b
  modified: 2026-08-04T00:25:08.009Z
---

The single most repeated defect class in the 2026-08-04 platform audit (24 confirmed findings)
was code treating **absence of data** as a **measured zero**.

Worst instance: `getMonthlyAttendanceSummary` counted a day with no punch row as "not present",
so when the on-prem agent stopped POSTing on 2026-07-30 the August report asserted a **100%
absence rate over ~48 days nobody was measured on** — on a column read as evidence against
employees.

🔴 **The platform ALREADY had the answer and the report never asked.**
`getCompanyWideOutageDates` (`src/lib/attendance/ingestion-health.ts`) had been protecting the
weekly digest all along. Writing a second definition of "outage" would have let the two surfaces
disagree. **Before adding a rule, grep for the canonical one** — a second definition of one
concept is how most of these bugs happened.

**How to apply.**
- A day/period with no source data is `no_data`, excluded from BOTH the numerator and the
  denominator, and SURFACED (banner + export line + its own column). Silently dropping it turns a
  visible-but-wrong number into an invisible hole, which is not an improvement.
- Under-reporting is recoverable; fabricating evidence against a person is not. Fail in that
  direction deliberately and say so in a comment.
- A failed or empty source must never render as a confident `0` or `—`.

🔴 **A source-inspection test cannot catch this being semantically disabled.** Proven the hard
way: neutering the guard (`if (false && …)`) while leaving its text in place kept an
inspection-only test GREEN. Extract the decision into a pure exported function
(`resolveWorkingDayAttendance`) and assert its behaviour. See
[[prove-it-fails-verify-which-assertion-fired]] and
[[prove-it-fails-never-git-checkout-the-fix]].
