---
name: railway-cli-is-linked-to-phoenix-headwind-not-the-app
description: "The Railway CLI link in the primary checkout points at the phoenix-headwind service, not phoenix-people-workforce - so `railway run` injects NO app variables and a script reads them as unset; always pass --service phoenix-people-workforce"
metadata:
  node_type: memory
  type: project
  originSessionId: e94a655d-2c8b-49f4-9c2c-ad15fddfe252
  modified: 2026-09-27T17:48:40.729Z
---

🔴 **`railway run` from `F:\Phoenix Workforce\phoenix-workforce` injects NOTHING from the app.** The
CLI's link there is project `Phoenix-HR-Workforce`, environment `production`, service
**`phoenix-headwind`** — the device-management service, not `phoenix-people-workforce`. Measured
2026-09-27: 119 environment variables reached the child process and the only injected names were the
`RAILWAY_*` built-ins. `CRON_SECRET` and `CRONJOB_API_KEY` both read as absent.

**Why it bites:** the failure is silent and looks like a missing secret rather than a wrong service.
`scripts/cronjob-sync.mjs` answered `CRON_SECRET is not set (environment or .env.local). Nothing
done.` three times in a row, which reads as "the secret was never set" and sends you hunting a
rotation that never happened. AGENTS.md §2.3 says the CLI "is linked to `production`" — true of the
ENVIRONMENT, and silent about the service, which is the half that was wrong.

**How to apply:**
- Always name the service: `railway run --service phoenix-people-workforce -- node scripts/…`.
  A flag changes nothing on disk; re-linking is a config write and is refused.
- Prove injection before believing an "unset" message — run a child that prints variable NAMES only
  (`Object.keys(process.env).filter(…)`) and never values.
- A WORKTREE is not linked at all and answers `No linked project found`: the link lives in
  `~/.railway/config.json` keyed by absolute path, and `new-session.mjs` copies `.env.local` but not
  that. Run from the primary with `--service`, or the owner runs `railway link` in the worktree once.
- Same shape as [[commands-handed-to-the-owner-must-be-powershell]]: the tool answers plausibly for
  the wrong reason, and the wrong reason is the one you act on.
