---
name: a-superseded-deploy-reached-success-a-withheld-one-never-did
description: "A merge whose live revision is a LATER commit is usually healthy: read the deployment's own state history, because a superseded deploy went in_progress -> success -> inactive while a withheld one shows an inactive that was NEVER success"
metadata:
  node_type: memory
  type: project
  originSessionId: f151c304-4f1a-4527-86ae-ce961d80f72e
  modified: 2026-09-29T20:27:54.937Z
---

`inactive` is the word GitHub uses for both a healthy superseded deploy and a production deploy
Railway refused to ship. **The state HISTORY separates them, and nothing else does.**

**Measured 2026-09-29**, merge `3b9bc0444` (PR #4806):

```
deployments for 3b9bc0444   in_progress -> success -> inactive      <- BUILT AND SERVED
deployments for 9bfd4743e   in_progress -> success                  <- live now
live revision               9bfd4743e (contains 3b9bc0444)
```

It reached **`success`**, served, and was then superseded by #4807 merging minutes later. That is a
normal deploy that has been replaced, not a deploy that never happened.

🔴 **RAILWAY POSTS TWO DEPLOYMENT ROWS PER COMMIT HERE, AND ONE ENDS `inactive` ON A PERFECTLY
HEALTHY DEPLOY.** Measured on all three merges of 2026-09-29 — `3b9bc0444`, `f3c444d30`,
`3f717b8c7` — each had two rows, one ending `success` and one ending `inactive`. **A session that
reads only the `inactive` row concludes a good deploy was withheld.** Read every row for the sha.

🔴 **ON A SUPERSEDED COMMIT BOTH ROWS END `inactive`, AND READING THE TERMINAL STATE ALONE MAKES THE
WITHHELD TELL LOOK BROKEN WHEN IT IS NOT.** Measured 2026-09-29 on `e8194079c` and `b28639906`:
every row ends `inactive`, and every row passed through `success` first
(`in_progress -> success -> inactive -> inactive`). Both commits are ancestors of what is serving.
So the tell — an `inactive` that was NEVER `success` — is intact and correctly does not fire.
**A peer session concluded from the terminal states that the tell fires falsely and nearly had §2.3
rewritten to remove it.** Judge on the HISTORY, never the last state.

🔴 **`GET /deployments/{id}/statuses` RETURNS NEWEST FIRST**, so a bare `[.[].state]` reads
backwards and `| last` hands you the OLDEST status while looking like the final one. Use a
predicate, which cannot be read backwards:
`gh api repos/<repo>/deployments/<id>/statuses --jq 'any(.[].state; . == "success")'`

🔴 **The rows LAG the live domain — they do not stall.** `f3c444d30` was already serving while both
its rows still read `in_progress`; a minute later they resolved to `success` and `inactive`. So do
not wait for a row to turn green, and equally do not conclude from a mid-flight `in_progress` that
the row will never post: settle with `git merge-base --is-ancestor <merge> <live revision>`.

**How to apply:**

- When `/api/healthz` `revision` is a commit LATER than your merge, do not report it as a problem
  until you have read the deployment states for your own sha. Settle containment with
  `git merge-base --is-ancestor <your merge> <live revision>`, never a string compare.
- 🔴 **The tell for the real failure is an `inactive` that was NEVER `success`.** One that passed
  through `success` is benign.
- 🔴 **Classify by the SUITES too: a withheld deploy whose every suite is GREEN was superseded, not
  refused.** Read `commits/<sha>/check-suites`, not only the CI run.
- **The four third-party suites — `sentry`, `claude`, `vercel`, `railway-app` — sit at `queued` for
  ever on every commit and do NOT hold the gate.** Never chase them; on this merge all four were
  queued while the deploy built and served normally.
- In every one of these cases the recovery is to do NOTHING. **Never `railway redeploy`, never
  re-merge** — see [[a-red-main-ci-makes-railway-skip-the-deploy-for-good]] for the case that
  actually is a refusal.
