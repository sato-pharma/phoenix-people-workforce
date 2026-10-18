---
name: cost-cuts-2026-10-14-six-decisions
description: "The 14 Oct 2026 cost-cut decisions — remote-check was widened to EVERY push and REVERTED the same day to new-test-file pushes only (the stated reason, slowing CI, was wrong: CI runs on hosted runners, not the box); same-module PR hold C18 at gh pr create (REMOVED 2026-10-19 on his word, never rebuild); Staging Branch Sync deleted; Railway staging app retired (staging Supabase kept); Synthetic Journeys one clock, 6/day every 3h 05:00-20:00 Cairo; Headwind JVM heap capped -Xmx768m via JAVA_TOOL_OPTIONS"
metadata:
  node_type: memory
  type: project
  originSessionId: 30ed678a-9458-44c4-ac3c-0ac0b5986ed1
  modified: 2026-10-18T21:40:28.795Z
---

Owner, 2026-10-14: *"i am paying hilarious dollars for phoenix in multiple channels monthly … immediate corrective actions"*, then the six: halve the merge count, remote-check mandatory before every push, cap the Headwind MDM heap, stop Synthetic Journeys firing 26×/day, fold Staging Branch Sync, retire one of two staging environments.

**Decided (his answers):** retire the Railway staging APP (staging Supabase stays) and DELETE the sync rather than fold it; remote-check before every push as a rule plus a hook that says it back (his 2026-10-04 "no guard" stood) — REVERTED 2026-10-14 afternoon on his word "revert remote-check to new-test-file pushes only", on the stated reason that remote-check shares the Hetzner box with the CI runner — 🔴 THAT REASON WAS WRONG: CI_SELF_HOSTED has been `off` since 2026-09-30 and every CI job runs on GitHub-hosted ubuntu-latest, so remote-check cannot slow CI (the revert stands as his word; the two slow runs were hosted-runner variance, cause unmeasured); halve merges with a same-module hold on `gh pr create` (bash-guard C18, `PHX_PR_HOLD_OK=1`) — 🔴 REMOVED 2026-10-19 on his word ("remove this fucken rule"): the clause, `scripts/pr-same-module-hold.mjs` and its test are gone and `PHX_PR_HOLD_OK` means nothing; the one-wide-PR judgement stays, no guard enforces it; Synthetic every 3 h, 05:00-20:00 Cairo, ONE clock (cron-job.org job 8220577; the GitHub `schedule:` leg removed).

**Two corrections I made to my own earlier claims:** folding the sync into ci.yml saves ~$0 (GitHub bills per JOB rounded up to a minute) and the branch it maintains had no consumer; and the remote-check saving is capped near $28/month, not $45. Roll-ups do not save money either — the roll-up PR pays its own CI run — so the merge lever is fewer PRs.

**Why:** 13 Oct 2026 billable minutes (ceil per job): 1,646 total, 820 PR runs, 648 pushes to main (the deploy gate, not reclaimable), 23 red + 16 cancelled PR runs = 221 minutes, 1.97 runs per branch, 55 merges. His invoice rate is ~$0.00424/min; his 1 Nov invoice is the only authority on savings.

**How to apply:** do not re-propose folding the sync, re-adding a `schedule:` block to synthetic-journeys.yml, a pre-push refusal, remote-check on every push, or the same-module hold (C18). Re-measure after 24 h and 7 days; see [[the-pre-push-remote-check-test-is-a-rule-never-a-guard]].
