---
name: github-move-to-omar-3-xx-2026-11-04
description: "The move of Phoenix to GitHub account Omar-3-xx, on his word 4 Nov 2026 after gawishtheit was suspended. Prep is committed unpushed; he has not signed in yet. Re-read gh auth status before trusting."
metadata:
  node_type: memory
  type: project
  originSessionId: ebde92b2-65e2-4c59-a969-c5bbf6ee89cb
  modified: 2026-11-04T00:38:15.191Z
---

His words, 4 Nov 2026 about 02:25 Cairo: "migrate new github account Omar-3-xx". This extends the 2 Nov exception in [[github-account-suspended-2026-11-02]] to this one account, by his word only. He signs in himself; a session never does.

Read 4 Nov about 02:30 Cairo: `Omar-3-xx` is a user account created 6 May 2024, 0 public repositories, and earlier repository records list it as a write collaborator. `gh` on this laptop holds only the two suspended logins. Production serves `e12b0d911`, readyz 200.

Prep: branch `codex/omar-3-xx-move`, worktree `F:\Phoenix Workforce\_wt-omar-3-xx-move`, off `e12b0d911`, committed and unpushed. Merging it rebuilds the tablet server once, because the owner-slug test requires `infra/headwind-phoenix-actions/phoenix-entrypoint.sh` to name the current owner.

**Why:** both earlier accounts are refused by GitHub, cause unread, and every deploy route starts on GitHub.

**How to apply:** order after he signs in: create private repo, push `e12b0d911` as `main`, push branches and `refs/backups`, then this branch as a PR. Secret values do not copy from GitHub: re-source them with `copy-secrets.mjs` in session `8f2404f8`'s scratchpad, retargeted. Actions budget starts at $0 ("Usage blocked"), and branch protection on a private repo needs Pro. Railway's app must see the new account before `railway service source connect`, which he runs: a refused connect left production's source empty on 2 Nov. PR 79's content is `836ada923` on `codex/epda-template-2`; `b985b1310d97` is not on the laptop. The other six repositories are in the nightly code backup. The app repositories may be moving to GitLab in the Anti flyers sessions: check before moving them.

🔴 `tests/run-tests.ts` ignores every argument, so `--help` starts the whole suite: it took free RAM to 541 MB on 4 Nov until stopped by process id.
