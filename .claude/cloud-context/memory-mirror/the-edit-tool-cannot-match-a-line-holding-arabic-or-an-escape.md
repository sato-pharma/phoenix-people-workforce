---
name: the-edit-tool-cannot-match-a-line-holding-arabic-or-an-escape
description: The Edit tool's old_string will not match a line containing Arabic text or a literal \uXXXX escape — rewrite those lines with a node script instead of retrying the edit
metadata:
  type: reference
---

**The Edit tool cannot match a line that holds Arabic text, and it cannot match one that holds a
literal `\uXXXX` escape.** Measured 2026-10-09 while making the production planner's alarm emails
English (PR 5631): two assertions in `tests/production-planning-strings.test.ts` — one quoting an
Arabic string, one written as an escape — refused every spelling of `old_string`, including text
copied straight out of the file, while neighbouring ASCII lines in the same file edited fine.

**Why:** the escape is resolved on the way in (the same mechanism as the backtick trap in
`docs/agents-session-traps-clusters.md`, "A BACKTICK INSIDE A REGEX LITERAL"), so what is sent is
not what is on disk; the Arabic case fails on the same normalisation path.

**How to apply:** do not retry with another spelling — that is the loop this note exists to stop.
Rewrite the line with a short node script (`readFileSync` → `split("\n")` → index the line →
`writeFileSync`), building any non-ASCII character as `\u{…}` inside the SCRIPT, which node
resolves correctly. Read the file back afterwards: the fix must be verified on disk, never from
the diff you intended. Related: [[running-a-phoenix-test-file-directly-runs-nothing]].
