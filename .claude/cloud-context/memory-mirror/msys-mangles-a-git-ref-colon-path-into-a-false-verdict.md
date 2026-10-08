---
name: msys-mangles-a-git-ref-colon-path-into-a-false-verdict
description: "In the MSYS bash here, `git rev-parse <ref>:<path>` has its colon rewritten to `;` and its slashes to backslashes - but ONLY when the ref contains a slash AND the path starts with a dot (`origin/main:.claude/...` mangles; `HEAD:.claude/...` and `origin/main:scripts/...` do not; re-measured 2026-10-08) - so the command FAILS and the empty result reads as a verdict: it reported `.claude/rules/phoenix-crm.md` as DIFFERING from origin/main when the file was byte-identical. Export `MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL=*` before any ref:path argument, and treat an empty rev-parse as an error, never as a difference. Node's execFileSync is NOT affected, so this is a Bash-tool trap only. Mechanism: [[git-ref-colon-path-is-mangled-by-msys-returns-empty]]."
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

## The trigger is a CONJUNCTION, and three sibling notes each state only half of it

Measured 2026-10-08, same shell, no guards exported, `git cat-file -e "<spec>"`:

| spec | ref holds `/` | path starts `.` | result |
| --- | --- | --- | --- |
| `origin/main:.claude/rules/engineering.md` | yes | yes | MANGLED |
| `origin/main:.gitignore` | yes | yes | MANGLED |
| `refs/heads/main:.claude/rules/engineering.md` | yes | yes | MANGLED |
| `origin/main:.claude` | yes | yes | MANGLED |
| `origin/main:scripts/module-memory/assignments.json` | yes | no | resolved |
| `origin/main:mobile/.gitignore` | yes | no | resolved |
| `7702c9f35:.claude/rules/engineering.md` | no | yes | resolved |
| `HEAD:.claude/rules/engineering.md` | no | yes | resolved |

**It fires only when BOTH hold: the ref contains a slash AND the path's first character is a dot.**
Each condition alone is necessary and not sufficient, which is why this trap keeps being re-derived
wrong — the whole argument has to look like a POSIX `PATH` list (`a/b:.c/d`) before the conversion
layer rewrites it, so if either side stops looking path-like, nothing happens.

Both half-rules are already written down here, each stated as if it were the whole trigger:

- [[git-ref-colon-path-is-mangled-by-msys-returns-empty]] says the trigger is the path's first
  character being a dot. `HEAD:.claude/...` and `7702c9f35:.claude/...` both resolve, so that is
  half. Its own mechanism sentence — "because `a/b:c/d` looks like a `PATH`-style list" — already
  implies the conjunction; only the stated rule is too narrow.
- A sibling note stated the trigger as a slash before the colon; `origin/main:scripts/...` and
  `origin/main:mobile/.gitignore` both resolve, so that was the other half, and the session that
  wrote it RETIRED it on 2026-10-08 once this table was measured. Do not re-file either half-rule as
  its own note.

**How to apply.** Do not reason about which half applies — `MSYS_NO_PATHCONV=1
MSYS2_ARG_CONV_EXCL='*'` before any `<ref>:<path>`, every time, and treat an empty or failed read as
an ERROR rather than as an answer. And prefer a form that cannot mangle at all where one exists:
`git diff --name-only <refA> <refB> -- <paths>`, `git ls-tree -r --name-only <ref>`, `git grep <pat>
<ref> -- <paths>`, or `execFileSync` from node, which bypasses the shell entirely.

🔴 **A second failure wears the same shape and is NOT this one:** `git hash-object --stdin` on EMPTY
input returns the empty-blob sha `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, not an empty string. So
a loop that tests `[ -z "$hash" ]` to mean "absent on main" never fires, and a genuinely ABSENT file
is reported as DIFFERING instead. Measured 2026-10-08 on
`src/lib/phoenix-crm/server/fraud-scan-summary.ts`, which is absent from `origin/main` and which my
own probe labelled DIFFERS. Test absence with `git cat-file -e "<ref>:<path>"` and read its exit
status, never by inspecting a piped hash.

Related: [[verify-the-emitted-artifact-never-the-source]],
[[git-branch-d-is-not-a-safety-gate-after-a-squash-merge]],
[[tz-africa-cairo-silently-returns-utc-in-msys]]
