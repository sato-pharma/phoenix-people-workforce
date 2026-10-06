---
name: the-delete-guard-reads-a-variable-named-rm-as-rm
description: "Any Bash command whose TEXT contains `rm` (or a variable named RM) beside a protected extension or the archive path is refused by the no-delete hook although nothing is deleted — including a `git commit -F -` heredoc whose MESSAGE quotes them. Write scripts and commit messages to a file, then pass the path."
metadata:
  node_type: memory
  type: feedback
  originSessionId: ba3d8b08-f3b8-44a7-9ad5-9f8fbdb56843
  modified: 2026-10-06T07:44:05.561Z
---

On 2026-10-03 a heredoc that wrote a reportlab script (right margin held in `RM`) and rendered to an
`output/*.pdf` path was refused twice by the PreToolUse no-delete guard ("never delete HTML, PDF …"),
although nothing was deleted. The same script written with the Write tool and run as a plain
`python script.py out.pdf` passed.

**Why:** the guard matches `rm` loosely (case-insensitive) anywhere in the command alongside a
protected extension, so a variable, a word or a path fragment reads as the delete command.

🔴 **A COMMIT MESSAGE IS THE SAME TRAP, and it bites exactly when you are describing the guard.** On
2026-10-06 a `git commit -F -` heredoc was refused because its own message quoted two test failures —
`rm 'a/report-1.pdf'` and `F:/Claude Scratchpad Archive/...` — so the hook read a *description* of a
refusal as an attempt at one. The commit touched nothing. Writing the message to a file with the Write
tool and committing with `-F <path>` passed first time, and that is not routing around the guard:
there is no delete anywhere in it. The message is prose, and prose that quotes a shell command has to
stay off the command line.

**How to apply:** never push script bodies OR commit messages through Bash heredocs when they mention
a protected file type, the scratchpad archive or the hiring-posts folder; use Write for the file and
pass its path. Never rename around the guard to overwrite a PDF either — a new version of a PDF goes
to a NEW filename (the guard also refuses overwriting one). The guard's one legitimate hatch is his
own named yes, which is a different thing entirely:
[[the-delete-guard-now-has-a-named-file-stand-down]]. Related:
[[a-dot-path-plus-2-dev-null-certifies-a-check-nobody-ran]].
