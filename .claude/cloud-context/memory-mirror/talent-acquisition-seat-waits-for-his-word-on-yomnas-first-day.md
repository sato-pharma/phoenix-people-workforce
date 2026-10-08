---
name: talent-acquisition-seat-waits-for-his-word-on-yomnas-first-day
description: The Talent Acquisition seat (key HR Resourcing) is HANDED OUT BY THE OWNER HIMSELF in User Access ("Just build the account. I will add her later.", 2026-10-08) — never assign it for him; what is still owed on his word, when Yomna Gamal starts (18 Oct 2026), is the PR dropping "recruiting" from HR Advisory.
metadata:
  type: project
---

The seat is built and live (#5552, #5557, 2026-10-08). Nobody holds it yet. The new hire is **Yomna Gamal**, offer "Talent Acquisition Specialist" sent 2026-10-07, start date 18 October 2026, not accepted as of 2026-10-08 20:45 Cairo, no employee record and no login yet.

Asked when she should get it, the owner chose **"I'll tell you on her first day"**, then the same evening: **"Just build the account. I will add her later. Just build it and shh."** So HE gives her the seat in User Access (the picker shows it as "Talent Acquisition" since #5560). Nothing is scheduled. A session never assigns it unasked, and keeps replies short on this.

Two things make the hand-over:
1. **Her login gets the role `HR Resourcing` — HIS click in User Access, not a session's.** For reference only: Her account is auto-provisioned as `Employee` — the job title "Talent Acquisition Specialist" is deliberately NOT in `INITIAL_ACCESS_ROLE_BY_TITLE` (`src/lib/employees/access-role.ts`: the closed map only holds rank-100 field roles; never add this title to it). Change it the way User Access does — read `upsertAccessUserCore` in `src/lib/admin/access-control.ts` first and mirror every table it writes (`app_auth_users.role`, `user_access_profiles`, the session bump), never `app_auth_users.role` alone.
2. **The recruiting move lands the same day:** delete `"recruiting"` from `HR_ROLE_BUNDLES["HR Advisory"]` in `src/lib/auth/hr-functions.ts` (the comment above the HR Resourcing bundle says exactly this). The blueprint answer was "Move it to Talent Acquisition — the HR Business Partner keeps engagement, retention, probation and workforce insight." That is a PR; merging it is his.

**Why:** an empty seat holding recruiting alone would have left the pipeline with nobody but the Super Admin, so the move was held to her first day; and he wants the hand-over on his word, not a timer.

**How to apply:** if she has no account when he says it, say so and stop — never create her employee record or login ahead of HR's own flow. Related: [[hr-seats-are-composed-from-a-function-catalogue]].
