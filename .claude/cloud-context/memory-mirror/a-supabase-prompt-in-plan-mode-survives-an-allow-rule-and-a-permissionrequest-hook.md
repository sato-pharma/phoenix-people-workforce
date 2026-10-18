---
name: a-supabase-prompt-in-plan-mode-survives-an-allow-rule-and-a-permissionrequest-hook
description: "Plan-mode Supabase prompts on execute_sql cannot be silenced by settings - bare allow rules, the repo's own allow, and a PermissionRequest hook that fired and said allow all failed (2026-10-18); do not rebuild the hook, run Supabase work outside plan mode"
metadata:
  node_type: memory
  type: project
  originSessionId: 6694369d-5ac5-474a-9f36-aa3c9168a669
  modified: 2026-10-18T18:24:43.779Z
---

Owner asked 2026-10-18 for Supabase to never prompt him in plan mode ("I fully approve").

Measured, in order, all in plan mode on production (project Phoenix HR):
- `mcp__supabase-production` and `mcp__supabase-staging` were already in the repo's `permissions.allow`; he still got a prompt on `execute_sql`. Adding both to `~/.claude/settings.json` changed nothing.
- No `ask` rule anywhere, no managed settings, no hook deciding a Supabase prompt.
- A `PermissionRequest` hook (`~/.claude/hooks/supabase-prompt-allow.mjs`, matcher `mcp__supabase-(production|staging)__.*`) FIRED in plan mode and returned `behavior: allow` — the log line read `mode=plan | ALLOW` — and the prompt STILL appeared (he confirmed). `list_projects` did not prompt at all and never reached the hook; only `execute_sql` did.

**Why:** the prompt is not decided by any setting we control; most likely the Supabase server marks the call as needing a human click, or plan mode asks for non-read-only MCP tools regardless of allow rules. Not proven which.

**How to apply:** do not rebuild a PermissionRequest hook or add more allow rules for this - it was removed from `settings.json` the same day. Tell him the prompt is the app's, and run Supabase work outside plan mode, where his auto-mode grant (AGENTS.md section 8) already covers it. The two allow rules stay in the user settings (harmless). The script file is left on disk, unregistered.
