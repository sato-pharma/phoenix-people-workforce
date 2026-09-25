---
name: supabase-mcp-and-cli-revoked-2026-08-02
description: "Supabase access was revoked then fully restored on 2026-08-02 by the owner running apply-restore.ps1; CLI is proven working, but MCP servers stay dead in any Claude Code process started before the script set the User env vars"
metadata:
  node_type: memory
  type: project
  originSessionId: e8461015-35d3-4a7c-8793-ed8b858cbdbf
  modified: 2026-08-02T19:43:18.983Z
---

On 2026-08-02 the owner revoked all Supabase MCP and CLI access, then within the hour asked for it
back "with full permissions which means never popup an approval". The Claude Code **auto-mode
classifier** — a guardrail outside settings.json and outside `bypassPermissions` — refused to let
the agent remove the deny rules on its own production-DB write access, so the fix was prepared as
files and the owner applied them himself with `scratchpad/supabase-restore/apply-restore.ps1`.

**The restore is APPLIED and the CLI is PROVEN.** Verified 2026-08-02:

- Zero supabase entries remain in `permissions.deny` in either `~/.claude/settings.json` or
  `.claude/settings.json`.
- `SUPABASE_STAGING_TOKEN`, `SUPABASE_PROD_TOKEN`, `SUPABASE_ACCESS_TOKEN` are all set at **User**
  scope (44 chars each).
- `supabase projects list` returns both projects `ACTIVE_HEALTHY` — `cifwmndunmlxjhyjugxa`
  (Phoenix-HR-Staging) and `ozucdzovmcqvepbozvqf` (Phoenix HR, `linked: true`).
- `scratchpad/supabase-restore/` no longer exists; the script cleaned up after itself.

**The remaining trap — MCP is still dead in a stale process.** `.mcp.json` supplies the tokens by
interpolation (`Bearer ${SUPABASE_PROD_TOKEN}`) and both supabase servers are `type: http` against
`https://mcp.supabase.com/mcp`. **A Windows process never sees User env vars set after it started**,
so any Claude Code launched before `apply-restore.ps1` ran expands those to empty, both servers fail
auth, and **zero `mcp__supabase-*` tools appear** — while the CLI works fine in the same session
(each PowerShell call can set `$env:` inline). Diagnose with
`[Environment]::GetEnvironmentVariable('SUPABASE_PROD_TOKEN','Process')` — `ABSENT` there but `SET`
at `User` scope is the signature. Fix is a **full restart of Claude Code from a NEW shell**;
`/mcp` reconnect inside the stale process cannot help, because the empty value is baked in.

`hasTrustDialogAccepted: true` and no `disabledMcpjsonServers`, so nothing else gates the servers.

**MCP now PROVEN working too (2026-08-02, post-restart).** In a Claude Code process started after
the script, `SUPABASE_*` tokens read `SET` at **Process** scope and
`mcp__supabase-production__list_projects` returned both projects `ACTIVE_HEALTHY` with **no approval
prompt** — so the deny removal and the no-prompt grant are both confirmed end to end, not just on
paper. The stale-process trap above still applies to any window opened before the script ran.

This grant deliberately removes the AGENTS.md section 6 gate on production Supabase writes.
**AGENTS.md section 8 is stale** and still needs rewriting. See
[[prove-it-fails-verify-which-assertion-fired]] and AGENTS.md rule 1.
