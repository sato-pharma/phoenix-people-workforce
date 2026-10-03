---
name: a-pr-check-grades-the-merge-so-it-can-fail-on-a-commit-you-never-wrote
description: "A PR's CI runs on the branch MERGED WITH main, so a ratio or budget test can go red on another session's commit while every local run passes — reconstruct the merge and measure that, before touching your own diff."
metadata:
  node_type: memory
  type: project
  originSessionId: 49c63508-cfb2-4e16-af62-0961f3808359
  modified: 2026-10-03T21:12:13.625Z
---

A `pull_request` check does not grade your branch. GitHub builds `refs/pull/<n>/merge` and grades
**your branch merged with `main`**, so any test whose verdict depends on the WHOLE repository — a
ratio, a byte budget, a count, a uniqueness check — can fail on a commit that is not in your branch
and never will be in your diff.

**Measured 2026-10-03, PR #5264.** `validate` failed with
`24 of 235 hooks exceed 1200 bytes; the threshold is supposed to catch the exception, not the norm`
(`tests/agents-long-hooks-cite-docs.test.ts`, which requires long hooks to be under 10% of all
hooks). The same test run in the worktree printed **23 of 235 — PASS**, by a margin of half a byte.
Nothing was flaky and nothing was stale: `main` had moved to `020b7a584` (#5263, another session),
whose edit to `.claude/rules/phoenix-crm.md` grew an existing bullet to 1,929 bytes. That is why the
TOTAL did not move — it was an edited line, not a new one — which is exactly the shape that makes
this look like a phantom.

**What to do instead of guessing.** Reconstruct the merge and measure *that*:

```bash
git fetch origin main
git diff --name-only origin/main...HEAD -- <the files the test reads>   # what YOU changed
git diff --stat $(git merge-base origin/main HEAD)..origin/main -- <same>  # what MAIN changed
```

Then copy `origin/main`'s version of every file the test reads, overwrite only the ones your branch
changes, and run the test's own arithmetic over that tree. It reproduced `24 of 235 FAIL` exactly,
which is what proved the extra hook was not mine — and after the fix the same measurement read
`20 of 241 PASS`. **A fix to a ratio is only verified if you measured the ratio on the merged tree
both before and after**; a local green proves nothing here, and this is the same class of error as
`verify-the-emitted-artifact-never-the-source`.

🔴 **`git show origin/main:<path>` is mangled by MSYS on this machine** — the `rev:path` colon
becomes `;` and git reports `ambiguous argument 'origin\main;.claude\rules\crm.md'`. Prefix the
command with `MSYS_NO_PATHCONV=1` (or export it) before any loop that builds such a ref.

🔴 **AND IT BITES `git cat-file -e` AS A SILENT FALSE NEGATIVE, WHICH IS FAR WORSE THAN AN
`ambiguous argument`.** Measured 2026-10-04 right after #5280 merged: a presence check over three
files reported `src/...` and `tests/...` present and `.claude/rules/turbify-provisioning.md`
**MISSING** from `origin/main` — a brand-new file, so it read exactly like a change that failed to
land. It was there, 12,613 bytes. `cat-file -e` communicates only through its exit code, so the
mangled ref returns non-zero and a `&& echo present || echo MISSING` prints MISSING with no error
text to give it away. 🔴 **Use `git ls-tree <rev> <path>`, which has no colon to mangle**, and treat
any per-file presence check written as `rev:path` as unproven. The giveaway here was a second
reading that contradicted it — `git diff --stat <head> origin/main -- <files>` had already shown that
file identical, and a file missing on main cannot be identical to one that exists.

**Do not report this class of failure to the owner as a blocker.** When the red is memory plumbing —
a hook over its margin, a module file near its cap, an orphan note, a stale generated block — it is
the session's to split, rebuild and ship inside the PR already open (`AGENTS.md` §2.2), and the
account of the fix belongs in the PR body, not in his input box. Related: [[a-closed-pr-may-already-have-shipped-via-a-rollup]],
[[a-break-that-passes-may-be-rescued-not-correct]].
