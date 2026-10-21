---
name: railway-cli-is-linked-to-phoenix-headwind-not-the-app
description: "The Railway CLI link in the primary checkout points at ONE service that is never the web app - `phoenix-workforce-worker` since 2026-10-20, `phoenix-headwind` before that - so `railway run` injects no app variables AND every read (`railway status`, `deployment list`, `logs`) silently answers for that service; always pass --service phoenix-people-workforce"
metadata:
  node_type: memory
  type: project
  originSessionId: 6347cf50-abe9-435e-a00f-ef98cd30cc95
  modified: 2026-10-20T19:10:00.000Z
---

🔴 **The CLI link in `F:\Phoenix Workforce\phoenix-workforce` names ONE service, and it has never
been the web app.** Project `Phoenix-HR-Workforce`, environment `production`; the linked **service**
was `phoenix-headwind` on 2026-09-27 and is **`phoenix-workforce-worker`** as of 2026-10-20. It can
change without anyone editing the repo — `~/.railway/config.json` is keyed by absolute path and the
link is rewritten by any `railway link` anywhere in that folder.

🔴 **It is not only `railway run`. EVERY READ COMMAND ANSWERS FOR THE LINKED SERVICE, with no hint
that it is the wrong one.** Measured 2026-10-20 while diagnosing a frozen production: `railway
deployment list` returned `2c0ad915… | SUCCESS | 18:44:15 +03:00` and that row was read as "the web
app's newest deploy". It was the **worker's**. The web service's own newest deployment happened to
carry the same sha and timestamp, so the wrong reading looked right and survived several steps —
`railway service` then refused (`needs a service name` in non-interactive mode), which is the only
reason the mistake surfaced at all.

**`railway run` injects nothing from the app:** 119 variables reached the child and only the
`RAILWAY_*` built-ins were injected; `CRON_SECRET` and `CRONJOB_API_KEY` read as absent, which looks
like a rotation that never happened. `scripts/cronjob-sync.mjs` answered `CRON_SECRET is not set`
three times.

**How to apply:**
- **Name the service on every call** — `railway run --service phoenix-people-workforce -- node …`,
  `railway logs -s phoenix-people-workforce`. A flag changes nothing on disk; re-linking is a config
  write and is refused.
- **To read deployments, do not use `railway deployment list` at all.** Either
  `railway status --json` and pick the `production` environment's `phoenix-people-workforce`
  instance (`serviceId 30356676-116b-4886-ac6e-89041d80185e`, domain `phoenix-hr.satopharma.com`),
  or ask GitHub: `gh api repos/Gawish-1997/phoenix-people-workforce/deployments?per_page=8`.
  `railway status` with no flags prints the linked service under a heading that reads like the whole
  project.
- **Never read a sha agreeing with your expectation as confirmation** — the worker and the web
  service deploy from the same commit at the same second, so their rows are indistinguishable except
  by service name.
- A WORKTREE is not linked at all and answers `No linked project found`; `new-session.mjs` copies
  `.env.local` but not the link. Run from the primary with `--service`.
- Prove injection by printing variable NAMES only, never values.
- Same shape as [[commands-handed-to-the-owner-must-be-powershell]]: the tool answers plausibly for
  the wrong reason, and the wrong reason is the one you act on.
