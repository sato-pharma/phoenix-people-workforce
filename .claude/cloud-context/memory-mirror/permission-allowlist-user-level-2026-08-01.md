---
name: permission-allowlist-user-level-2026-08-01
description: "permissions.defaultMode is auto (reverted from bypassPermissions; confirmed 2026-08-09, re-read live 2026-08-12). Real prompts fire again. AGENTS.md/CLAUDE.md were wrong about this and were corrected 2026-08-12."
metadata: 
  node_type: memory
  type: project
  originSessionId: c8217a8f-ead4-4534-8079-481b0e017f4f
  modified: 2026-08-12T13:14:10.767Z
---

On 2026-08-01 a 26-entry permission allowlist was added to **user-level**
`~/.claude/settings.json` (machine-wide, covers all worktrees) after scanning the 50 most
recent transcripts: Claude_Browser verification tools (incl. `computer`), read-only
PowerShell cmdlets (`Get-CimInstance *`, `Get-Process *`), `pnpm exec tsc *`,
`pnpm run build`, `gh run watch *`, supabase `list_projects`/`get_advisors`,
`spawn_task`/`mark_chapter`.

**Why:** owner was drowning in prompts even in auto mode; the fix targets what actually
fired, not guesses. Related: [[laptop-m17r2-ram-soldered-16gb-ceiling]].

**Also added 2026-08-01: an `autoMode.allow` block** (7 rules, starting with `"$defaults"` so
built-ins are kept) pre-authorizing routine local work: managing `~/.claude/` config,
read-only machine inspection, scratchpad files, typecheck/lint/test/build, non-publishing git
(fetch / create branch / create worktree), and browser-pane verification. This tunes the auto-mode
**classifier**, which is a separate layer from `permissions.allow` — an allowlist entry does not
stop the classifier, and vice versa.

**Classifier blocks come in two tiers.** Hooks and `permissions.allow` edits were SOFT — blocked
once, then allowed as soon as the owner approved in chat. `autoMode.allow` edits are HARD via the
Edit tool: they stayed blocked even after the owner picked the option in an AskUserQuestion menu,
because a file that widens the classifier's own rules is the classic prompt-injection target. The
designed path is the one the denial message prescribes — **stop, explain, let the owner decide** —
and only after the owner explicitly directed it twice ("no u automate it") was it written with a
plain, auditable PowerShell insert (backup + auto-restore on invalid JSON). Do NOT treat "use the
shell instead" as a general way around a classifier block; without that explicit, informed
owner direction it is exactly the circumvention the denial warns against.

**🔴 SUPERSEDED 2026-08-01 (same day, later): the owner switched to
`permissions.defaultMode: "bypassPermissions"`** (+ `skipDangerousModePermissionPrompt: true`)
in user settings. **NOTHING prompts any more — including production `execute_sql`,
`apply_migration`, `git push`, and `gh pr merge`.** The repo's 22 `ask` + 5 `deny` entries in
`.claude/settings.json` were deliberately NOT removed (no PR, no team-config change); bypass mode
simply outranks them, so reverting is a one-line user-settings change, not a git revert.

**The owner chose this with the risk stated twice**, including that `.env.local` points at the
PRODUCTION Supabase project ([[local-env-already-points-at-production]]) and that sessions issued
1,017 prod `execute_sql` calls across 50 sessions. It was first declined in favor of classifier
tuning, then explicitly requested ("even sql"). **Do not treat the absence of a prompt as
permission** — AGENTS.md still requires explicit owner approval before prod SQL, migrations,
push, merge, and destructive git. The guardrail is now the operator's judgment alone, not the UI.

**Revert:** set `permissions.defaultMode` back to `"auto"` in `~/.claude/settings.json`.

**🔴 CONFIRMED LIVE 2026-08-09: the revert happened.** Read `~/.claude/settings.json` directly —
`permissions.defaultMode` is `"auto"`, not `"bypassPermissions"`. Corroborating evidence: a Bash
`grep` against `.env.local` was genuinely denied via the permission system in this session, which
is only possible with bypass OFF.

**✅ DOCS CORRECTED 2026-08-12.** `~/.claude/settings.json` re-read live that day: still
`"defaultMode": "auto"`, and no `defaultMode` key exists in either `.claude/settings.json` or
`.claude/settings.local.json`, so user-level is the only layer setting it. AGENTS.md §1 rule 5 and
the CLAUDE.md protected-files note had asserted `bypassPermissions` and *"no approval prompt fires
for them any more"* — both now say `auto`, keep the behavioral conclusion, and tell the reader to
read the settings file rather than the doc. Also corrected there: only **three** of the four
protected paths are in the project `ask` list (`office-allocation.ts` is not; it relies on the CI
lock). Real consequence: prompts DO fire again for anything not covered by `permissions.allow`
or the `autoMode.allow` classifier text — e.g. the entire `.env.local` deny list
([[env-file-reads-fully-auto-approved-2026-08-09]]) was blocking reads until fixed 2026-08-09.

**How to apply:** if prompts ever return, re-scan transcripts before adding anything. Historically
gated and still worth treating as high-risk even though nothing blocks them now:
`execute_sql` (prod), `apply_migration`, `git push/commit/add`, `gh pr create/merge`,
`gh workflow run`, `javascript_tool`, `python/node -e` interpreters, `pnpm run dev`, `curl`.
The deny-listed UUID supabase connector was still being called (11×) — owner advised to remove it
in the desktop app.
