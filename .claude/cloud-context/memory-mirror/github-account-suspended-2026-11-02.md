---
name: github-account-suspended-2026-11-02
description: "On 2026-11-02 GitHub answered 403 \"account suspended\" for it-gawish-hr; the Polyclinic Caps work is unpushed in its worktree. Re-test before trusting this note."
metadata:
  node_type: memory
  type: project
  originSessionId: c898391b-8a9f-42ea-badf-0e6e8162c8ba
  modified: 2026-11-03T00:41:07.269Z
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
- Seven scheduled workflows stop. Only Attendance Weekly Digest writes (05:23 and 12:23 Cairo in winter, cron 03:23 and 10:23 UTC, settles unanswered days
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

🔴 Correction, read 3 Nov 00:55 Cairo: the 18:05 line above is WRONG. `phoenix-headwind` HAS a volume, `phoenix-headwind-volume`, mounted at `/usr/local/tomcat/work/files` since 22 Oct (`volumeInstances`, 1,242 MB; `df` 429 MB used), and `/files` lives on it. Proof a redeploy keeps it: `WhatsApp.apk`, copied by hand on 23 Oct and never fetched by the server, was still on it after the 27 Oct redeploy. Entrypoint comment "this folder is bare after a redeploy" is stale too. The fleet's launcher is 6.48 on Fly (version row 10045, `phoenix-tablet-apps.fly.dev`), not 6.39 or 6.40. Copies with verified hashes: `F:\Phoenix Workforce\launcher-backup-2026-11-03` (6.39 `eaf0a6f4`, 6.40 `4a5c7bb8`, 6.48 `f7e1304c`). `gawishtheit/hmdm-android` still does not exist: the classifier refused creating it private and uploading (`[Public Data-Sharing Upload]`), and the entrypoint's two addresses answer 404. `railway service source connect` for `phoenix-headwind` was denied at the permission prompt 00:53, so it still names the old repo; never route around it through the API. Moving it ships one change, the entrypoint's addresses and comment, and the image build passed on PR 4.

Smoke tests fixed, 3 Nov 00:51 Cairo on his words: `GITHUB_ACTIONS_DISPATCH_TOKEN` copied to Railway production (website redeployed 00:47, SUCCESS), production's own route dispatched (`dispatched: true`), run 41540517078 green, `synthetic_journey_runs` newest row 14 passed, 0 failed, 1 skipped. Throwaway branch `codex/copy-dispatch-token-once` deleted. The worker keeps the old token until its next deploy; only the website dispatches this run.

Tablet server moved, 3 Nov 00:54 Cairo: he ran `railway service source connect` for `phoenix-headwind` himself in his terminal; the repo's `.claude/settings.json` denies that command to a session (lines 331-332), so it was never going to pass a prompt. Trigger `gawishtheit/...@main`, deployment SUCCESS on `0d4d1d88e`, DOCKERFILE, same disk, all six `/files` sizes unchanged, public upload still 403. Private `gawishtheit/hmdm-android` holds launcher 6.39, 6.40 and 6.48 as releases (`launcher-<v>-r1`), digests match, on his words after the classifier first refused. The entrypoint's addresses still answer 404 anonymously because the repository is private; it only reads them if the disk is lost. The refusal lines above are history: every service in the PHOENIX Railway project now names the new repository. 🔴 NOT every Railway service: see the 3 Nov 01:06 paragraph, the website project still names the old account.

Apps Script secrets restored, 3 Nov 01:01 Cairo on his words: the three script ids from `the-live-sheet-script-ids-and-the-sheet-owner-clasp-login`, and a NEW Google grant from `apps-script-authorize.mjs --clasp-client`, approved by him (client id and secret are clasp's, scopes `script.projects` and `script.deployments` only). Check-only run 41542048612 green: CV Lifecycle, Direct Orders and Marketing Requests all "already current" and their web apps already serve that code. No grant value is on the laptop outside `~/.clasprc.json`'s client pair.

Drift check settings, 3 Nov 01:06 Cairo: set `RAILWAY_PROJECT_IDS` = the `satopharma` project (ftp-portal stays out, offline on his word) and `TOKEN_EXPIRY_WARN_DAYS` = 21 (the code's default). Run 41542649166 success; secrets, required checks, deploy settings and token expiry all OK. Two real findings:
- 🔴 **`satopharma` (web, api, panel) deploys from `it-gawish-hr/Sato-Pharma-Website`, on the suspended account.** It answers 404 to the laptop login, no `gawishtheit` copy exists, none found at the top of `F:\`, `F:\Phoenix Workforce` or the home folder. The site still answers 200; a code change cannot reach it. The trigger leg now pings Telegram daily until that moves.
- **The `gawishtheit` Actions budget was $0, "Usage blocked", read in his Chrome at github.com/settings/billing/budgets, 01:06.** He set it to $100 on that screen himself; read back $0.00 / $100.00, no block. `ACTIONS_MONTHLY_BUDGET` = 100, copied on his words. Plan is GitHub Pro, $18.00 included compute (3,000 minutes). The old account's $300 in `docs/ci-self-hosted-runner.md` line 22 does not apply here. Run 41543023120: `[actions-cost] OK`, $1.89 gross, $0.00 billed, but "no complete day of usage yet, so no projection"; that OK says nothing about the rate until 4 Nov's scheduled run, the first with a full day behind it. `ACTIONS_BILLING_READ_TOKEN` stays unset ON PURPOSE: the dispatch token read the billing usage in that run, so the fallback works and no second token is needed.

What survived the move, read 3 Nov about 01:20 Cairo, when he asked for his 6,800 PRs back: `origin/main` has 7,661 commits back to 28 Apr 2026, and, up to `7e610e84c`, 6,191 merged PR numbers (5,830 squash titles ending `(#n)` plus 362 `Merge pull request #n`; a count of the squash shape alone misses the second kind), lowest #16, highest #6775, 5,815 with a commit body. All 313 local branches have nothing origin lacks, and all 18 worktrees are clean. The old PR PAGES (comments, reviews, CI logs, and any PR-page text the commit body did not keep) exist only on the suspended account and return only through his appeal. Searchable list, on his word: `F:\Phoenix Workforce\PR History\phoenix-pr-history.html`, built from git, local only because titles and bodies carry employee names and company figures. A new repository numbers from 1 and the number cannot be set; never create filler issues or PRs to raise it.

Website code recovered, 3 Nov about 01:25 Cairo, on "find the website's code and move Sato-Pharma-Website to gawishtheit": the old repo is gone and no local copy held the live commit `92fd643e` (the 26 Oct backup `F:\GitHub-move-backup\2026-10-26\mirrors\Sato-Pharma-Website.git` stops at #40 `ac66589`, clones of 27 and 31 Oct were deleted). Railway's deployment list shows exactly four commits since: #41 `4683bc07`, #42 `18f4d06f`, #43 `02baf809`, #44 `92fd643e`. Rebuilt from sessions `64c3eb36` (Anti-flyers) and `9d31dcee` by `scratchpad/rebuild-website.mjs`, every recorded fingerprint matching: new master `37a8c3a4d6be241369ea7014024af9d6c125a1fc`, same content, NEW commit ids (#41 `39cfc3e`, #42 `4744785`, #43 `c432bed`, #44 `37a8c3a`). `railway ssh` into web/api was refused by the classifier ("Production Reads"), so the running container was NOT compared. New repo `gawishtheit/Sato-Pharma-Website`, private as the old one was. Railway source moves through `railway service source connect`, which the repo denies to a session; he runs it. It deploys web, api and panel.
Pushed 01:38 Cairo: `gawishtheit/Sato-Pharma-Website` private, default `master` at `37a8c3a4`, 27 branches, 691 files, GitHub equals local. Railway still reads the old source (web and api SUCCESS on `92fd643e`, panel SKIPPED), all three URLs 200. 🔴 Railway's `githubRepoBranches` answers "GitHub Repo not found" for the new repo: the Railway App on `gawishtheit` (github.com/settings/installations/177881090) cannot see it, and that page asks for sudo, which only he can pass. Run the connects ONLY after that query answers branches: a refused connect left production's source empty on 2 Nov. Folder `F:\GitHub-move-backup\railway-website-link` is linked to satopharma production for the commands (`--service web`, `api`, `panel`, `--branch master`). Reader: `scratchpad/railway-sees-website.mjs`.

Website moved, read 3 Nov 01:42 Cairo: he ran the three `railway service source connect` commands himself. Web, api and panel all source `gawishtheit/Sato-Pharma-Website`, trigger on it at `master`, roots `frontend`, `backend`, `apps/panel` kept. `check-railway-deploy-triggers.mjs` with his login: "OK", all 7 git-sourced instances across 2 projects, exit 0, so the 01:06 line about a daily Telegram ping should now be over (next scheduled run 08:41 Cairo, unread). 🔴 The connects did NOT build anything: all three deployments on `37a8c3a4` ended SKIPPED (panel read BUILDING for a moment first), reason unread. So web and api still serve the `92fd643e` build from the old repository, and the rebuilt repo has never been built on Railway. Addresses all 200 after it. The first real website change is the first proof that the rebuild builds.

Website deployed, 3 Nov 01:45 to 01:48 Cairo, on his words "deploy the website's web and api from gawishtheit/Sato-Pharma-Website" (`scratchpad/deploy-website.mjs`, `serviceInstanceDeployV2` at `37a8c3a4`, api first): api SUCCESS 01:46:45, web SUCCESS 01:47:49, this supersedes the "still serve `92fd643e`" line above for those two. Same character counts before and after: home 161,399, careers 180,840, panel 789; API 14 products, 14 with composition. Both finished inside about a minute, which reads like reused build layers; the build log was not read. Apply pages for Product Manager, HR Section Head and `role=personnel` answer 200 with the form (GET only), Phoenix's Personnel form has 18 fields. Careers lists 8 roles, none Personnel, same page size as before the deploy, so the deploy did not remove it. Panel deployed 3 Nov 01:50 to 01:51 Cairo on his words "deploy the website's panel from gawishtheit/Sato-Pharma-Website": SUCCESS on `37a8c3a4`, 129 build log lines, no cached layer mentioned, so the panel was a real build from the new repository; address 200, 789 characters before and after. Build logs read 01:53: api 50 lines naming its `npm ci` and `npm run build` steps; web only 8 lines, no build step at all, straight to image push, so Railway reused every layer. That points to the rebuilt `frontend/` files matching an earlier build, the nearest thing to a comparison with the running code, but web's compile did not run from the new repository.

Proven 3 Nov 02:27 Cairo: merging `gawishtheit/Sato-Pharma-Website` PR 1 (`a17e7aef`, the careers row's job picture) deployed `web` by itself, SUCCESS, 73 build log lines with the compile, api and panel SKIPPED by their watch patterns. So the trigger works and the rebuilt frontend compiles. The repo's `C10` merge guard reads `PR #1` against the Phoenix repo even with `--repo`; here it named a Dependabot PR, so check the real target before using `PHX_MERGE_OK=1`. That website repo has no CI: its only compile is the deploy.

🔴 Parallel sessions write this one folder: a `Write` to a slug another session just made replaced its note with no
refusal (2 Nov, 15:03 Cairo; restored from that session's transcript). Check the folder for the slug before writing.

🔴 SECOND SUSPENSION, read 4 Nov 02:11 Cairo: `gawishtheit` is now refused too: `gh api`, `git ls-remote` and `gh auth status` answer "Your account is suspended" (403), `github.com/gawishtheit` and its public API answer 404, githubstatus.com reads operational. It still worked at 01:42 Cairo, when PR 79 merged as `b985b1310d97`; onset between 01:42 and 02:11, cause unread. That merge built, but `release_gates` has no row for it (newest is `e12b0d911`), so its container answered readyz 503 and Railway marked website and worker FAILED at about 02:02. Production keeps serving `e12b0d911`, healthz and readyz 200. **`b985b1310d97` is not on the laptop** (`origin/main` here is `e12b0d911`); the same content is `836ada923` on `codex/epda-template-2`, worktree `F:\Phoenix Workforce\_wt-epda-template-2`, whose PR run passed. When it clears: `git ls-remote origin`, then re-run that commit's main CI so `release-gate` writes the row, then redeploy, because the failed deployment does not come back on its own (unproven; read healthz `revision`).
