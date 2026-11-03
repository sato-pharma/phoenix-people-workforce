---
name: archive-refs-did-not-move-to-the-new-repository-2026-11-03
description: "The 2 Nov move to gawishtheit carried branches and new pull requests only, leaving 1,721 archive refs on the laptop's one disk; on his choice all were pushed to refs/backups on 3 Nov 14:45 Cairo (1,655 refs, 0 left disk-only). 131 tips still are not accounted for on main."
metadata:
  node_type: memory
  type: project
  originSessionId: 4b3a6477-f031-4f09-9f02-03501af86b55
  modified: 2026-11-03T12:45:50.493Z
---

Read 3 Nov 2026 about 14:30 Cairo. `git ls-remote origin` on `gawishtheit/phoenix-people-workforce` lists `refs/heads` and `refs/pull` only, no `refs/backups`. `repo-doctor` reports 1,935 local archive refs, 1,721 with no copy on origin: 1,580 distinct tips, 3,167 commits.

Copies that exist: this laptop's `.git`, and `F:\GitHub-move-backup\2026-10-26\mirrors\phoenix-people-workforce.git` (holds 1,573 of the 1,580 tips, plus the old `refs/pull`). Both are on the one physical disk: [[there-is-only-one-disk-so-no-local-backup-covers-a-disk-failure]]. The old repository answers 404: [[github-account-suspended-2026-11-02]].

Classified by a read-only pass:
- 1,327 tips: held by an old pull request whose number is on `main`.
- 38: every file identical on `main`.
- 74: 90% or more of the added lines on `main`.
- 10: the pull request is named by a commit on `main`.
- 131 left, 178 refs: 40 whose pull request never merged, 39 with no pull request and half or more on `main`, 52 with no pull request and mostly not on `main`.

A low share does not prove lost work, because later commits rewrite the same lines. Most of the 131 are stashes, rescues, break proofs, superseded roll-ups and pre-rebase copies.

**Done 3 Nov 14:45 Cairo, on his multiple-choice pick "Back up all 1,721":** gitleaks read 2,872 commits, no leaks, with every one of the 2,865 commits going up covered. All 1,655 targets are on origin under `refs/backups/*` at the exact commit (66 refs shared a name and a commit with another, so one copy covers each pair). Re-read from `ls-remote`: 1,935 archive refs, 0 still disk-only. No workflow ran for these refs. Script: this session's `scratchpad/archive-push.mjs`.

**Why:** "a merged tip lives on origin as `refs/pull/<n>/head`" stopped being true for every pull request before the move, since the new repository numbers from 1.

**How to apply:** an archive ref made after this read is disk-only again until pushed, and `repo-doctor`'s BRANCH ARCHIVES section counts them. Being on GitHub does not make the 131 merged: treat them as unreleased or replaced work, not as shipped. His word covered this push, so it is no precedent for another; on 2 Nov the classifier refused a session's all-branches push even after his words, and a refusal is never routed around.
