---
name: the-dev-server-runs-in-the-phoenix-dev-lean-codespace
description: "Running the app for a page or role check uses the 2-core Codespace \"phoenix dev lean\" (staging, free quota), not the laptop; ssh needs -i ~/.ssh/codespaces.auto"
metadata:
  node_type: memory
  type: project
  originSessionId: 582c1791-304f-48de-a31d-b6f360f331b9
  modified: 2026-10-29T19:06:06.989Z
---

Since 2026-10-29 (~03:46 Cairo) the owner's GitHub account has ONE Codespace, display name **phoenix dev lean**
(`phoenix-dev-lean-qv6rvjv769pqhx7vj`, repo it-gawish-hr/phoenix-people-workforce, 2 cores / 8 GB, idle stop 30 min).
He approved it ("set up the 2-core Codespace on the free quota") after the laptop's local dev:lean test failed:
/admin never rendered and free RAM fell to 1,696 MB.

Proven in it, 03:49-03:52 Cairo: install 38 s; server ready 0.7 s; /login cold 23.4 s; /admin cold 27.5 s, warm 3 s,
HTTP 200 "Command Center"; server resident 2.7 GB; lowest free 3.9 GB of 7.9; laptop untouched, no paging.

- **Spend:** the account's Codespaces budget is $0 with usage blocked (read on github.com/settings/billing/budgets),
  so it stops at the Pro quota (180 core-hours, so about 90 hours on 2 cores). Stop it after use: `gh codespace stop -c <name>`.
- **ssh trap:** `gh codespace ssh` offers `~/.ssh/id_ed25519`, which is NOT on his GitHub account → "Permission denied
  (publickey)". Always pass `-- -i ~/.ssh/codespaces.auto -o IdentitiesOnly=yes` before the remote command.
- **fetch trap (2026-10-29 ~22:10 Cairo):** the plain ssh shell has no `GITHUB_TOKEN`, so `git fetch` dies with "could
  not read Username". Run git inside `bash -lc "…"` — the login shell loads the token and fetch works.
- **Settings:** `/workspaces/phoenix-people-workforce/.env.local` is the STAGING copy from `_wt-dev-lean-test`
  (outbound keys blank, `PHOENIX_EMAIL_FORCE_TESTING=true`). It persists while the Codespace exists.
  🔴 On 2026-10-29 it ran on PRODUCTION settings for one calendar check (his word, 19:38 Cairo). It was put back
  to staging, and the production copy was deleted on his word at ~21:35 Cairo: no env file in the Codespace names
  `ozucdzovmcqvepbozvqf` now. Before any start, read which ref `.env.local` names (`grep NEXT_PUBLIC_SUPABASE_URL`);
  never bring production settings in without his word.
- **Recipe:** start it → ssh: `setsid nohup node scripts/dev-server.mjs --lean --port 3000 > /tmp/dev.log 2>&1 < /dev/null &`
  → locally `gh codespace ports forward 3000:3100 -c <name>` (backgrounded; 3100 stays out of the restart script's
  3000-3010 hold) → browser pane `http://localhost:3100/api/dev-auth?role=Super%20Admin&next=/admin`.
- **Testing an UNMERGED branch (proven 2026-10-29 ~04:20 Cairo on `codex/tables-said-once-fit`):** never run the
  branch's own tree when it predates lean mode — its old launcher compiled /admin at 95 s, fell to 853 MB free of
  7,941 and stopped (exit 143). Instead, inside the Codespace: `git fetch origin main <branch>` →
  `git checkout -B local/<x>-on-main origin/main` → `git merge --no-edit origin/<branch>` (check first on the laptop
  with `git merge-tree --write-tree origin/main origin/<branch>`, exit 0 = clean) → `pnpm install --frozen-lockfile`
  only if `HEAD:pnpm-lock.yaml` changed → start with `--lean`. That is also what the merge would ship. Never push
  `local/*`. Result: /admin full, the branch's own table widths rendered, sidebar navigation, hot reload ~3 s.
- The `gh` token gained the `codespace` scope the same night (device-code approval by him).

**Why:** the laptop cannot hold a dev server alongside his sessions; this keeps page checks off his RAM at no cost.
**How to apply:** a page look or role sweep goes here, never a local dev server, unless free RAM reads at least
4.5 GB before start. Never create a second Codespace or a bigger machine without his word. Related: [[i-may-stop-a-dev-server-i-started-myself]]
