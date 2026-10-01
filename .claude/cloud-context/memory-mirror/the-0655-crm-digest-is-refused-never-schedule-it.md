---
name: the-0655-crm-digest-is-refused-never-schedule-it
description: "The Phoenix CRM 06:55 daily digest was refused on 2026-09-27 and RESTORED on 2026-09-28 at the owner's own instruction (\"i want it in app or telegram only\") - it is LIVE in all three places plus cron-job.org job 8526396, so never delete its schedule; the durable rule is that a declaration and its cron job move together, never one without the other"
metadata:
  node_type: memory
  type: project
  originSessionId: e94a655d-2c8b-49f4-9c2c-ad15fddfe252
  modified: 2026-10-01T00:00:00.000Z
---

🔴 **The slug still says "refused". It is not refused any more — read this before acting on the
name.** The refusal lasted one evening.

- **2026-09-27** — owner: **"donot create this digest i donot want it"**. Schedule removed from all
  three places (PR #4542). Nothing had ever been sent.
- **2026-09-28** — owner asked for it back, in his own words: **"i want it in app or telegram
  only"**. Restored by `e5b3436d3` (PR #4569). The channel condition he attached was already how it
  was built: `deliver` asks for `["in_app", "telegram"]` and the module guard strips email whatever
  any caller asks for.

**It is LIVE now, and consistent across all four** (verified 2026-09-28):

| Place | State |
| --- | --- |
| `JOB_SCHEDULES` (`src/lib/observability/job-schedule.ts`) | `{ slug: "phoenix-crm-daily-digest", kind: "cron", schedule: "55 6 * * *", graceSeconds: 2h }` |
| `scripts/cronjob-sync.mjs:135` | `"phoenix-crm-daily-digest"`, 06:55, `requestTimeout: 300` |
| `docs/observability.md:331` | the row, naming cron-job.org job `8526396` · **in-house only** |
| cron-job.org | job `8526396` exists — the id is recorded in the doc row above |

🔴 **So never delete its schedule, and never "tidy up" the declaration.** The old instruction here
was *"never re-add the slug to any of the three"*, and obeying that today removes a live schedule.

**The durable rule, which never changed and cuts BOTH ways:** a declaration and its cron job land in
the same sitting, never one without the other. A declaration with no job behind it is read by
`job-heartbeat-assess` as a job that has **STOPPED** — once one 06:55 passes, `hadAChanceToRun` is
true, the slug has never reported a success, and it files as **stranded**: an in-app, Telegram and
push alarm to every Super Admin, every sweep, for ever, about a job nobody is running. Deleting the
cron job while leaving the row does exactly that, and so does merging a row before creating the job.

**How to apply:**
- Treat the three declarations as one unit. Change all three together or none.
- Pinned by `tests/phoenix-crm-daily-digest.test.ts`, whose schedule section now asserts the
  PRESENCE of all three.
- Adding a NEW scheduled job? Prefer piggybacking an existing cron route over a fourth declaration —
  `/api/notifications/daily` (06:36 Cairo, cron-job.org `8200909`) already runs 22 sub-jobs and costs
  no declaration, no heartbeat exposure and none of the cron-job.org 100-requests-a-day quota.
- The nightly 03:35 integrity sweep is a different case and IS live (cron job `8525234`): it messages
  nobody, which is why it was never in question. See
  [[railway-cli-is-linked-to-phoenix-headwind-not-the-app]] for how to run the sync at all.
