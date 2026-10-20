---
name: a-supabase-prompt-in-plan-mode-survives-an-allow-rule-and-a-permissionrequest-hook
description: "SOLVED 2026-10-20 - plain plan mode never runs the auto-mode classifier, so his whole autoMode.allow Supabase grant is not consulted and execute_sql prompts; no allow rule or PermissionRequest hook can fix it, but plan ENTERED from auto keeps the classifier and is silent (measured). useAutoModeDuringPlan is the switch, now pinned true."
metadata:
  node_type: memory
  type: project
  originSessionId: 6694369d-5ac5-474a-9f36-aa3c9168a669
  modified: 2026-10-20T03:07:16.904Z
---

Owner asked 2026-10-18 for Supabase to never prompt him in plan mode ("I fully approve"), and again
2026-10-20 ("in plan mode auto approve prompts like these i approve them").

**The answer (2026-10-20).** Plain plan mode **does not run the auto-mode classifier at all**. His
Supabase grant is written in `autoMode.allow` in `~/.claude/settings.json` — the classifier's
allow section — so in plan mode nothing ever reads it and the app falls back to asking for every
non-read-only tool. That is why the dialog appears only in plan mode and never in auto mode, and why
nothing in `permissions.allow` or a hook could ever have silenced it.

**Measured 2026-10-20, this laptop, CLI 2.1.303:** switched a session from auto into plan, then ran
`mcp__supabase-production__execute_sql` against Phoenix HR production (`ozucdzovmcqvepbozvqf`) —
**no prompt**. So plan mode is not categorically the problem.

**The switch is `useAutoModeDuringPlan`** (user setting, label "Use auto mode during plan", default
true). Read out of the binary: `oAe()` applies auto-mode semantics during plan **only when
`prePlanMode` is set** — that is, only when plan was *entered from another mode*. A session that
**starts** in Plan has no previous mode recorded, so `oAe` returns unchanged and you get plain plan
mode. `Dcr() = autoModeAvailable && useAutoModeDuringPlan` gates it as well. Pinned to `true`
explicitly in `~/.claude/settings.json` on his word, 2026-10-20 (it was already the default; the pin
guards against a default flip or a served policy).

**Earlier measurements, all still true and all dead ends (2026-10-18):**
- `mcp__supabase-production` / `mcp__supabase-staging` in the repo's `permissions.allow` — still prompted.
  Adding both to `~/.claude/settings.json` changed nothing.
- No `ask` rule, no managed settings, no hook deciding it.
- A `PermissionRequest` hook (`~/.claude/hooks/supabase-prompt-allow.mjs`) FIRED in plan mode, logged
  `mode=plan | ALLOW`, and the prompt still appeared. `list_projects` never prompted and never reached
  the hook; only `execute_sql` did.

**How to apply:** do NOT rebuild the PermissionRequest hook and do NOT add more allow rules — neither
can work, because the decision never reaches them. Tell him to start the session in Auto and press
Shift+Tab into Plan, rather than picking Plan in the composer before the first message. Supabase work
in a plan-entered-from-auto session is covered by his `autoMode.allow` grant (AGENTS.md §8) and is
silent. The unregistered hook script is left on disk.

**Both sides are now measured (2026-10-20), and they disagree, which is the whole point:**
- *Started* in plan — `claude -p ... --permission-mode plan --permission-prompts none` from a worktree:
  **DENIED.** `permission_denials` named `mcp__supabase-production__execute_sql` outright. With
  `--permission-prompts none` a denial is what would have been a prompt, so that IS his dialog.
- *Switched* into plan from auto — this interactive session: the same `execute_sql` against the same
  production project **returned the row with no prompt**.

So the composer's Plan pick (which starts the session in plan) is the trigger; Shift+Tab into plan is
not. The probe needs his typed word: the classifier refuses a nested `claude -p` as `[Auto-Mode Bypass]`,
and refuses one without `--permission-mode plan` as `[Create Unsafe Agents]`.

See [[automode-allow-cannot-authorize-editing-the-permission-config]] — re-confirmed the same day: his
`autoMode.allow` grant to "manage this machine's own Claude Code configuration" did **not** clear the
`[Self-Modification]` refusal on editing `~/.claude/settings.json`. Only his typed word in chat did.
