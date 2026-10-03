---
name: the-october-2026-intake-identity-block-is-hr-operations-to-fill
description: "The 12 medical reps hired 1-4 Oct 2026 have an EMPTY identity block (no national ID, birth date or social insurance no.) - owner ruled 2026-10-03 that HR Operations enters it later. Do not re-raise it as a finding, and never fill it by parsing their CVs."
metadata:
  node_type: memory
  type: project
  originSessionId: 8bf7ccfe-bc48-47b1-936a-ca1e1140afa2
  modified: 2026-10-03T06:54:05.162Z
---

Twelve medical representatives were hired **1–4 October 2026** (eleven on the 1st, Asmaa Zaghloul
Sayed Hussien on the 4th) and carry **nothing** in the identity block: 0 of 12 have a national ID,
a birth date or a social insurance number, against 62, 64 and 59 of the other 64 active reps. Six
have no mobile and three no work email. **The owner ruled on 2026-10-03: "leave them for now, the
HR operation will add later."**

🔴 **It is NOT a "register gap" and must not be reported as one.** I surfaced it twice in one
session as "12 of 76 reps missing a birth date", which reads as neglect and cost him a turn; the
real state is that this week's intake exists in the system before its onboarding paperwork has been
keyed in. The same twelve are the whole of the mobile and email gaps too — there is one cause, not
three findings. Any audit that counts missing identity fields should **split the cohort by
`hire_date` first** and say "this month's intake, paperwork pending" rather than listing names.

🔴 **NEVER FILL IT BY PARSING THEIR CVs.** Nine of the twelve have a CV on file and Egyptian CVs
usually state a date of birth, which makes "just extract it" the obvious-looking move. It is
refused: `a-cv-import-overwrote-a-candidates-whole-identity` is the same operation doing real
damage, and an LLM-parsed date written into twelve live employees' identity block is identity data
nobody verified. There is also no derivation available — the national ID encodes the birth date in
digits 2–7, but none of the twelve has one, and their `ats_candidates` rows carry neither field.

The app already surfaces this without anyone building anything: `employee-record-health.ts` checks
14 fields including Birth Date and National ID, and renders on the Employee Master screen at
`/employees`. The data comes back in through the existing employee import (`/api/imports/employees`
dry-run → confirm).

**Why:** he knows the paperwork is in flight and does not want the same twelve names handed back to
him every time someone audits the register.

**How to apply:** when an employee-data sweep turns up missing identity fields, check `hire_date`
before reporting — a cohort hired within the last few weeks is this, and is closed. Say "pending
HR Operations" in one line, name no one, and move on. It reopens only when he says so, or when a
rep hired well before October is still blank. Related: [[a-cv-import-overwrote-a-candidates-whole-identity]].
