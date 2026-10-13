---
name: a-deploy-watcher-keyed-to-one-sha-goes-stale-on-the-next-merge
description: a deploy watcher pinned to one merge sha reports a deploy that will never come — poll the LIVE origin/main and test ancestry instead
metadata:
  type: feedback
---

A background watcher that polls `/api/healthz` until `revision` equals **one recorded sha** is wrong
on this repo: with several sessions merging, `main` moves within minutes and Railway deploys the
newer commit, so the watcher waits out its whole window and reports nothing — twice in one night
(13 Oct 2026, ~02:30-02:55 Cairo: one watcher keyed to `3857ca68b` was superseded by #5817, the
replacement keyed to `59c2c9d77` by #5823 and #5824 landing while it polled).

**Why:** the deploy gate is per-commit but production serves only the latest one that cleared it, so
"revision == my sha" is a condition that can expire before it is ever true. Reading that as a
skipped deploy is the exact false alarm the gate rule warns about.

**How to apply:** re-read `git rev-parse origin/main` on every poll, and judge by
`git merge-base --is-ancestor <served> <head>` plus "is `<served>` at or after MY merge commit" —
then report the revision actually read, and say how many commits behind the head it is. Confirming a
commit later than mine is serving is proof my merge shipped; waiting for exact equality is not.
Related: [[the-next-step-box-must-not-manufacture-the-next-task]].
