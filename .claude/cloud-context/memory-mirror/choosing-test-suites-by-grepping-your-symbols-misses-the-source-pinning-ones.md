---
name: choosing-test-suites-by-grepping-your-symbols-misses-the-source-pinning-ones
description: "Picking which suites to run locally by grepping for the symbols you touched MISSES every test that pins your code by a regex over its SOURCE TEXT — and this repo is full of them, so the subset goes green on a branch the full suite fails"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d901e604-2cf2-44be-a387-c744beef034d
  modified: 2026-10-02T20:11:20.101Z
---

When the full suite is too heavy for this laptop, the obvious way to choose a subset is to grep the
tests for the symbols you changed and run those. **That selection is blind to a whole class of test
this repo relies on heavily: the one that asserts over the SOURCE TEXT of a file, by regex, never
naming your symbol at all.** The subset then passes on a branch the full suite fails, and the green
is more misleading than no run would have been, because it was earned honestly.

Measured 2026-10-02 on PR #5169 (Phoenix CRM approval notices). 21 suites chosen by grepping for
every symbol the change touched: **all green**. `node scripts/remote-check.mjs test`, the full suite
off-laptop, failed **twice** on that branch, on two tests the grep could never have found:

- **`tests/phoenix-crm-missed-records.test.ts`** pinned a notice's idempotency key as the literal
  string `` `${phoenixCrmVisitNoticeKeyPrefix(notice.visitId)}raised` ``. The change moved that key's
  spelling into a ternary while keeping the VALUE identical. The test names no symbol from the diff —
  it reads `notifications.ts` as text.
- **`tests/agents-long-hooks-cite-docs.test.ts`** reads every `.claude/rules/*.md` by DIRECTORY and
  fails any rule line over 1,200 bytes with no `docs/` pointer. It names no file, no symbol and no
  module; two new rule lines (1,243 and 1,376 bytes) tripped it.

**So: a local subset is for fast iteration, never for a verdict.** Before pushing, run
`node scripts/remote-check.mjs test` — it ships the committed sha to the preview box, costs this
laptop nothing, and took 154s and 230s on that branch. The symbol-grep subset is still worth running
first, because it answers in seconds; it just cannot be the last thing you run.

Two companions, both of which bit in the same session:

- The backgrounded task's completion notification reports the **wrapper's** exit status, not the
  check's — it said `exit code 0` while the output file ended `remote-check: FAIL`. Read the file's
  own final `remote-check: PASS/FAIL —  <sha>` line. A peer session hit this the same day and owns
  that claim: [[remote-check-background-exit-code-is-not-the-check-verdict]]. Its twin is
  [[a-background-poller-dies-with-the-worktree-it-runs-in]] — so grep the verdict line rather than
  trusting any waiting loop's own exit.
- An `until grep -q` waiter needs a pattern that cannot match the output file's own **header**:
  `^remote-check: ` matches the banner `remote-check: test on phx@…` printed at startup, so the wait
  returned instantly with 0 PASS lines and looked like an empty run. Match the verdict shape
  (`^--- test (PASS|FAIL)`), not the tool's name.

Related: [[source-pinning-tests-slice-a-fixed-byte-window]] is the same class of test seen from the
other side — there, a growing function false-FAILS a fixed-byte slice; here, a changed spelling fails
a literal that was never about spelling. Both are the cost of pinning behaviour through source text,
and both are worth the cost: these two caught real things.
