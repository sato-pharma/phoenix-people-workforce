---
name: desktop-slowness-2026-10-08-is-compaction-and-the-window-process
description: "Claude desktop slowness, measured 8 Oct 2026 across every account: auto-compaction (177 in 3 days, 6.4 h frozen, 132 s each) and the app's window process (1.4-1.6 GB, ~120 MB/h growth, only a restart returns it) — NOT the memory folder; the rules layer is ~a fifth of compactions. Re-measure with `slow-audit.mjs --transcripts`; skillOverrides cannot hide synced anthropic-skills:*."
metadata:
  node_type: memory
  type: project
  originSessionId: 5982cce4-6c8e-413e-8057-637b1996c15d
  modified: 2026-10-08T19:39:28.480Z
---

On 2026-10-08 the owner said the Claude Code desktop app was unacceptably slow and suspected the
memory; he runs two accounts on this laptop (sometimes three). Every account shares one `~/.claude`
(transcripts, memory, hooks, settings); only `%APPDATA%\Claude\claude-code-sessions\<account>\` is
per account, and he keeps all three (2026-09-21 ruling) — report it, never prune it.

Ranked by time lost (6-8 Oct, 97 sessions, `node scripts/slow-audit.mjs --transcripts --since 2026-10-06`):
1. Auto-compaction: 177, 6.4 h of frozen sessions, p50 132 s; each one also re-ran every SessionStart
   hook (1,093 compact runs vs 522 startup) — now matched `startup|resume|clear` for the heavy ones.
2. The app's window process (Electron renderer): 1.4-1.6 GB, 80% of a core avg while working, grows
   ~120 MB/h. Only an app restart returns it — his click; the RAM meter now says when (1.5 GB, or
   half a core for 10 min).
3. Turn wait grows with context: p50 4.7 s at 100-150k → 5.3 s at 300-400k.
4. Hooks: relay-capture held every turn end (p50 526 ms) — now async.

The memory folder (1,307 files) costs nothing per turn; the rules layer (~33k tokens/request) is
real but explains about a fifth of compactions. AGENTS.md was condensed 65.4 → 51.4 KB the same day.

**Why:** he will ask again; the answer must be dated numbers, not a guess (see
[[slowness-audits-compare-before-and-after]], [[desktop-slowness-oct-2026-is-thinking-level-and-model-not-memory]]).

**How to apply:**
- Compare any later complaint against this baseline with the same command and a `--since/--until`
  window after the change; the log is `~/.claude/logs/slow-audit-transcripts.jsonl`.
- Do NOT retry `skillOverrides` for `anthropic-skills:*` — synced claude.ai skills ignore it, and
  `syncClaudeAiSkills: false` would drop pptx/xlsx/pdf too. Per-skill off is on claude.ai, his click.
- A permission deny on an MCP server blocks calls but leaves its tools listed; the app's connector
  switch (`set_session_connector_enabled`) removes them.
- The hook dispatcher's guards cost 3-75 ms; its p50 under load is node start-up on a RAM-short box —
  do not rebuild a background mode for it without re-measuring.
- The two levers only he holds: a fresh session per task (≈10 s vs a 132 s compaction) and a daily
  app restart.
