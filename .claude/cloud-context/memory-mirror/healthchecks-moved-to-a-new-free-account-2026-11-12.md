---
name: healthchecks-moved-to-a-new-free-account-2026-11-12
description: "The old Healthchecks account died 9 Nov 2026 17:45-18:00 Cairo (API key 401, every ping 404); a NEW free account holds exactly 20 checks since 12 Nov — a new project's sample check takes a slot, the API refused a 20th create but a ping auto-provisioned a 21st, an API key is shown ONCE"
metadata:
  node_type: memory
  type: project
  originSessionId: 8d69d082-3260-4564-9f47-4a72441125cd
  modified: 2026-11-12T19:55:59.140Z
---

**The old Healthchecks account went dead between 17:45 and 18:00 Cairo on Sunday 9 Nov 2026**, mid-deployment,
with no key change: its API key answered 401 "wrong api key" and every ping 404. The refusals were already
"normal" log noise (jobs with no check pinged too), so nothing said so for three days — 1,822 refusals from 42
jobs on 12 Nov alone. The owner created a NEW account (free plan) on 12 Nov 2026.

What is true since 12 Nov 2026, ~21:52 Cairo (PR 288 merged as `e1c7ff4`):

- **Exactly 20 checks** — `HEALTHCHECKS_CHECKED_SLUGS` in `src/lib/observability/job-schedule.ts`; every other
  job is in-house only (`job_heartbeats`) and `pingHealthchecks` returns before any request for it. The other 37
  declared jobs are marked in-house in both tables of `docs/observability.md`.
- **A NEW project ships a sample "My First Check" that takes a slot** — the management API's 20th create
  (`POST /api/v3/checks/`) answered HTTP 403 until the sample was deleted (owner approved). **But the ping path
  does not stop at the same number:** at 21:53 the pre-288 code (which pinged every job with `?create=1`)
  auto-provisioned a 21st, `phoenix-interview-reminders`. Measure the ceiling, never assume 20; and any check
  outside `HEALTHCHECKS_CHECKED_SLUGS` is a leftover to delete (owner approved deleting them, 12 Nov), or it goes
  "down" ~25 h after its pings stop and emails a false alarm.
- **An API key is shown ONCE** (the "API Key Created!" window); the ping key can be revealed again any time by
  clicking its masked value on Settings → API Access.
- Where the keys live: `HEALTHCHECKS_API_KEY` in the PRIMARY's `.env.local` (the worktree copies may hold the
  dead one); `HEALTHCHECKS_PING_KEY` in the GitHub secret and on Railway production `phoenix-people-workforce`
  AND `phoenix-workforce-worker` (SHA-256 fingerprint prefix `ad44f238`). The one channel is the owner's email.

**Why:** a dead monitoring account looks exactly like a few missing checks unless refusals are rare.
**How to apply:** a burst of `deadmans_switch_ping_refused` now means something real — check the account first
(`GET /api/v3/checks/` with the API key; 401 = dead account). Schedules come from the doc table via
[[healthchecks-schedules-are-synced-from-the-doc-table]]; a refused auto-provision answers 404 per
[[a-refused-healthchecks-autoprovision-answers-404]]. Keys travel only through the owner's paste
([[the-terminal-panel-cannot-see-npm-tools]]).
