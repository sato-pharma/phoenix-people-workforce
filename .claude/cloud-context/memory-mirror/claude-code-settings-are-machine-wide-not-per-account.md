---
name: claude-code-settings-are-machine-wide-not-per-account
description: "There is nothing to copy between the two Claude logins — settings live in one per-Windows-profile store both share; only the skills-plugin folder is account-scoped, and the stale `.claude.json` account is harmless by design."
metadata:
  node_type: memory
  type: project
  originSessionId: 3dfa5eb2-1cfe-4ea8-b767-855d5e601f89
  modified: 2026-10-11T21:19:45.904Z
---

Asked on 2026-10-12 to "copy everything in the other account phoenixx.oag@gmail.com setting
to this account", the answer was **nothing to copy**. Proven, not assumed:

- `~/.claude/` and `~/.claude.json` are keyed to the **Windows profile** (`satoh`), not to the
  Anthropic account, and there is only one profile on this machine. So `settings.json`,
  `CLAUDE.md`, `hooks/`, `scripts/`, `skills/`, `agents/`, `plugins/`, the permission
  allow/deny lists and the auto-memory directory are **one shared store** both logins read.
- `node ~/.claude/scripts/account-parity-snapshot.mjs` run under each login on 2026-09-11
  differed in **8 fields and not one of them is a setting** — two timestamps, the four identity
  fields, `growthBookFetchedAt`, `cachedExperimentFeatures` and `extraUsageDisabledReason`
  (the last two are Anthropic-side, not configurable).
- 🔴 **The ONE account-scoped surface is
  `%APPDATA%/Claude/local-agent-mode-sessions/skills-plugin/<orgUuid>/<accountUuid>/skills/`** —
  the claude.ai account skills, which load with the `anthropic-skills:` prefix. Content-hashed
  2026-10-12: **0 files only in phoenixx.oag**, 3 only in oagaweesh (`morning`, `xlsx`).
- 🔴 **Both accounts' copies of `sato-brick-area-mapper` are STALE** — phoenixx 2026-09-17,
  oagaweesh 2026-09-13, against the machine-level `~/.claude/skills/` copy of **2026-10-09**,
  which is newer and larger than both. So invoking `anthropic-skills:sato-brick-area-mapper`
  gives month-old brick rules while the unprefixed `sato-brick-area-mapper` gives the live ones.
  Copying between accounts cannot fix this; only the machine-level copy is current.
- **`~/.claude.json`'s `oauthAccount` lags the live account and that is CORRECT** — it read
  `phoenixx.oag@gmail.com` while the desktop app ran `oagaweesh@gmail.com`.
  `node ~/.claude/scripts/account-check.mjs` resolves the real one from the desktop session and
  printed `PASS — every component will attribute this session correctly`. Never "fix" it, and
  never trust the harness's own `userEmail` line over `account-check.mjs`.

**Why:** the question looks like a migration job and is actually a measurement job; without the
two scripts a session would start copying files between app-managed folders and could clobber a
newer skill with an older one.

**How to apply:** answer any "sync/copy my two accounts" question by running
`account-check.mjs` (who am I really) then `account-parity-snapshot.mjs` (what differs), and
diff the two `skills-plugin` trees by content hash. Related: [[a-worktree-name-cannot-be-inferred-from-its-branch]].
