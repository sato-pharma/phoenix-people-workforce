---
name: another-sessions-rollup-can-close-your-open-pr-as-superseded
description: "Another session's `rollup-prs.mjs --settle` can fold your still-open PR into its roll-up, merge that, and CLOSE yours with \"Superseded: byte-identical on main\" while you are still watching your own checks — and that close is usually CORRECT, so verify by file content before treating it as lost work."
metadata:
  node_type: memory
  type: project
  originSessionId: 6591b3bf-083c-4444-bb06-41a2779e5795
  modified: 2026-10-07T21:42:57.444Z
---

Measured 2026-10-07/08 on #5459 (the private-calendar plan source). Its two required checks went
green at 00:0x Cairo, and by the time this session looked again the PR read **`state: CLOSED`,
`mergedAt: null`, `mergeCommit: null`** — the shape of a PR somebody threw away. The timeline named
the actor and the reason:

```
Gawish-1997  21:34:52Z  commented  "Superseded: every file this PR touches is already on `main`
                                    — byte-identical ... its content landed inside a roll-up."
Gawish-1997  21:34:53Z  closed
```

Another session had run `rollup-prs.mjs --apply`, which built **#5463** over this PR's commits,
merged that, and then `--settle` closed this one. **The work shipped; only the PR number died.**

**How to apply.** `state: CLOSED` with a null merge commit is not evidence of lost work — check the
CONTENT. `git fetch origin main`, then for every file the branch touched compare
`git cat-file -p "<head sha>:<path>"` piped through `git hash-object --stdin` against the same for
`origin/main`. Expect most files byte-identical and the SHARED ones (`tests/run-tests.ts`, a
`.claude/rules/*.md`) to differ — main carries other PRs' lines in them too — so for those grep
`origin/main:<path>` for YOUR OWN delta (the `runTest` registration, the rule's bold span). All
present = shipped; find the carrying commit with `git log origin/main -- <a file only you added>`,
then `verify-shipped.mjs <the roll-up's number>` for the deploy.

🔴 **A path starting with a dot mangles.** `git cat-file -p origin/main:.claude/rules/time-off.md`
answered `fatal: Not a valid object name origin\main;.claude\rules\time-off.md` — MSYS rewrote the
whole argument. Prefix `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'`. This is
[[msys-mangles-a-git-ref-colon-path-into-a-false-verdict]] in its loud form; the quiet form, where
every file falsely reads "same", is the dangerous one here, because it would confirm a settle that
threw real work away.

**Do not re-open, re-push or re-merge** a correctly settled PR: its files are already on main, so a
merge is an empty squash paying a full `main` run. Related: [[verify-the-emitted-artifact-never-the-source]].
