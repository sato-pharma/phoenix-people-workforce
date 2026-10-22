---
name: back-to-railway-checks-only-that-railway-answers-not-its-revision
description: "emergency-host back-to-railway flips the domain to whatever Railway serves — it checks /api/healthz answers, never the revision. On 22 Oct 2026 Railway still served ed7797a85 (20 Oct, pre-rotation), so pressing it before Railway deploys main would roll production back. Owner's word ~05:30 Cairo: \"point production back at Railway when its deploys resume\"."
metadata:
  node_type: memory
  type: project
  originSessionId: 78db3fb8-43e6-42e4-9a0f-0a85819d1194
  modified: 2026-10-22T02:34:41.111Z
---

`scripts/emergency-host.mjs point --to railway` (the `back-to-railway` action) refuses only when
`https://phoenix-people-workforce-production.up.railway.app/api/healthz` does not answer. It never compares the
revision. Read 22 Oct 2026 05:29 Cairo: Railway's website deployment `8e92e010` = `ed7797a85` (21 Oct 00:29 Cairo),
from before the 22 Oct key switch-off and secret rotation, and every deploy since answers "Paused temporarily".

The owner said **"point production back at Railway when its deploys resume"** (22 Oct ~05:30 Cairo). An earlier
word (05:13) was "deploy main HEAD to Railway when builds resume" — website only.

**Why:** a healthy-looking `/api/healthz` on an old build sends staff to stale code (and, here, the pre-rotation
build).

**How to apply:**
- Flip back only after Railway's website runs main's newest released commit: direct `/api/healthz` `revision` =
  that commit (at least what the Fly standby serves) and direct `/api/readyz` 200 (the release gate read from the DB).
- Then the worker, in the documented order ([[the-background-worker-runs-on-fly-while-railway-is-down]]): Fly worker
  to 0, Railway worker `PHOENIX_PROCESS_ROLE=worker`, deploy it, prove `[process-role] worker` and
  `[crm:live-poll] started`, then move the 4 cron-job.org jobs (8344730 crm-contact-lists, 8200919
  recruitment-email-intake, 8200914 process-notifications, 8200920 inbound-intake, which is switched OFF; keep it
  off) back to `phoenix-workforce-worker-production.up.railway.app`.
- Then delete the Fly worker app: the owner said **"delete the Fly worker app after the move back"** (22 Oct ~05:40
  Cairo). Only `phoenix-worker-standby`, only after the Railway worker is proven running the jobs and the 4 jobs
  answer from Railway; the website standby `phoenix-hr-standby` stays (zero machines between emergencies).
- 05:35 Cairo: Railway worker and website variables matched on all 124 shared keys (0 differ), so the worker's
  stored settings are current; only its role is `web` on purpose.
- Fly's secret digests are keyed (not sha256/sha1/md5/fnv of the value), so Fly cannot be compared with Railway by
  hashing; compare Railway services with each other instead.
