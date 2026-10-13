---
name: a-second-live-feed-link-silently-pauses-the-weekly-token-rotation
description: "Minting a sheet share link without revoking the old one leaves TWO live feed links, and all three *-rotate-sheet-token rotations then refuse rather than rotate — the only signal is a heartbeat strand four days later, and the screen that minted it says nothing"
metadata:
  node_type: memory
  type: project
  originSessionId: 4743fd55-7dc6-47fe-8cbf-3b848995107e
  modified: 2026-10-13T01:43:45.015Z
---

**All three weekly sheet-token rotations refuse outright when more than one live `surface='feed'`
share link exists.** The guard is deliberate and correct — rotating blind could revoke the token the
Google Sheet is actually reading — but its only outward sign is the job's heartbeat going overdue
days later.

Measured on production 13 Oct 2026 for `phoenix-cv-lifecycle-rotate-sheet-token`:

- 8 Oct 16:23 Cairo — B-10 minted a new CV-lifecycle feed link from
  `/recruitment/cv-lifecycle-sheet` and did not revoke the previous one. `createCvLifecycleShareLink`
  does not revoke, and nothing warns.
- 9 Oct 04:03 Cairo — cron-job.org job `8387636` fired on time, HTTP 200 in 1.46 s. The route
  returned `rotated: false` and pinged the dead-man's switch **fail**:
  `"2 live cv-lifecycle feed links exist; resolve the ambiguity before rotating"`.
- 13 Oct 04:15 Cairo — the heartbeat sweep reported it stranded, 3 d 22 h late. **That was the first
  signal anywhere**, and it names the job, not the cause.

**The 200 is why this hides.** cron-job.org shows `lastStatus: 1` (OK) and the job detail looks
perfectly healthy, because a no-op is a normal 200 by design (`app/api/cron/*-rotate-sheet-token`
returns 200 for every falsy outcome so a scheduler is never trained to ignore real errors). Only
`job_heartbeats.last_detail` carries the reason — read that column, never the scheduler's colour.

**Which link to keep is decided by `access_count` and `last_accessed_at`, not by `created_at`.** The
sheet polls hourly, so the one it is really using has thousands of reads and a stamp from the last
hour; a minted-but-never-adopted link has 1 read a few seconds after it was created and then
nothing. On 13 Oct the 2 Oct token had 3,116 reads (latest 03:34 Cairo that morning) and the 8 Oct
one had exactly 1. Revoking the newer, unused one is what un-strands the job; revoking the older one
would have taken the sheet dark.

Same guard, same shape, in all three: `ats_cv_lifecycle_share_links`,
`direct_order_report_share_links`, `marketing_request_report_share_links`. Checking all three for a
second live feed link is one query and worth doing whenever one of them strands —
[[sheet-token-rotations-had-no-schedule-for-18-days]] is the other way these jobs go quiet.

**Why:** the failure is invisible at the moment it is created and only surfaces as a stranded job
days later, with the cause in a column nobody reads.

**How to apply:** when a `*-rotate-sheet-token` job strands, read
`job_heartbeats.last_detail` first, then count live `surface='feed'` links in that sheet's table. If
there are two, keep the one with the live `last_accessed_at` and revoke the other — the scheduler's
own history will show a green 200 and tell you nothing.
