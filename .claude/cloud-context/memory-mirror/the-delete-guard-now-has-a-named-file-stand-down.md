---
name: the-delete-guard-now-has-a-named-file-stand-down
description: "the delete guard finally honours his yes, but only as PHX_DELETE_OK=<filename> — a bare =1 is still denied, and the archive and Hiring Posts have no hatch at all"
metadata:
  node_type: memory
  type: feedback
  originSessionId: ee1a6b46-7eb8-453b-b069-c3cc0cb7d10f
  modified: 2026-10-06T07:14:24.033Z
---

`~/.claude/hooks/scratchpad-guard.mjs` was the one guard on this machine built with **no override**,
and on 2026-10-06 that cost him a real instruction: he typed "delete the duplicate worktree-copy PDF
in _deliverables", the hook refused it, and the rule's own *"do not look for another way to delete
it"* correctly stopped the session routing round it — so his own yes could not reach the machine. He
then ordered the hatch: *"add a stand-down to the delete guard so my own yes can go through."*

**Why:** every other guard here uses `PHX_X_OK=1`, and that shape would have been a blanket off
switch — which is exactly what a session talks itself into, and precisely why he built this one
without any. So the hatch is deliberately **not** that shape.

**How to apply:** once he has named the file in chat, and only then:
`PHX_DELETE_OK=<filename> <the same command>` (`$env:PHX_DELETE_OK='<filename>';` in PowerShell).
The marker must NAME the file — `=1`, `=yes`, `=all`, `=*` and anything under five characters are
still DENIED; the name must appear in the command; and **every** protected file the command names
must match it, so one yes authorises one file in one command. The guard copies each covered file into
`F:\Claude Scratchpad Archive\<ext>\<YYYY-MM-DD>\` first and **denies the delete if that copy fails** —
that one step fails CLOSED against the rest of the file's fail-open rule, because a path outside a
scratchpad and outside a git tree (`_deliverables` was the first) is swept by neither archiver, so
without it the hatch would be the only unbacked delete on the machine. `F:\Claude Scratchpad Archive`
and `F:\Hiring Posts` have **no hatch** — his wording there is absolute.

Two traps the build itself surfaced:

- **The marker is a token ending in `.pdf`, so it counted as one of the files it authorises.** With
  the marker left in the scanned text, a yes that matched no real file read as "every file matches"
  and a marker beside a directory delete sailed through. The guard now strips the marker before
  scanning. Its own selftest caught this — `node ~/.claude/hooks/scratchpad-guard.mjs selftest`,
  29 cases, expect `0 failed`; it spawns the real `pre` hook and reads the decision it emits rather
  than asserting on the source.
- **`archived 0 []` in `F:\Claude Scratchpad Archive\_archive.log` means the file was already gone
  when the hook ran**, not that archiving was skipped — the hook runs before the command, so that
  line plus a `PathNotFound` is proof something else removed it first. It happened on the very first
  real use: the duplicate vanished between two of this session's own reads, with another session live
  in the same checkout. Never read an allowed stand-down as proof your command is what deleted the file.

Related: [[commands-handed-to-the-owner-must-be-powershell]].
