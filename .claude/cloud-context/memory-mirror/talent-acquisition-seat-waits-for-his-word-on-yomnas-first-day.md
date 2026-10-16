---
name: talent-acquisition-seat-waits-for-his-word-on-yomnas-first-day
description: "HANDED OUT — the owner gave Yomna Gamal the Talent Acquisition seat himself on 2026-10-10 20:59 Cairo (app_auth_users HR-011, role `HR Resourcing`, active), so the 2026-10-08 \"just build the account, I will add here later\" is CLOSED. Her employee record exists (HR-011, job_title `Talent Acquisition`, created 2026-10-10 20:59). Still open as of 2026-10-16: her app_auth_users row has **no email**, so she has no sign-in, and she starts Sunday 18 October 2026. The HR Business Partner seat (HR Advisory) stays RETIRED — never revive it."
metadata:
  node_type: memory
  type: project
  originSessionId: cf710d0c-aa4b-4707-8344-754e4089a663
  modified: 2026-10-15T22:31:59.187Z
---

**Verified on production `ozucdzovmcqvepbozvqf`, 2026-10-16 ~01:35 Cairo.** This note previously said
she had no employee record and no login, and that the seat was waiting on his word. Both were true on
2026-10-08 and are **no longer true** — he acted on 2026-10-10.

- `employees` **HR-011** — Yomna Gamal, job_title **`Talent Acquisition`**, department Human Resources,
  `employment_status` active, created **2026-10-10 20:59:07 Cairo**.
- `app_auth_users` **HR-011** — role **`HR Resourcing`** (the Talent Acquisition seat), `is_active` true,
  created **2026-10-10 20:59:14 Cairo**, **`email` is NULL**.

**The one thing still open: she has no sign-in.** A null `email` on the auth row means no credential to
give her. Her New Starter Handbook Part One (built 2026-10-12, `SATO-DIS-2026-01 v1.0`) ends on a page
that shows SIGN-IN and PASSWORD as masked rows with the status "Being prepared for you" and promises
Part Two "within the week". Her first day is **Sunday 18 October 2026** (confirmed a Sunday).

**Title mismatch to settle before Part Two prints:** Phoenix holds `Talent Acquisition`; the handbook
and her offer both say **Talent Acquisition Specialist** (pages 1 and 6). One of the two should move.

**The HR Business Partner seat is RETIRED, not owed anything** (2026-10-08, PR #5565): `HR Advisory` is a
dormant key in `retiredPhoenixRoles`, the title and its workbook are gone, and its four other functions
sit on `UNASSIGNED_HR_FUNCTIONS` (the Super Admin's). Migration `20261008235900_retire_hr_advisory_seat.sql`
is applied in production. Never revive the seat or the title, and never hand its unassigned functions to
another seat unasked.

**Why:** he moved recruiting onto this seat before anyone held it, then filled it himself two days later.

**How to apply:** do not re-ask whether to assign the seat — it is assigned. Do not create or alter her
records to "finish" onboarding. The live gap is the sign-in email, and giving someone a credential is
his call, not a session's. Related: [[hr-seats-are-composed-from-a-function-catalogue]],
[[the-house-document-identity-standard]].
