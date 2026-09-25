---
name: early-birds-runs-on-two-clocks
description: "Early Birds start score is GPS-only but its \"#1 days\" component still falls back to paperwork time — 12.2% of district-days crown a different rep."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7f29f306-e89f-4719-a848-435828f8e050
  modified: 2026-08-16T14:11:35.583Z
---

Audited 2026-08-16 against production. **The CRM clock itself is correct** — `ireports360_checkins.check_date`
digits are Africa/Cairo wall-clock stored verbatim in a UTC-session `timestamptz`, JSON renders
`+00:00`, so both readers agree (`crmMinutesPastMidnight` string regex in `collect.ts`, `getUTCHours()`
in `daily-board.ts`). Live proof: latest check-in read 17:03 with Cairo at 17:06 / UTC 14:06. Force
median first check-in = **09:52** over 717 rep-days (p05 09:06, p95 15:19) — a real field day, not a
shifted one. The poller is live (~35s ticks, 485 runs that day, 0 failures).

**The defect is that the module scores on TWO clocks.** The 2026-08-09 owner fix made the *start*
component GPS-only (`scoring.ts` — `gpsStartByRepDay`, the rep's earliest check-in ANYWHERE that day).
It did **not** touch the *first-place* component, which comes from `daily-board.ts` →
`buildNsmCrmCompliance` → `resolveVisitTime` = GPS check-in → **`crm_save_date`** → none. So paperwork
time still decides who "won the day", which is 10% of the total score.

Measured, fortnight 2026-08-01..15:
- **145 of 823 rep-days (17.6%)** had their daily-board rank set by `crm_save_date`.
- **119 of those had NO GPS clock at all** — the scorer records "no verified start" for them while the
  daily board still lets them win the day.
- Even where both clocks are GPS they differ: board time averages **+15 min** vs the rep's own earliest
  check-in (worst +638 min), because the board takes the check-in matched to a *contact* while the
  scorer takes the earliest check-in anywhere.
- **23 of 188 contested district-days (12.2%) crown a different rep** depending on the clock.

Calibration note, separate from the bug: `EARLY_BIRDS_START_BEST_MINUTES = 08:00` scores 1.0 and
12:00 scores 0.0, but only **5 of 717 rep-days** start before 08:00. The biggest-weighted component
(0.30) is therefore compressed into roughly the 0.3–0.7 band and discriminates less than intended.

**Why:** a leaderboard that measures arrival on one clock and awards daily wins on another is
indefensible the first time a rep counts his own wins — the module's own `daily-board.ts` header says
exactly this about a second implementation, and it has one.

**How to apply:** before changing it, get the owner's ruling on the business question — *may a rep
with no GPS check-in win the day at all?* Making the daily board GPS-only removes those 119 rep-days
from contention and moves 23 already-awarded district-days. Do not "fix" it silently.
Related: [[owner-office-allocation-rule-value-share]] for the same "one rule, two implementations"
failure class.
