---
name: railway-auto-deploy-can-silently-skip-a-race
description: "A merge to main can trigger a Railway deploy that gets marked SKIPPED (not queued, not built, not failed) if another deploy is already mid-build when the webhook arrives — the merge succeeds, CI is green, but production keeps serving the OLDER commit with zero error surfaced anywhere obvious. Fix: `railway redeploy --yes --from-source`, then verify healthz proves your commit is an ancestor of the live revision."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1d7c97a0-5c4a-44b4-8bde-442c58929698
  modified: 2026-08-28T09:38:55.774Z
---

**What happened (2026-08-09).** Merged PR #1927 (`gh pr merge --squash`, confirmed `state: MERGED`).
This repo auto-deploys `main` to Railway on every push — normally near-instant. Five minutes later
`/api/healthz` still showed the PARENT commit's revision, not the merge commit. `gh api
.../deployments` showed a deployment record WAS created for the merge commit within 5 seconds of
the push (so GitHub's side worked correctly) — but its status went `in_progress` → **`inactive`**
in under a minute, never passing through `success`. Every other deployment in the history goes
`in_progress` → `success` → `inactive` (the last step only once a LATER deploy supersedes it).
Mine skipped the middle step entirely.

**Root cause, confirmed via `railway deployment list` (Railway's own view, not GitHub's webhook
mirror):** the deploy was recorded there as **`SKIPPED`**, timestamped to the exact second the
merge webhook arrived. Another commit's deploy (merged ~40s earlier by a different concurrent
session) was still `BUILDING` at that moment. Railway did not queue mine behind it — it discarded
the trigger outright. This repo merges fast enough (multiple sessions, dozens of PRs/day) that
two pushes landing within a build's duration (~5 minutes) is common, not a rare edge case.

**Why this is dangerous specifically:** nothing about it looks broken from the normal places you'd
check. `gh pr view` says MERGED. CI was green before merge. The GitHub deployments API shows a
record exists. There is no error, no failed status, no red X anywhere — the deploy that should
have shipped your change just silently never happened, and the ONLY way to see it is
`railway deployment list` (not `gh api .../deployments/<id>/statuses`, which shows `inactive` —
indistinguishable at a glance from the normal "superseded by a later success" case) or noticing
`/api/healthz`'s `revision` field hasn't moved.

**How to apply — after every merge to `main` from now on:**
1. Do not stop at `gh pr view --json state` showing `MERGED`. Check `/api/healthz` and confirm the
   `revision` field is EITHER your exact merge commit OR (if more merges landed in the interim,
   which is likely here) a commit your merge is an ancestor of:
   `git merge-base --is-ancestor <your-merge-sha> <deployed-revision-sha>`. A plain string
   mismatch is not evidence of a problem by itself in this repo — ancestry is the real test.
2. If the revision is stale after a couple of minutes, run `railway deployment list` (not the
   GitHub API) and look for your commit's deploy explicitly marked `SKIPPED`.
3. **`railway redeploy` alone is NOT the fix** — it restarts the last *successful* build artifact
   (the older, pre-merge one), so healthz will still show the wrong revision afterward and it is
   easy to mistake that restart for a real fix. The actual fix is
   **`railway redeploy --yes --from-source`**, which forces a fresh pull-and-build from the
   current `main` tip. Re-verify healthz/ancestry afterward — do not trust the command's exit
   code or the deployment list showing `SUCCESS` alone, since a `--from-source` redeploy triggered
   a few minutes late can itself pick up yet another commit that landed in the meantime (this
   happened live: the eventual deployed revision was 2 commits ahead of the original merge,
   confirmed as still including it via ancestry, not by SHA match).

Related: [[railway-merge-is-the-production-deploy]] (the base assumption this is a caveat to —
"merge = deploy" is usually true but not unconditionally, and this is the specific failure mode
where it silently isn't).

---

## The INVERSE false signal, measured 2026-08-28: `failure` while it is serving perfectly

The case above is a deploy that reads benign and never happened. This is the opposite, and it is
the one that makes you raise a false alarm.

Production deployment `6138801510` for commit `cdf31f18` (#2556) recorded, newest first:
`failure@09:36:32Z`, `failure@09:33:07Z`, `in_progress@09:32:15Z`, `failure@09:27:52Z`,
`in_progress@09:24:22Z` — **three failures, and no `success` status at any point.** Read on its own
that says the commit never shipped.

**It had shipped.** `/api/healthz` returned `revision: cdf31f18…` continuously for roughly twelve
minutes across that window, until a later merge superseded it. The code was serving traffic the
whole time the record said it had failed. I reported "deploys have been failing" to the owner on the
strength of that record and had to correct it in the next message.

**So GitHub's Railway deployment status is unreliable in BOTH directions:** `inactive` with no
`success` can mean silently skipped (above), and `failure` with no `success` can mean serving fine
(here). Neither state is evidence on its own.

**How to apply.** Do not characterize production health from `gh api .../deployments/<id>/statuses`.
Read `/api/healthz` first and let the revision decide, then use ancestry rather than a string match
(`git merge-base --is-ancestor <sha> <live-sha>`) because concurrent merges are normal here. Only
reach for the deployment record once healthz has already told you something is wrong — it is useful
for *timing* a deploy you have independently confirmed, and misleading as a verdict on one you
have not. The same session that hit this also confirmed the happy path reads correctly:
`c13965fa` went `in_progress@09:34:45Z` → `success@09:37:16Z`, with healthz agreeing at 09:37:27Z,
about 2m48s merge-to-serving.
