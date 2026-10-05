---
name: daily-config-review-telegram-alert
description: "A daily 9am Windows task runs the Claude config review and Telegrams the owner on security-relevant drift — it is DELIBERATE, never \"tidy it away\"."
metadata:
  node_type: memory
  type: reference
  originSessionId: 601a004d-26a9-42f2-b949-abd64828b648
  modified: 2026-10-04T22:33:32.055Z
---

Set up 2026-10-05 at the owner's instruction. A read-only review of every file that controls Claude Code on this laptop runs **daily at 09:00 Cairo** and pings his Telegram **only** when security-relevant config drift appears since the previous day's run.

The pieces, all under `~/.claude/` (NOT the repo — no git, no PR):
- **Windows scheduled task** `Claude Config Review - Daily` (runs as `satoh`, conhost `--headless`, StartWhenAvailable). It runs the watcher, not node directly.
- **`~/.claude/scripts/config-review-watch.ps1`** — runs `claude-config-review.mjs --quiet --alert`, resolves the owner's chat live from Supabase the same way `admin-telegram-mirror.ts` does (standing admin email → hr_id → connected `telegram_connections` row; token from `.env.local`), and sends only when drift > 0. Never throws; logs to `config-review-watch.log`. Modes: `-Check` (prove plumbing, no send), `-Test` (one confirmation message).
- **`claude-config-review.mjs --alert`** — diffs the current snapshot against its OWN persisted baseline (`~/.claude/reviews/.alert-baseline.json`, separate from `snapshots/` so an ad-hoc run between daily runs can't erode the delta), reusing the script's `diffSnapshots`; writes `.alert-payload.json`; advances the baseline every alert run.

Owner decisions baked in (2026-10-05): the alert **filters out** two high-churn categories — the desktop app's own scheduled tasks and the memory-index byte count — because they change as normal operation; the full `latest.md` report still shows everything. 8 long-standing low-priority findings were settled into `~/.claude/reviews/accepted.json` that day.

**A session that runs the config review and sees this task is correct — do not remove it, disable it, or "fix" it as an unrecognised job.** It is also why the owner may get a config-drift Telegram the morning after a session changed permissions, hooks, MCP servers, skills or grants. Related laptop watchers that Telegram the owner: the xlsx snapshot and worktree snapshot watchers share the same send pattern.

**Prevention half (also 2026-10-05): `~/.claude/hooks/risky-allow-guard.mjs`** — a user-level PreToolUse(Write|Edit) hook registered in `~/.claude/settings.json`, so it applies in EVERY repo. It DENIES a session's Write/Edit that adds a blanket inline-exec/`npx`/`railway run` allow **wildcard** (`Bash(python -c ' *)`, `Bash(node -e ' *)`, `Bash(npx *)`, etc.) to any `.claude/settings*.json` — same patterns as the review's RISKY table. An exact scoped command is allowed through; only `*` wildcards are refused. Fails open; escape hatch `PHX_RISKY_ALLOW_GUARD_OFF=1`. It can't intercept the owner's own "always allow" UI click (not a tool call) — that's what the daily review catches. **So if a session is denied adding an allow rule, this is why — add an exact command, not a wildcard.** Hooks load at session start, so it arms new sessions only.
