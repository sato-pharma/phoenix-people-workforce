---
name: the-pre-push-remote-check-test-is-a-rule-never-a-guard
description: "A push that ADDS a test file runs `node scripts/remote-check.mjs test` FIRST and goes out on its `PASS — <sha9>` (owner, 2026-10-12); every other push stays commit-push-PR with remote-check optional (2026-10-08). It is still a RULE, never a guard: the 2026-10-04 \"keep the pre-push test as a rule, no guard\" stands until he lifts it, so push-typecheck-guard.mjs prints the rule with the added files and ALLOWS the push, and refuses only on a recorded typecheck FAIL for that exact sha."
metadata:
  node_type: memory
  type: feedback
  originSessionId: e39a8848-5059-4305-a1d5-83e9c4ec9c6f
  modified: 2026-10-12T15:41:28.084Z
---

**🔴 NARROWED BACK IN, 2026-10-12 — read this first.** The owner typed **"make remote-check test
mandatory before a push that adds a test file"** (18:12 Cairo), after being shown that day's CI
reading. So: a push whose commits ADD a `tests/**.test.ts(x)` file runs `node
scripts/remote-check.mjs test` first — once, with `run_in_background: true` — and goes out on its
final `remote-check: PASS — <sha9>`. **Every other push is unchanged** by this: commit, push, open the
PR, `remote-check` optional.

**What he was shown (12 Oct 2026, measured from the Actions API):** 26 of the 59 PR CI runs that
finished went red — **44%**, against 19-23% on 7-11 Oct and 6% on the 6th — with 116 minutes of wall
clock inside red runs and `main` itself green on all 34 push runs. Of the 25 reds enumerated, **13
were repo-wide contract gates with nothing to do with the change being shipped**: 6 the
AGENTS.md/rules hook-length gate, **4 the zero-tolerance `comment-strip-ratchet`, which fires on a
newly added test file that hand-rolls comment stripping**, 2 the API reverse-guard backlog, 1 the
access registry. Four branches ate 16 of the 25; one went red seven times, a different gate each
round, because the PR run was the first thing that ever looked.

**🔴 IT IS STILL A RULE, NOT A GUARD, AND THAT HALF DID NOT CHANGE.** On 2026-10-04 he was offered a
hook that REFUSES `git push` unless a green suite exists for that sha and answered **"keep the
pre-push test as a rule, no guard."** That ruling stands until he lifts it in his own words: never
build, propose or "just suggest" one, in a `Next step:` line or anywhere else. What
`.claude/hooks/push-typecheck-guard.mjs` does instead, shipped 2026-10-12: when the pushed commits add
a test file and hold no `test` PASS for that exact sha, it prints the rule, the files it saw and the
command — and **allows** the push. It still refuses only on a recorded typecheck FAIL. Pinned by
`tests/push-typecheck-guard.test.ts`, whose cases fail if the deny arm ever grows past the typecheck.
Where the rule is written: `CLAUDE.md`, `AGENTS.md` §7, `.claude/rules/engineering.md` (Validation),
the CI-and-PRs trap cluster, and `docs/testing.md` "Before every push".

**The 2026-10-08 half that still governs every other push** (owner, performance recovery): commit,
push and open the PR; its `validate` + `checks` are the verdict. Measured from 1,230 transcripts, the
2026-10-04 before-every-push step cost 6.5 session-hours a day plus 17.6 hours of foreground poll
loops on 4-8 Oct, because one 7.7 GB box served ~9 sessions one run at a time. Exit 0 PASS, 1 FAIL,
2-9 NO VERDICT — and a NO VERDICT is never a pass: say so and push, never wait on the box.

**Why the step earned its place on 2026-10-04, kept for the evidence.** On
`codex/app-password-capture`, `remote-check all` answered `FAIL — e38895cc7` with **`lint PASS` and
`test PASS in 218s`** and two `TS2322`s: adding `describeAppPasswords` as a required member of
`JoinerConsoleDriver` broke the hand-rolled driver literals in `tests/new-hire-mailbox-adopt.test.ts`
and `tests/new-hire-mailbox-runner.test.ts`. The local suite was GREEN over the same code, which is
[[a-green-test-run-carries-no-type-signal-at-all]].

**How to apply:** run it yourself and push only on a final `remote-check: PASS — <sha>` line read
from the output file — the background notification's exit code is not the verdict
([[remote-check-background-exit-code-is-not-the-check-verdict]]). A foreground run is refused by
bash-guard C15, a poll loop by C14, a sleep on the task's output file by C16.
