---
name: github-account-suspended-2026-11-02
description: "On 2026-11-02 GitHub answered 403 \"account suspended\" for it-gawish-hr; the Polyclinic Caps work is unpushed in its worktree. Re-test before trusting this note."
metadata:
  node_type: memory
  type: project
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-02T22:40:03.066Z
---

On 2026-11-02, about 13:40 Cairo, GitHub refused the `it-gawish-hr` account on git and the API: "Your account is
suspended" (HTTP 403). githubstatus.com read "All Systems Operational", so it is the account, not an outage. Production
kept answering, revision `7e610e84c`.

Unpushed at that moment: `6e8f20568` and `9e7a94871` on `codex/polyclinic-cap-admin`, worktree
`F:\Phoenix Workforce\_wt-polyclinic-cap-admin`. The PR, it-gawish-hr/phoenix-people-workforce#6777, holds only
`e792b5fea`, and its CI gave no verdict. Migration `20261102133258` is already applied on staging and production.

Re-tested 2026-11-02 14:59 Cairo: still 403 on git and the API, production still revision `7e610e84c`. Also unpushed:
`beb92ef5b` and `7c65bebca` on `codex/aya-hiring-access`, worktree `F:\Phoenix Workforce\_wt-aya-hiring-access`; origin
holds `2f5f8a40a`. The fallback image and Emergency host routes start on GitHub, and so does the urgent route's launch,
so none can ship a fix while this holds. The owner appeals through the form on GitHub's "Appeal and Reinstatement" page.

What else it reaches, read 2026-11-02 15:01 Cairo:
- A restart of the live version should survive: `/api/readyz` reads the `release_gates` row in our own database, and
  `7e610e84c` has one. Read from the code and the row; a restart was not tested.
- Seven scheduled workflows stop. Only Attendance Weekly Digest writes (06:23 and 13:23 Cairo, settles unanswered days
  to salary), and its own file says a missed run catches up on the next. The other six are read-only detectors, so
  their silence is not an all-clear.
- The laptop's `origin/main` holds the full history to the live commit (7,654 commits); five local branches carry
  commits origin never received. Production's dispatch token was refused at 14:17 Cairo
  (`synthetic_dispatch_forbidden`, the only such row in 30 days).

**Why:** a suspension is GitHub's decision on the account; only the owner can take it up with GitHub.

**How to apply:** re-test with `git ls-remote origin` first, since this is a point-in-time note. While it holds, never try
another account, token or host, and never re-authenticate on his behalf. Once it clears: push the branch, update the PR
body with the second migration, run `node scripts/remote-check.mjs all` once in the background, then
`node scripts/rollup-prs.mjs`.

**Owner's decision, 2026-11-02 about 15:55 Cairo:** told that a second account can hurt the appeal, he made `gawishtheit`
himself (created 15:52 Cairo; his words: "gawishtheit i made a new account") and asked for Phoenix to run on it. That
replaces "never try another account" for this one account, by his word only. He signs in himself; a session never does.
Moving production's Railway source to it stays a separate word from him. Re-read `gh auth status` before assuming the move.

State at 16:47 Cairo: `gh` on this laptop is `gawishtheit`; `origin` still names the old account. Private
`gawishtheit/phoenix-people-workforce` holds `main` at `7e610e84c` only, Actions OFF, 0 secrets. The auto-mode classifier
refused the secret copy (`[Secret-Store Writes]`) and the all-branches push (`[Data Exfiltration]`); both wait on his own
words, never a route around. Owner rename is committed unpushed: `5185fb1cd`, `codex/move-to-gawishtheit`, worktree
`F:\Phoenix Workforce\_wt-move-to-gawishtheit`. GitHub refuses branch protection on this repo until Pro (HTTP 403, read).

State at 17:40 Cairo, superseding the block above: `origin` now names `gawishtheit/phoenix-people-workforce` in the shared
git config. It holds every branch (307 local identical; 78 old-repo, 75 identical and 3 contained in a newer tip), 66 of 86
secrets, Actions still OFF, Pro on. He ran the branch push himself: the classifier refused it for a session even after his
words. His word covered it, so it is not a precedent for another push. `urgent-deploy/production` (`08fbf5165`, 23 Oct) came
across despite the exclusion, cause unknown, and was deleted from the new repo; the commit stays on the laptop. Rename PR:
gawishtheit/phoenix-people-workforce#4, no CI yet. Production still `7e610e84c`, and Railway still watches the OLD repo.

State at 17:55 Cairo: 70 secrets by name, all four token names stored 17:42 to 17:50, values untested. Actions came ON
at about 17:49 by session `a80f6514`, on his words "turn on Actions on gawishtheit and run CI on PR 5" (read false 17:36, true 17:51); every scheduled or production-writing workflow was then disabled
by hand, so only CI, the path-only checks and Dependabot stay active. Re-enable them one at a time only after Railway moves.
`main` is protected (`validate` + `checks`, `strict: false`, `enforce_admins: true`). The classifier refused the release gate
login reset and its secret write (`[Secret-Store Writes]`), so `RELEASE_GATE_DATABASE_URL` and `TELEGRAM_ALERT_CHAT_ID` wait on
his words; the script is `recreate-gate-and-chat.mjs` in session `8f2404f8`'s scratchpad. Until then a merge to this repo's
`main` leaves `release-gate` red. RESOLVED 17:57 Cairo on his words: login reset and tested (reads 499 `release_gates` rows,
42501 on `employees` and on a delete), both secrets stored. The old repository's copy of the gate secret is now dead; if the
appeal succeeds, it needs the same reset.

