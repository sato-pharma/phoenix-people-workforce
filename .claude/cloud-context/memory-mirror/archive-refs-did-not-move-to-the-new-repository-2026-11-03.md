---
name: archive-refs-did-not-move-to-the-new-repository-2026-11-03
description: "The 2 Nov move to gawishtheit carried branches and new pull requests only, so refs/backups and the other archive refs have no copy on GitHub: 1,721 refs, 3,167 commits; 131 tips are not accounted for on main. Old squash-residue reasoning does not cover them."
metadata:
  node_type: memory
  type: project
  originSessionId: 4b3a6477-f031-4f09-9f02-03501af86b55
  modified: 2026-11-03T12:34:22.595Z
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

**Why:** "a merged tip lives on origin as `refs/pull/<n>/head`" stopped being true for every pull request before the move, since the new repository numbers from 1.

**How to apply:** do not call an archive ref safe because its pull request merged on the old repository; its branch commits exist only here. Pushing them is his word, and on 2 Nov the classifier refused a session's all-branches push even after his words, so he ran it himself; never route around a refusal.
