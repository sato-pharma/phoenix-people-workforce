---
name: supabase-mcp-write-confirmation-is-declined-in-the-desktop-app
description: "The hosted Supabase MCP asks the client to confirm every execute_sql that writes; the desktop app never shows that question, so it comes back \"SQL execution was declined.\" — go straight to scripts/apply-sql-file.mjs"
metadata:
  node_type: memory
  type: project
  originSessionId: 4b3e5d6b-e0fc-4d06-ab8f-5980453d6b5b
  modified: 2026-11-25T19:56:03.733Z
---

On 25 Nov 2026 (Saeed Naeem's move to Cairo West) every production `execute_sql` that WROTE came back
`{"status":"declined","message":"SQL execution was declined."}` four times in a row. One of those came right after
the owner said "Run it again". SELECTs and a DO block that ended in `raise exception` (a dry run, so nothing was
written) ran normally.

**Cause:** the hosted server at `https://mcp.supabase.com/mcp` ("Destructive statements may require the user to
confirm") sends an MCP *elicitation*: a confirmation question that goes to the client, not a permission prompt.
The Code tab of the desktop app does not show elicitation forms, so the question is answered no without the
owner ever seeing it. It is not the permission layer: the tool is on the allow list, and
`~/.claude/hooks/supabase-prompt-allow.mjs` never fired (`~/.claude/logs/supabase-prompt-allow.log` does not
exist). Claude Code documents an `Elicitation` hook that could auto-accept (code.claude.com/docs/en/hooks.md),
but that would silently approve destructive production SQL. It is a safety check for the owner to remove himself,
never a session.

**How to apply:** on the FIRST "SQL execution was declined." for a write, do not retry through the MCP. Write
the SQL to a scratchpad file and run `node scripts/apply-sql-file.mjs <file.sql> production` from the checkout.
It checks the project ref is production before it connects. It is AGENTS.md §8's standing route, so his
pre-authorization covers it. Prove the dry run first with a DO block that ends in `raise exception`; the MCP runs
that because nothing is written. Related: [[a-database-restart-can-be-a-compute-resize]].
