---
name: msys-mangles-a-git-ref-colon-path-into-a-false-verdict
description: "In the MSYS bash here, `git rev-parse \"<ref>:<path>\"` has its colon rewritten to `;` and its slashes to backslashes, so the command FAILS and the empty result reads as a verdict — it reported `.claude/rules/phoenix-crm.md` as DIFFERING from origin/main when the file was byte-identical. Export MSYS_NO_PATHCONV=1 and MSYS2_ARG_CONV_EXCL='*' before any ref:path argument, and treat an empty rev-parse as an error, never as a difference."
metadata:
  node_type: memory
  type: reference
  originSessionId: d4b89084-83c6-40fc-9032-be6b9dfd0d07
  modified: 2026-10-07T16:38:59.728Z
---

Measured 2026-10-07 while running the three-part gate `scripts/new-session.mjs --remove` demands
before a branch is deleted — condition 3, "every file the branch changed is byte-identical on
origin/main", which that script calls the only test that also holds for a roll-up member.

A loop comparing `git rev-parse "<branch>:$f"` against `git rev-parse "origin/main:$f"` reported
`.claude/rules/phoenix-crm.md` as **DIFFER** while the other ten files read **same**. The file was
in fact identical: MSYS had rewritten the argument to
`origin\main;.claude\rules\phoenix-crm.md`, git answered *ambiguous argument*, and `$b` came back
empty — so `[ "$a" = "$b" ]` compared a real blob sha against nothing and printed a difference.
Re-run with `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'`, all eleven files read **same**.

**Why it matters more than the usual path-mangling note:** it erred safe here (a false DIFFER
holds a deletion back), but the failure is symmetric. If both rev-parses are mangled — the normal
case, since both sides take the same shape — both return empty, empty equals empty, and every file
reports **same**. That is a gate on deleting a branch answering "identical" because it could not
read either side. An empty `rev-parse` is a failed command; never let it stand as a comparison.

The same mangling hit `git diff <ref>:<path> <ref>:<path>` in the same session, which at least fails
loudly. The silent form is the loop.

Related: [[verify-the-emitted-artifact-never-the-source]],
[[git-branch-d-is-not-a-safety-gate-after-a-squash-merge]],
[[tz-africa-cairo-silently-returns-utc-in-msys]]
