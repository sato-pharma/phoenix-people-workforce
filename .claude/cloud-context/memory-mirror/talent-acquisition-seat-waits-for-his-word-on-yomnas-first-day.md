---
name: talent-acquisition-seat-waits-for-his-word-on-yomnas-first-day
description: "The Talent Acquisition seat (key HR Resourcing) is HANDED OUT BY THE OWNER HIMSELF in User Access (\"Just build the account. I will add here later.\", 2026-10-08) — never assign it for him. The HR Business Partner seat (HR Advisory) was RETIRED the same evening (\"no more HR business partner … everything regarding recruiting is for the talent acquisition\"; the rest \"Leave it for system administrator now\"), so until he hands the seat out, recruiting and the old seat's other work are the Super Admin's alone — by his choice, never \"fix\" it back."
metadata:
  node_type: memory
  type: project
  originSessionId: 20dab7a8-3489-4f14-bae1-fcaf52a0e6bb
  modified: 2026-10-08T21:30:00.000Z
---

The seat is built and live (#5552, #5557, #5560, 2026-10-08). Nobody holds it yet. The new hire is **Yomna Gamal**: offer "Talent Acquisition Specialist" sent 2026-10-07, start date 18 October 2026, not accepted as of 2026-10-08 20:45 Cairo, no employee record and no login yet.

Asked when Yomna should get it, the owner chose **"I'll tell you on her first day"**, then the same evening: **"Just build the account. I will add here later. Just build it and shh."** So HE gives the seat out in User Access (the picker shows it as "Talent Acquisition" since #5560). Nothing is scheduled. A session never assigns it unasked, and keeps replies short on this.

**The HR Business Partner seat is RETIRED, not owed anything** (2026-10-08, PR #5565). First "move recruiting off the HR Business Partner", then "no more HR business partner. This title, no more … everything regarding recruiting is for the talent acquisition", and asked who takes the rest, "Leave it for system administrator now". So: `HR Advisory` is a dormant key in `retiredPhoenixRoles` (empty grants, salary-redaction restrictions kept, refused by User Access); the "HR Business Partner" title and its workbook are gone; its four other functions sit on `UNASSIGNED_HR_FUNCTIONS` (the Super Admin's). The workflow-registry migration `20261008235900_retire_hr_advisory_seat.sql` is APPLIED in production — before it, the Talent Acquisition seat could open the pipeline but move nothing, nor file her own leave. Until he hands the seat out, only the Super Admin works the pipeline — he was told and chose it.

For reference, when he does hand it out: the account is auto-provisioned as `Employee` — "Talent Acquisition Specialist" is deliberately NOT in `INITIAL_ACCESS_ROLE_BY_TITLE` (`src/lib/employees/access-role.ts`, a closed map of rank-100 field roles; never add this title). The role change is HIS click in User Access (`upsertAccessUserCore` in `src/lib/admin/access-control.ts` writes `app_auth_users.role`, `user_access_profiles` and the session bump together).

**Why:** he wants the hand-over on his word, not a timer, and he chose to move recruiting before anyone holds the seat.

**How to apply:** never give an HR seat recruiting back to "cover" the empty seat, never revive the HR Business Partner seat or title, never hand its unassigned functions to a seat unasked, and never create the new hire's employee record or login ahead of HR's own flow. Related: [[hr-seats-are-composed-from-a-function-catalogue]].
