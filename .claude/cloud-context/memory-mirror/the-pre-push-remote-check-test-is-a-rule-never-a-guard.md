---
name: the-pre-push-remote-check-test-is-a-rule-never-a-guard
description: "Owner 2026-10-04 — `node scripts/remote-check.mjs test` before every PR push is a RULE, not a hook; he ruled \"no guard\", so never build or propose a hook that refuses `git push` over the SUITE (the separate typecheck-only guard, PR #5288, is his own request and stands). It is behavioral (PR #5287); if the box does not answer, say so and push."
metadata:
  node_type: memory
  type: feedback
  originSessionId: e39a8848-5059-4305-a1d5-83e9c4ec9c6f
  modified: 2026-10-03T22:44:46.185Z
---

`node scripts/remote-check.mjs test` before every push that opens or updates a PR is a standing step
(`all` when the change adds a route, a file or a closed-union member), shipped in PR #5287 (merge
`4b72d1d71`, live 2026-10-04 01:07 Cairo). Where it is written: `CLAUDE.md` and `AGENTS.md` §7 (the
"no pre-push ritual" lines were edited to carve it out), `.claude/rules/engineering.md` Validation,
the CI and PRs trap cluster, and `docs/testing.md` "Before every push".

**Why:** the friction notes of 2026-09-17..10-03 showed 8 red-CI sessions from a stale or broken test
or guard against 3 from a type error. On 2026-10-04 the owner was offered a hard guard (a hook that
refuses `git push` unless a green run exists for that sha) and answered **"keep the pre-push test as
a rule, no guard."** My reason for recommending a rule over a guard: a guard would also block the scheduled fold and
every session whenever the box is unreachable, and `remote-check` has no way to say "box down" other
than a failure.

**It earned its keep on its first outing.** Later the same night, on `codex/app-password-capture`,
`remote-check all` answered `FAIL — e38895cc7` with **`lint PASS` and `test PASS in 218s`** and two
`TS2322`s: adding `describeAppPasswords` as a required member of `JoinerConsoleDriver` broke the
hand-rolled driver literals in `tests/new-hire-mailbox-adopt.test.ts` and
`tests/new-hire-mailbox-runner.test.ts`. The local suite was GREEN over the same code, which is
[[a-green-test-run-carries-no-type-signal-at-all]] — so the step caught, before the push, exactly
the red CI round it exists to prevent. Note which half fired: the TEST run passed, and the
**typecheck** is what failed, so the separate push guard would have caught this one too.

**How to apply:** run the step yourself and push only on a final `remote-check: PASS — <sha>` line,
read from the output file (the background notification's exit code is not the verdict — see
[[remote-check-background-exit-code-is-not-the-check-verdict]]). Never propose, build or "just
suggest" a push guard for the TEST run, in a `Next step:` line or anywhere else; the ruling stands
until he lifts it in his own words. **Scope, so it is not over-read:** the typecheck-only hook
`.claude/hooks/push-typecheck-guard.mjs` (PR #5288, merged the same night at his own request, "add a
remote typecheck before every push") is a different thing — it refuses a push only on a FAILED
typecheck verdict, allows when the box gives none, and does not run the suite, so `remote-check test`
stays a manual step beside it. If the box does not answer, say so and push; never wait on it.
