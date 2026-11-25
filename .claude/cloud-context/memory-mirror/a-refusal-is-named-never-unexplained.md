---
name: a-refusal-is-named-never-unexplained
description: "Every blocked or refused action is reported in one line naming WHICH of the five guards stopped it, the exact action, and what happens next - never \"I can't find the cause\". The five guards and today's real examples."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 0b3be0eb-34e5-42ea-bd4e-d19f754b9119
  modified: 2026-11-25T21:29:22.761Z
---

His words, 25 Nov 2026 ~23:30 Cairo: errors and refusals happen and the session says it cannot reach their cause; twice in one day. "I am the system administrator, I should be able to do anything in the system."

A census of 24-25 Nov found five different guards, each of which says who it is in its own message:

1. **Claude Code's own safety check (auto mode)**: "denied by the Claude Code auto mode classifier. Reason: [...]". This is Anthropic's built-in reviewer, not his setup and not a bug. 9 refusals on 24-25 Nov: a `Stop-Process -Force`, a `gh workflow run`, reading production Railway secrets, a scan of transcripts for a PIN, a `gh pr create`, archiving a session. It refuses when the action is risky and HIS OWN latest message did not plainly order that exact action. A session can never switch it off.
2. **Claude Code's built-in delete check**: "denied by a built-in Claude Code safety check". It stops an `rm` whose target it cannot resolve, for example `cd X && rm -f *`. Fix: name the full path.
3. **The desktop app's archive enrichment**: "gave no verdict ... a hook changed this call's input". None of his hooks do this. The app adds a `session` field to `archive_session` after the safety check reviewed it. The retry then gets refused as destructive. Archiving a session through a tool is unreliable, so tell him to archive it from the sidebar.
4. **Supabase**: "SQL execution was declined." is the hosted MCP's unseen confirmation ([[supabase-mcp-write-confirmation-is-declined-in-the-desktop-app]]). "MCP error -32600: You do not have permission" comes from the claude.ai Supabase connector (`mcp__b345e47e-…`), whose account cannot reach Phoenix HR: use `mcp__supabase-production__*` instead.
5. **His own repo guards**: "PreToolUse:Bash hook error: C12 / C20 / C22 ...". These are rules he set, and each message says what to do: C12 commit+push shape, C20 refresh the cloud mirror, C22 the migration ledger check.

**Why:** "I can't find the cause" is never true. The cause is in the refusal text. Saying it leaves him feeling the tool is broken and that he has no control.

**How to apply:** on any refusal, tell him in one line: which guard (1-5), the exact action, and the next move. For 1: retry ONCE only if his own latest message ordered that exact action. Otherwise ask him as a multiple-choice question naming the action, and retry on his yes. If it is refused again, hand him the finished command or SQL and the screen where he runs it. Never route around a refusal by another transport. For 2, 4 and 5, fix it yourself and carry on.
