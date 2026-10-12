---
name: a-rev-colon-dot-path-reads-as-absent-on-main
description: "MSYS mangles a git `<rev>:<path>` argument whose path starts with a dot — `origin/main:.claude/rules/employees.md` arrived as `origin\\main;.claude\\rules\\employees.md` and the check reported the file ABSENT on main when origin/main held the IDENTICAL blob. Ask with `git ls-tree <rev> <path>`, which carries no colon; a colon-form answer of absent is never evidence on its own."
metadata:
  node_type: memory
  type: project
  originSessionId: c6c5b9e1-3dc9-4ddb-bddb-2f58c01d2ce3
  modified: 2026-10-12T19:23:20.830Z
---

🔴 **A `git <rev>:<path>` argument is silently rewritten by the MSYS shell here when the path
starts with a dot, and the failure looks exactly like a missing file.**

**Measured 2026-10-12, 22:3x Cairo**, while proving a leftover worktree's commits were already on
`main` before retiring it. The loop asked `git cat-file -e "origin/main:$f"` for each changed file:

- `supabase/migrations/20261012142941_….sql` → resolved, **SAME** blob
- `tests/au-resignation-vacates-day-after-last-working-day.test.ts` → resolved, **SAME**
- `tests/run-tests.ts` → resolved, **DIFFERS** (correct: `main` has registered more tests since)
- `.claude/rules/employees.md` → **"ABSENT ON MAIN"**

The last one was false. The shell converted the colon into a path-list separator and git saw
`origin\main;.claude\rules\employees.md` — it said so verbatim on the next call:
`fatal: Not a valid object name origin\main;.claude\rules\employees.md`. Asked without a colon,
`git ls-tree origin/main .claude/rules/employees.md` and `git ls-tree 5356cc539 …` both returned
blob **`1c6509dbaca728293b45b03a4d03fed24afed59f`** — the same object. Nothing was missing.

**Why it matters more than a typo.** "The file is absent on `main`" is the sentence that stops a
worktree retirement, keeps a branch alive, or argues for re-applying work that already shipped. A
dot-leading path is the common case in this repo precisely where it hurts: `.claude/rules/*`,
`.claude/hooks/*`, `.github/workflows/*`.

**How to apply.** Ask about a path at a revision with a form that has no colon:
`git ls-tree <rev> <path>` for the blob id, `git show <rev> -- <path>` for the content, or
`git grep <pattern> <rev> -- <path>`. If a colon form does answer absent, re-ask with `ls-tree`
before believing it — and read git's own error text, which prints the mangled argument back.

Related: [[verify-the-emitted-artifact-never-the-source]].
