---
name: the-delete-guard-reads-a-variable-named-rm-as-rm
description: "Since 16 Nov 2026 the no-delete guard judges a shell delete by its OWN statement, so `rm tmp.png` beside a PDF that is only read now passes - but it still refuses with nothing deleted when a delete word and a protected name share ONE statement (a commit-message line quoting `rm 'a/report.pdf'`), when the archive or Hiring Posts folder is named anywhere beside a delete word, or when a script's own delete call (fs.rmSync, unlinkSync, git clean) sits anywhere in a command naming a protected file. Write such scripts and messages to a file, then pass the path."
metadata:
  node_type: memory
  type: feedback
  originSessionId: ba3d8b08-f3b8-44a7-9ad5-9f8fbdb56843
  modified: 2026-11-16T13:15:39.440Z
---

**What the guard does now (since 16 Nov 2026, owner: "fix the gap" / "update the two stale delete-guard
notes too").** `~/.claude/hooks/scratchpad-guard.mjs` used to refuse any command with a delete word ANYWHERE
and a protected name (HTML, PDF, XLSX/XLSM/XLS, DOCX/DOC, SVG) ANYWHERE. It now splits the command into
statements (at `&&`, `||`, `;` and newlines, never inside quotes or brackets; heredoc and here-string bodies
line by line; a pipe is NOT a split) and refuses only when a statement that DELETES names a protected file,
directly or through a variable set elsewhere in the command (`F=a.pdf; rm "$F"`, `for f in *.pdf`,
`... | while read f`). A delete word straight after a quote mark is caught too (`bash -c 'rm a.pdf'`,
`os.system('rm a.pdf')`, `subprocess.run(["rm", "a.pdf"])`). Its selftest pins all of it:
`node ~/.claude/hooks/scratchpad-guard.mjs selftest` ("0 failed").

Measured against the live guard on 16 Nov:

| Command shape | Verdict |
| --- | --- |
| heredoc script with a variable `RM = 40` on its own line, rendering `out.pdf` | passes |
| `python read.py in.pdf && rm -f tmp.png` | passes |
| Python heredoc that writes `report.pdf` and ends with `del d` | passes |
| commit message that mentions a PDF but no delete command | passes |
| `RM` and the `.pdf` path in ONE statement | REFUSED |
| commit-message heredoc with a line `rm 'a/report-1.pdf'` | REFUSED |
| commit message naming `F:/Claude Scratchpad Archive/...` plus the word `rm` anywhere | REFUSED |
| `node -e` that reads `in.pdf` and calls `fs.rmSync('tmp.png')` | REFUSED |

**Why the last three still refuse:** the archive and Hiring Posts are judged by the WHOLE command on purpose
(a `cd` into either makes any delete reach it), and a delete written as program code can carry its target in
a variable no shell reading can follow, so it is judged by the whole command too.

**History.** On 2026-10-03 a heredoc that wrote a reportlab script (right margin held in `RM`) and rendered
to an `output/*.pdf` path was refused twice although nothing was deleted; the same script written with the
Write tool and run as `python script.py out.pdf` passed. That shape passes today. On 2026-10-06 a
`git commit -F -` heredoc was refused because its own message quoted two test failures, `rm 'a/report-1.pdf'`
and `F:/Claude Scratchpad Archive/...`. That shape STILL refuses: the message line is a statement with both
words in it, and the archive path is whole-command. On 16 Nov the old whole-command check had refused five
commands in four days that deleted only images and temp files.

**How to apply:** a script body or commit message that quotes a delete command beside a protected file type,
names the scratchpad archive or the hiring-posts folder, or calls a delete function in code next to a
protected filename goes to a file with the Write tool, and the command passes its path. Never rename around the
guard to overwrite a PDF either; a new version of a PDF goes to a NEW filename. The guard's one legitimate
hatch is his own named yes, which is a different thing entirely and never yours to use for your own tooling:
[[the-delete-guard-now-has-a-named-file-stand-down]]. Related:
[[a-dot-path-plus-2-dev-null-certifies-a-check-nobody-ran]].
