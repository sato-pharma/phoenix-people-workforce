---
name: the-repo-is-public-since-2026-11-07
description: "The main repo is PUBLIC (since 7 Nov 2026, for free Actions minutes). A 27 Nov private spell (08:18–~11:00 Cairo) was reversed by the owner: \"I WILL KEEP ON PUBLIC TO AVOID THE COST OF ACTIONS\""
metadata:
  node_type: memory
  type: project
  originSessionId: 95681d3e-2bd6-4440-8cc2-1f176d61fe46
  modified: 2026-11-07T16:48:58.950Z
---

> **27 Nov 2026:** the repo was private for about 2.5 hours that morning, and the owner then kept it PUBLIC (10:49 Cairo). This note holds. What that spell broke (Railway lost its git source): [[the-repo-is-private-since-2026-11-27]]. A self-hosted runner must never be attached while it is public; the spare runner was removed (0 runners, 27 Nov ~11:00).

On 2026-11-07 (~12:45 Cairo) the owner made `sato-pharma/phoenix-people-workforce` **public** — his words: "MOVE REPO TO PUBLIC TO MAKE UNLIMITED CIO ACTIONS", "CONVERT TO PUBLIC REPO TEMPRERIORY BECAUSE I HAVE NO MONEY NOW". He was shown first that the history holds 51 data files (April 2026 distributor sales workbooks, pharmacy database, products list, July closing PDFs, a Playwright trace) and that a rewrite cannot purge pull-request refs; he chose public anyway.

Set at the same time: fork-PR workflow approval = `all_external_contributors` (the two self-hosted `phoenix-ci` laptop runners are still registered to the repo).

**Why:** hosted Actions minutes are free on a public repo; the org had no money for minutes.

2026-11-07 ~18:50 Cairo, his pick "Stay public, clean up": both laptop runners (`phoenix-ci-Gawish-1/2`) were DEREGISTERED from the repo (runner count 0) — re-register on the spare before ever setting `CI_RUNNER_LABEL`. Dependabot security auto-fixes deliberately LEFT OFF (failed Dependabot runs withhold production deploys); vulnerability alerts stay on. Six data files (Source of sales area database.xlsx + five July CNS closing PDFs in `xlsx/`) were copied to `F:\Phoenix Workforce\removed-from-public-repo-2026-11-07\` pending his named OK to untrack them; the payroll/closing/business-card/MetLife templates are code-needed and stay.

**How to apply:** every push is world-readable from now on — never commit data files, real names/figures, or secrets (gitleaks C12 still guards secrets, not business data). It is meant to be TEMPORARY: going private again is his word only. Never set `CI_RUNNER_LABEL` while public without his word (outside PRs could target the laptop runners).
