---
name: github-move-to-omar-3-xx-2026-11-04
description: "The move of Phoenix to GitHub account Omar-3-xx, on his word 4 Nov 2026 after gawishtheit was suspended. Repository, secrets and the production connect are done; worker, tablet server and backup connects are his to run. Re-read live state before trusting."
metadata:
  node_type: memory
  type: project
  originSessionId: ebde92b2-65e2-4c59-a969-c5bbf6ee89cb
  modified: 2026-11-04T01:23:41.489Z
---

His words, 4 Nov 2026 about 02:25 Cairo: "migrate new github account Omar-3-xx". This extends the 2 Nov exception in [[github-account-suspended-2026-11-02]] to this one account, by his word only. He signs in himself; a session never does.

Read 4 Nov about 02:30 Cairo: `Omar-3-xx` is a user account created 6 May 2024, 0 public repositories, and earlier repository records list it as a write collaborator. `gh` on this laptop holds only the two suspended logins. Production serves `e12b0d911`, readyz 200.

Prep: branch `codex/omar-3-xx-move`, worktree `F:\Phoenix Workforce\_wt-omar-3-xx-move`, off `e12b0d911`, committed and unpushed. Merging it rebuilds the tablet server once, because the owner-slug test requires `infra/headwind-phoenix-actions/phoenix-entrypoint.sh` to name the current owner.

**Why:** both earlier accounts are refused by GitHub, cause unread, and every deploy route starts on GitHub.

**How to apply:** order after he signs in: create private repo, push `e12b0d911` as `main`, push branches and `refs/backups`, then this branch as a PR. Secret values do not copy from GitHub: re-source them with `copy-secrets.mjs` in session `8f2404f8`'s scratchpad, retargeted. Actions budget starts at $0 ("Usage blocked"), and branch protection on a private repo needs Pro. Railway's app must see the new account before `railway service source connect`, which he runs: a refused connect left production's source empty on 2 Nov. PR 79's content is `836ada923` on `codex/epda-template-2`; `b985b1310d97` is not on the laptop. The other six repositories are in the nightly code backup. The app repositories may be moving to GitLab in the Anti flyers sessions: check before moving them.

State 4 Nov 03:15 Cairo: he signed in, the repository is `Omar-3-xx/phoenix-people-workforce`, PR 1 is the branch above, pushed. His `railway service source connect` for `phoenix-people-workforce --environment production` worked first time at 03:12, although Railway's `githubRepoBranches` still answered "Not Authorized" to this laptop's login: that query is not the test for a linked account, the connect's own answer is.

🔴 That one command also moved the STAGING environment to `Omar-3-xx@main`, the known source-connect behaviour. Staging had been on the dead `staging` branch at `4c848e7a7` (14 Oct) since the 2 Nov connect; `docs/deployment.md` says staging tracks `main`, so `main` is correct and the `staging` branch needs no copy on the new repository.

🔴 **The entrypoint comment "this folder is bare after a redeploy, so do not redeploy phoenix-headwind" is STALE; it sent this session the wrong way on 4 Nov.** `phoenix-headwind` keeps `/files` on the volume `phoenix-headwind-volume` ([[github-account-suspended-2026-11-02]], the 3 Nov 00:55 correction), and the same connect on 3 Nov 00:54 left all six file sizes unchanged. The addresses are only read if the disk is lost. `Omar-3-xx/hmdm-android` does not exist yet, so that fallback answers 404; copies are in `F:\Phoenix Workforce\launcher-backup-2026-11-03`. Fix the comment the next time PR 1 is pushed.

State 4 Nov 03:18 Cairo: he ran the worker, tablet server and backup connects; all read `Omar-3-xx`, trigger `@main`, roots and watch patterns kept. Worker SUCCESS and backup SUCCESS on `e12b0d911`; tablet server SKIPPED by its watch pattern, so it did not restart, four `/files` sizes unchanged. Staging SUCCESS on `e12b0d911`, readyz 200. Merging PR 1 will rebuild the tablet server (entrypoint) and the backup (`backup.sh`); a rebuild does not start a backup.

PR 1 CI read 4 Nov 03:24 Cairo: run 41751766511 PASS on `65c3de720`, `validate` and `checks` SUCCESS, `image` still running. The worker took `crm-live-poll` at 03:21:24, about two minutes after the old holder's lease ran out at 03:19:39, and its next run upserted rows. Merge guard C10 misreads `PR #1` against the old numbering: check the real target before `PHX_MERGE_OK=1`. The stale entrypoint comment was NOT pushed onto PR 1 (a push restarts CI); carry it with PR 79's content.

🔴 Code backup is DOWN: a run at 03:07 Cairo ended CRASHED, `curl: (22) ... 403`, on the suspended account's token. A new token alone will not fix it: `CODE_BACKUP_MIN_REPOS` is 5 and Omar-3-xx holds one repository, and `hmdm-android` (its release files) is not there.

🔴 Re-enable the 19 disabled workflows only AFTER PR 1 merges: `check-railway-deploy-triggers.mjs` refuses any owner but `GITHUB_OWNER`, and `main` still names the old one, so it would alarm falsely.

🔴 `tests/run-tests.ts` ignores every argument, so `--help` starts the whole suite: it took free RAM to 541 MB on 4 Nov until stopped by process id.

PR 79's content reopened 4 Nov about 03:40 Cairo as Omar-3-xx/phoenix-people-workforce PR 7, same commit `836ada923`, on his words "github is back, ship PR 79". The stale entrypoint comment is NOT carried: that path's watch pattern rebuilds the tablet server, which shipping the sales templates has no reason to do. `scripts/rollup-prs.mjs` fails here until PR 1 merges, because it still names the old owner. `main` has no branch protection on this private repo, so nothing but the session stops a merge on red: read `validate` and `checks` on the head SHA first.
