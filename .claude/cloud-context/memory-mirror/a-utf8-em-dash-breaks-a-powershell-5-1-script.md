---
name: a-utf8-em-dash-breaks-a-powershell-5-1-script
description: "A .ps1 written by the Write tool has no BOM, and Windows PowerShell 5.1 reads it as ANSI — so one em dash inside a double-quoted string is a ParserError, not a mangled character. Keep scripts for this box ASCII-only, or write them with a BOM."
metadata:
  node_type: memory
  type: project
  originSessionId: c6c5b9e1-3dc9-4ddb-bddb-2f58c01d2ce3
  modified: 2026-10-12T21:34:30.670Z
---

🔴 **Write a `.ps1` containing an em dash and this machine's PowerShell refuses to parse it.**

Measured 13 Oct 2026, 00:30 Cairo. A gate-check script written with the Write tool (UTF-8, no BOM)
died on `Unexpected token` at every line holding `"… — …"`. Windows PowerShell **5.1** —
`powershell.exe`, the shell the PowerShell tool uses here — decodes a BOM-less file as the system
ANSI codepage, so `—` arrives as three bytes that break the string, and the error points at the
tokens *after* it, which reads like a syntax mistake in otherwise valid code.

**How to apply.** Any `.ps1`, and any PowerShell here-string written to disk, stays **ASCII-only**:
`-` for an em dash, plain quotes for curly ones. Prose for him keeps its typography; a script does
not. Same trap for `é`, `°`, `→` and box-drawing characters. A `.sh` run through the Bash tool is
unaffected, because MSYS bash reads UTF-8.

Related: [[commands-handed-to-the-owner-must-be-powershell]].
