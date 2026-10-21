---
name: dm-test-accounts-see-a-copy-of-the-real-rep-plans
description: "Phoenix CRM test accounts read ONLY is_test rows, so a district manager test account showed no rep plans and empty vacant-area lists; on 2026-10-21 the owner had the real lists and weekly plans of every rep territory under an active DM test account copied into the test world by SQL (no code, no merge). Re-sync = re-run that copy."
metadata:
  node_type: memory
  type: project
  originSessionId: 7da3cbbe-cf6b-44d7-a219-243c7b253637
  modified: 2026-10-20T21:07:10.093Z
---

On 2026-10-21 (Cairo morning) the owner asked: "in test accounts, I want the plan of the reps to be synced … from database … don't merge … the list of the vacant areas to be appearing in the district manager's test accounts, and the rep plan."

Done as a one-shot SQL copy on production (ozucdzovmcqvepbozvqf), test rows only:
- Scope: rep seats whose parent DM/ACTING_DM seat is held by the person an active `District Manager` TEST- account mirrors (29 seats, 6 vacant: AIF Menoufia 1, CNS Heliopolis / Cairo East 2 / Cairo West, PED Menoufia 1, AIF Suez).
- Customers: each real customer got an is_test twin unless one already existed (twin = same reference_contact_crm_id, else list_type + lower(name), matched in creation order). Existing test-rep twins were NOT changed. Test customers went 623 → 4,415.
- Plans: each real weekly plan with no test plan for that seat+week was copied (60 plans, every territory's plan-row count equal to the real one, activities and day starts included, place_id null because a place's photo_path is unique). Each copy carries a `created` plan_events row with `details.test_world_sync = true` and `source_plan_id`.
- Real data untouched (16,088 customers, 118 plans before and after); 0 test plan rows point at a real customer.

**Why:** the test world is fenced (`isTestPersona` forces every CRM read to is_test), so without a copy a DM test account has nothing to review.
**How to apply:** a "re-sync" means re-running the copy: add missing twins, add missing plans, and refresh only test plans whose every event is the sync's own (a test plan anyone worked on is left alone). `supabase-production` declines a statement containing `delete`, so the refresh half goes through the account connector — see [[a-declined-tool-call-is-not-proof-the-change-did-not-land]]. It is a snapshot: real plans sent after the copy do not appear until re-synced.
