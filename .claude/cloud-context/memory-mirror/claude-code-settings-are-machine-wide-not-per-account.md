---
name: claude-code-settings-are-machine-wide-not-per-account
description: "There is nothing to copy between the two Claude logins — settings live in one per-Windows-profile store both share; only SCHEDULED TASKS and the claude.ai skills tree are account-scoped (and a stale account skill issues RETIRED rules), denial and CI rates are measured EQUAL, and the stale `.claude.json` account is harmless by design."
metadata:
  node_type: memory
  type: project
  originSessionId: 3dfa5eb2-1cfe-4ea8-b767-855d5e601f89
  modified: 2026-10-12T16:55:47.628Z
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
- 🔴 **SCHEDULED TASKS ARE PER ACCOUNT, and only the LOGGED-IN account's tasks ever run** —
  `%APPDATA%\Claude\claude-code-sessions\<accountUuid>\<orgUuid>\scheduled-tasks.json`. Measured
  2026-10-12: every enabled task (daily health check 09:52, the 12 Oct perf re-measure, the two
  15 Oct one-shots) lived on **phoenixx.oag**, and **oagaweesh had none enabled** — so after the
  21:57 switch on 11 Oct the health check and the perf re-measure silently never fired. The
  `SKILL.md` bodies live in the SHARED `~/.claude/scheduled-tasks/<id>/`, so a mirror task on the
  other account is a 6-line prompt that Reads that same file. Mirrors created the same day with an
  `-omar` suffix. **Before switching accounts, mirror the live tasks**; a mirror never double-fires,
  because the signed-out account's copy does not run.
- 🔴 **"This account is broken" is NOT a settings difference — it is measured equal.** 12 Oct, over
  404 desktop sessions / 14 days: auto-mode classifier denials **2.53 vs 2.50 per 1,000 tool calls**,
  tool-error rate 4.2% vs 4.7%, hook blocks 2.23/7.3 vs 2.30/8.2 per 1,000, compactions 1.36 vs 1.48
  per session; CI red-run rate over 21 days 16.2% vs 13.9% (and on the 4 days BOTH accounts ran,
  14.9% vs 16.6%), with the same failing jobs. The accounts work in alternating blocks of days, so
  any "this one is worse" comparison is really a comparison of days and of the work done. Production
  `apply_migration` was refused on phoenixx too (10 Oct, `a-production-delete-is-declined-by-the-classifier`).
- 🔴 **The ONE account-scoped surface is
  `%APPDATA%/Claude/local-agent-mode-sessions/skills-plugin/<orgUuid>/<accountUuid>/skills/`** —
  the claude.ai account skills, which load with the `anthropic-skills:` prefix. Content-hashed
  2026-10-12: **0 files only in phoenixx.oag**, 3 only in oagaweesh (`morning`, `xlsx`).
- 🔴 **The brick mapper is a `user` skill uploaded SEPARATELY to each account, so each has its own
  `skillId` and its own frozen body** — oagaweesh `skill_016GpXrN86DmwnPM562TTCFF` (claude.ai
  `updatedAt` 2026-09-08, body on disk 13 Sep), phoenixx `skill_01UCG1p5LbmtSpBXHswbDXgB`
  (17 Sep). The folder is named after the skill, not the id, so neither appears as
  `sato-brick-area-mapper` in `manifest.json` — **look for the `creatorType: user` row.**
  🔴 **The stale body did not merely lack rules, it ISSUED RETIRED ONES:** oagaweesh's copy was
  56 lines short of the live skill and carried 10 contradicting lines — it told a session to
  release a hold with `sos_map_guard_decide(...)`, a function retired in #5731 (11 Oct, `pg_proc`
  count 0); it kept "the address never sets the area" (superseded by his own 13 Sep ruling); it
  omitted that the 3,742 moves are already applied and must never be re-applied, and that
  Ibn Sina `IS` = `IS-S`; and its conflict counts were 2.8x low (0/134/49 triple-use, different-brick
  and different-area pairs, against the live 4/377/157). Both copies were REFRESHED byte-identical
  to `~/.claude/skills/sato-brick-area-mapper/` on 2026-10-12 (backups `*.pre-refresh-2026-10-12`
  beside each file). **The app only re-downloads a body when claude.ai's `updatedAt` moves**, so
  the refresh holds, but a re-upload or a full plugin re-fetch reverts it — the permanent fix is
  his own claude.ai action (re-upload the current file, or switch the account skill off so only
  the machine copy is reachable). Until then prefer the unprefixed `sato-brick-area-mapper`.
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
diff the two `skills-plugin` trees by content hash. **Then check the two `scheduled-tasks.json`
stores** — that is the difference he actually feels. **Diff an account skill against
`~/.claude/skills/<name>/` by LINE, not by size or mtime** — the question is which rules it still
issues; refresh it in place, keep a `.pre-refresh-<date>` copy beside each file, delete nothing, and
say that only his own claude.ai re-upload makes it permanent. Never answer "this account is denied more"
with a settings hunt: the rates above are equal, and the remaining real differences are only the
usage window (phoenixx weekly limit hit 11 Oct, resets Thu ~13:00 Cairo; oagaweesh resets Monday
00:00) and cosmetic connectors (Context7 on oagaweesh only; Zoom, Hugging Face and two org plugins
on phoenixx only). Related: [[a-worktree-name-cannot-be-inferred-from-its-branch]].