🔴 Tablet launcher, read 2 Nov about 18:05 Cairo: `it-gawish-hr/hmdm-android` releases answer 404, and `phoenix-headwind` has no
volume, so its `/files` is bare after a redeploy. The live server still serves `hmdm-phoenix-6.40.apk` and `6.39.apk` (6,286,121
bytes each); they exist nowhere else under `F:\Phoenix Workforce`. Keep that service's redeploy held until they are re-uploaded.
Railway's login on this laptop is the existing account `oagaweesh@gmail.com`; a GitHub sign-in as `gawishtheit` looks like a new
account, which is the likely source of his "Sign ups are currently disabled". He reported the same error from the email route too.
Railway's forum ties that message to a pause on new accounts, read 2 Nov. The laptop's CLI session still works, so never run
`railway logout`. Production does not need the dashboard: `fallback-image.yml` runs through the API (`docs/deployment.md`).

🔴 Railway source, read 2 Nov 18:09 to 18:12 Cairo: he ran `railway service source connect --repo gawishtheit/phoenix-people-workforce --branch main --service phoenix-people-workforce --environment production` himself, and it answered "User does not have access to the repo". `--repo` is the right flag. Railway's app has a `railway-app` check suite on the new repo's commits, so the app reaches the repo; the account's linked GitHub identity is the likely gap (`oagaweesh@gmail.com`, linked account unread). Afterwards `railway status` reads production app `source.repo` null, staging still the old repo: the failed connect probably detached production, and the read shows this source was NOT shared with staging. Still serving `7e610e84c`, `/api/readyz` 200. After any reconnect, check the deployment trigger exists too (`.claude/rules/engineering-railway-cli.md`). Re-read before trusting.

🔴 Audit on his word, 2 Nov 18:30 Cairo: the same wall was met in the 27 Oct move from `Gawish-1997` (session `0671649c`, record in `~/.claude/plans/implement-the-full-phased-tidy-shell.md` lines 246-262). Read live now: `me.githubProviderId` = `github-348491567` (`it-gawish-hr`, suspended); `githubRepoBranches` for the new repo answers not found. Order that worked on 27 Oct: (1) Railway's app installed on the new account, (2) `railway api` `serviceInstanceUpdate` repointed each source, (3) `serviceInstanceDeployV2` with a commit deployed all three, SUCCESS, BEFORE the account link moved, (4) railway.com/account, Account Integrations, GitHub, options menu, reconnect as the new account, on "go in chrome and do whats missing", (5) `deploymentTriggerUpdate` kept refusing ("no one in the project has access"), so each trigger was deleted and recreated, on his word. The classifier refused re-running these without his explicit word, and these API calls reach what the denied `source connect` reaches, so they need his explicit word again. Keep `phoenix-headwind` out.

State at 18:22 Cairo: he connected the production WEBSITE service to the new repository himself in Railway's dashboard, and Railway
built `9a965d830` from it (trigger `gawishtheit/...@main`). The worker, `phoenix-headwind` and staging's trigger still name the old
repository; keep `phoenix-headwind` there until the launcher files exist on the new account. PRs 4, 5, 6, 7, 8 are merged. The Fly
route was stopped, and setup failed before it copied anything: flyctl and the Fly API refuse the stored `FLY_API_TOKEN` while the
script's trimmed copy works, so the stored value probably has stray whitespace; re-store it trimmed before Fly is ever needed.

State at 18:24 Cairo, superseding the block above on the worker and staging: the worker and both web triggers (production and staging) read `gawishtheit/...@main`, and the worker is building `9a965d830`. No session call made that change in session `8f2404f8`, which only read it; the actor is unread. Only `phoenix-headwind` still names the old repository, on purpose. Production still `7e610e84c` until main CI's `release-gate` passes on `9a965d830`.

State at 18:28 Cairo, on his words "re-enable the disabled workflows on gawishtheit/phoenix-people-workforce one at a time": 14 re-enabled and read back active. `deploy-drift-check` (404627959) is still off on purpose, to be enabled once `9a965d830` is live, because at its next :09 or :39 run it would alarm on a build still in progress. Railway's triggers read `checkSuites: false` (read 18:27), so on this repo only the release gate holds a deploy; a red scheduled suite does not. Enabled but cannot work yet: `apps-script-push` (six secrets missing) and `synthetic-journeys` (admin login secrets missing, Railway's dispatch token still the old one).

State at 00:39 Cairo, 3 Nov, superseding the deploy state above: production serves `0d4d1d88e` (healthz, readyz 200), website and worker SUCCESS from the new repository, deployed 22:24 Cairo, one commit past `9a965d830`. Only `phoenix-headwind` still names the old repository. `deploy-drift-check` is now active, so all 15 workflows are back on. A background wait script's "NOT LIVE, production still 7e610e84c" at 00:38 was false: it only prints the last revision it read, and its log shows no read between 18:22 and 00:38, so the laptop probably slept. Read healthz, never that line.

Railway moved, read 3 Nov 00:40 Cairo: he relinked his Railway login to `gawishtheit` (`githubProviderId` github-351526050) and ran `railway service source connect` himself for the app and the worker. Production app, staging app and worker read `gawishtheit`; each started the deploy itself and made a trigger on the new repo. Production serves `0d4d1d88e`, readyz 200. `phoenix-headwind` stays on the old repo on purpose. The source IS shared by a service's environments: staging moved with production. The refused connect left only production's source empty until the retry.

🔴 Parallel sessions write this one folder: a `Write` to a slug another session just made replaced its note with no
refusal (2 Nov, 15:03 Cairo; restored from that session's transcript). Check the folder for the slug before writing.
