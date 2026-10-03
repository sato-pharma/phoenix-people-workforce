---
name: the-pre-push-remote-check-test-is-a-rule-never-a-guard
description: "Owner 2026-10-04 — `node scripts/remote-check.mjs test` before every PR push is a RULE, not a hook; he ruled \"no guard\", so never build or propose a hook that refuses `git push`. It is behavioral (PR #5287); if the box does not answer, say so and push."
metadata:
  node_type: memory
  type: feedback
  originSessionId: e39a8848-5059-4305-a1d5-83e9c4ec9c6f
  modified: 2026-10-03T22:11:22.110Z
---

`node scripts/remote-check.mjs test` before every push that opens or updates a PR is a standing step
(`all` when the change adds a route, a file or a closed-union member), shipped in PR #5287 (merge
`4b72d1d71`, live 2026-10-04 01:07 Cairo). Where it is written: `CLAUDE.md` and `AGENTS.md` §7 (the
"no pre-push ritual" lines were edited to carve it out), `.claude/rules/engineering.md` Validation,
the CI and PRs trap cluster, and `docs/testing.md` "Before every push".

**Why:** the friction notes of 2026-09-17..10-03 showed 8 red-CI sessions from a stale or broken test
or guard against 3 from a type error. On 2026-10-04 the owner was offered a hard guard (a hook that
refuses `git push` unless a green run exists for that sha) and answered **"keep the pre-push test as
a rule, no guard."** My reason for recommending it: a guard would also block the scheduled fold and
every session whenever the box is unreachable, and `remote-check` has no way to say "box down" other
than a failure.

**How to apply:** run the step yourself and push only on a final `remote-check: PASS — <sha>` line,
read from the output file (the background notification's exit code is not the verdict — see
[[remote-check-background-exit-code-is-not-the-check-verdict]]). Never propose, build or "just
suggest" a push guard for it, in a `Next step:` line or anywhere else; the ruling stands until he
lifts it in his own words. If the box does not answer, say so and push; never wait on it.
