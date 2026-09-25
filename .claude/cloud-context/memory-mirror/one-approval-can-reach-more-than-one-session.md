---
name: one-approval-can-reach-more-than-one-session
description: "A single terse approval (\"merge 2480\") was delivered to three live sessions; one merged and shipped to production while this session was still waiting on CI"
metadata:
  type: feedback
---

2026-08-27, ~21:00 Cairo. The owner's approval reached more than the window he was looking at.
Measured by grepping every transcript under `~/.claude/projects/*/*.jsonl` for the exact user text:

- `CONTTINUE` -> **5 sessions**, 18:00:08 to 18:00:41Z
- `merge 2480` -> **3 sessions**: edc71556 @18:01:39, a16eed4d @18:01:50, 93983872 @18:02:42

Session **a16eed4d** confirmed `mergeStateStatus=CLEAN` with all four required checks green, ran
`gh pr merge 2480 --squash` at 18:04:44Z, and PR #2480 merged at 18:04:50Z as `9e40cd16` — live in
production by 18:07:33Z. It did nothing wrong: it had a real user approval in its own transcript.
This session held on the identical approval only because its rollup still read
`validate: IN_PROGRESS` (see [[gh-pr-checks-lags-behind-the-real-job-state]]).

The owner then said "i didnt merge it" — true from where he sat. He approved it in another window.

**Why:** an approval is not scoped to the window you are in. N sessions holding the same "yes" is N
executions. A second `gh pr merge` is harmless (it errors "already merged"), but a destructive SQL
statement, a bulk email, or a production migration run three times is not. There were 13 live peer
sessions in this folder at the time.

**How to apply:**

1. **Before executing a protected action on a terse approval** ("merge 2480", "yes", "go", "do it"),
   run `ListAgents` or `list_sessions`. Several live sessions in the same folder means the approval
   may be sitting in several of them. Say so in the reply, and re-verify the target's live state
   immediately before acting — `gh pr view <n> --json state,mergedAt` — not just before reporting.
2. **If it is already done, stop and report who did it. Never retry.**
3. **`mergedBy` naming the owner is NOT evidence of a human click.** Every session's `gh` and every
   local tool authenticates as his account, so the API cannot distinguish a UI merge from a session's
   command. To find the actor, grep the transcripts — they carry per-call timestamps and the verbatim
   command — not the GitHub API. A peer's own summary is an inference and can be wrong: one session
   confidently reported "merged by the owner via GitHub UI", which was false.
4. **Do not assert a technical broadcast from a shared typo.** The same misspelling in five
   transcripts looks damning, but delivery here was staggered 8-41 seconds apart and the recipient
   sets differed (edc71556 got `merge 2480` and never `CONTTINUE`) — which fits one person entering
   the same text into several windows at least as well as any relay. It also stopped on its own:
   every message from 18:03:47Z onward reached exactly one session, before any session was archived.
   Report what the timestamps show, not the tidier story.

See also [[feedback-parallel-session-pr-collision]] for the other five collision instances, and
[[a-merge-mid-session-orphans-your-next-push-silently]].
