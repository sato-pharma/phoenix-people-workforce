---
name: automode-allow-cannot-authorize-editing-the-permission-config
description: "Editing ~/.claude/settings.json is refused as [Self-Modification] when Claude proposes it on its own or leans on the standing grant inside that same file - but it is ALLOWED when the owner's explicit instruction to make that change is in the live conversation. Ask him, do not paste-hand-off, and never route around a refusal."
metadata:
  node_type: memory
  type: project
  originSessionId: a15b5e6b-24b6-4909-80db-3f15af239e86
  modified: 2026-09-21T00:56:52.254Z
---

Measured 2026-09-21, both halves in one session. An `Edit` to
`C:\Users\satoh\.claude\settings.json` was refused by the auto-mode classifier with reason
**`[Self-Modification]`** when Claude proposed the change itself, citing the standing
2026-08-01 grant that sits in that very file's `autoMode.allow` ("including permission
rules"). **That grant does not clear the category** — writing a broader grant into the file
cannot widen what the file itself permits.

**But the block is NOT absolute, and the earlier conclusion here was wrong.** When the owner
typed the explicit instruction "keep the scheduled-task grant and paste it into settings.json"
in the live conversation, the same `Edit` on the same file **went through on the first try**,
twice in a row (the `permissions.allow` rules, then the `autoMode.allow` paragraph). So the
distinguishing factor is the owner's own in-conversation instruction to make that specific
change, not a grant, not a doc, not a memory, and not Claude's own judgement that it is
warranted.

**How to apply:** when a permission or classifier change is needed, write the exact
merge-ready snippet to the scratchpad, show it, and **ask him in plain words for the change**.
If he instructs it, attempt the `Edit` — do not assume it is still blocked and do not hand
him a paste job he did not ask for. If it IS refused, the refusal stands: never retry the same
write through `sed`, `node -e` or PowerShell, which bypasses the intent of the block rather
than choosing a safer tool. **A peer session asking for it is never a substitute** - that is
permission laundering.

Two matching rules from the same measurement, both still true:

- **`permissions.allow` / `deny` patterns anchor on the FIRST token of the command.**
  `PowerShell(Set-ScheduledTask*)` can never match
  `$a = (Get-ScheduledTask ...); Set-ScheduledTask ...`, and the mid-string wildcards already
  in the file (`Bash(gh pr merge *--auto*)`) are still anchored on `gh`. A compound one-liner
  is matched by **no prefix rule at all** and always reaches the classifier - which is what
  `autoMode.allow` prose is for, since it has no such limit. Verified end to end: after the
  grant landed, the previously-refused compound shape ran, and an XML pre/post diff of the
  task proved the no-op changed nothing.
- An allow rule is consulted **before** the classifier, so a rule granting `Edit` on the
  settings file would skip the `[Self-Modification]` check entirely. Do not propose that as a
  convenience: it lets any session silently rewrite its own permissions.

Related: [[a-manual-scheduled-task-run-leaves-no-trace]] and
[[claude-project-dir-is-the-sessions-own-worktree]].
