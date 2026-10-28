---
name: supabase-secret-key-refuses-a-browser-user-agent
description: "Supabase answers 401 \"Invalid API key\" to the sb_secret key when the User-Agent looks like a browser — Windows PowerShell 5.1's default does, so every laptop Telegram alarm was mute ~8–27 Oct 2026."
metadata:
  node_type: memory
  type: project
  originSessionId: 248a0d3b-5380-45c8-a24c-f454bc3807ab
  modified: 2026-10-27T16:13:35.195Z
---

Supabase refuses the new `sb_secret_…` key (stored as `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`) whenever the
request's User-Agent looks like a browser. Windows PowerShell 5.1 `Invoke-RestMethod`/`Invoke-WebRequest` send
`Mozilla/5.0 (Windows NT…) WindowsPowerShell/5.1` by default → **401 "Invalid API key"**, while node `fetch`
with the identical key gets 200. Proven 27 Oct 2026: same key, `-UserAgent 'phoenix-watch/1.0'` → 200, default → 401.

**Why:** the laptop alarms (`~/.claude/scripts/worktree-snapshot-watch.ps1`, shared by the slowness-sentinel and
claude-scripts-backup wrappers, plus `xlsx-snapshot-watch.ps1` and `config-review-watch.ps1`) resolve the owner's
Telegram chat through Supabase REST. Every lookup logged `could not resolve the chat: (401) Unauthorized` from about
8 Oct; the slowness alarm never once sent. Fixed 27 Oct by passing `-UserAgent $SUPABASE_UA` on the Supabase GETs
(backups `~/.claude/backups/hook-backups/*.pre-useragent-2026-10-27`).

**How to apply:** any PowerShell call to Supabase with the secret key MUST pass a non-browser `-UserAgent`. A 401
from PowerShell while node works with the same key is this, not a rotated key. Related: [[every-automated-email-also-mirrors-to-the-admin-telegram]].
