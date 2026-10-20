---
name: the-edit-tool-cannot-match-a-line-holding-arabic-or-an-escape
description: "The Edit tool's old_string will not match a line containing a literal \\uXXXX escape — rewrite those with a node script; the ARABIC half of this was re-measured on 2026-10-20 and Arabic now matches fine"
metadata:
  node_type: memory
  type: reference
  originSessionId: 6347cf50-abe9-435e-a00f-ef98cd30cc95
  modified: 2026-10-20T18:10:10.416Z
---

**The Edit tool cannot match a line that holds a literal `\uXXXX` escape.** Measured 2026-10-09
while making the production planner's alarm emails English (PR 5631): an assertion in
`tests/production-planning-strings.test.ts` written as an escape refused every spelling of
`old_string`, including text copied straight out of the file, while neighbouring ASCII lines in the
same file edited fine.

🔴 **THE ARABIC HALF IS NO LONGER TRUE — re-measured 2026-10-20 (PR 6206, adding Royanoxicam).**
Four `old_string`s holding Arabic matched first time in `src/lib/production-planning/strings.ts` —
the same file this note was written against — including `unitKilogram: "كجم",` and a three-line
span of the Arabic catalogue. So do NOT reach for a node script to edit an Arabic line: try the
Edit tool first, which is what every other rule in this repo already prefers. The escape case was
NOT re-tested on 2026-10-20 and stands until someone measures it.

**Why the escape still bites:** it is resolved on the way in (the same mechanism as the backtick
trap in `docs/agents-session-traps-clusters.md`, "A BACKTICK INSIDE A REGEX LITERAL"), so what is
sent is not what is on disk.

**How to apply:** for an escape, do not retry with another spelling — that is the loop this note
exists to stop. Rewrite the line with a short node script (`readFileSync` → `split("\n")` → index
the line → `writeFileSync`), building any non-ASCII character as `\u{…}` inside the SCRIPT, which
node resolves correctly. Read the file back afterwards: the fix must be verified on disk, never
from the diff you intended. Related: [[running-a-phoenix-test-file-directly-runs-nothing]].
