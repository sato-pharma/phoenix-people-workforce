---
name: the-delete-guard-reads-a-variable-named-rm-as-rm
description: "A Bash command carrying script text with a variable named RM plus a .pdf path is refused by the no-delete hook as if it were rm — write scripts with the Write tool, run them with a bare python/node call."
metadata:
  node_type: memory
  type: feedback
  originSessionId: ba3d8b08-f3b8-44a7-9ad5-9f8fbdb56843
  modified: 2026-10-03T11:41:36.140Z
---

On 2026-10-03 a heredoc that wrote a reportlab script (right margin held in `RM`) and rendered to an
`output/*.pdf` path was refused twice by the PreToolUse no-delete guard ("never delete HTML, PDF …"),
although nothing was deleted. The same script written with the Write tool and run as a plain
`python script.py out.pdf` passed.

**Why:** the guard matches `rm` loosely (case-insensitive) anywhere in the command alongside a
protected extension, so a variable, a word or a path fragment reads as the delete command.

**How to apply:** never push script bodies through Bash heredocs when they mention a protected file
type; use Write/Edit for the file and a one-line command to run it. Never rename around the guard to
overwrite a PDF either — a new version of a PDF goes to a NEW filename (the guard also refuses
overwriting one). Related: [[a-dot-path-plus-2-dev-null-certifies-a-check-nobody-ran]].
