---
name: a-worktree-name-cannot-be-inferred-from-its-branch
description: "A `_wt-<task>` folder name does NOT follow from the branch name — `codex/ecr-base` had no `_wt-ecr-base` at all, and quoting the inferred name in the Next step box cost the owner a turn sending a command whose target did not exist; read `git worktree list` before naming a folder, and `git ls-remote` before offering to delete a branch GitHub already removed."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 1661fc0b-9b30-4648-a382-c3adfe5ac45f
  modified: 2026-10-09T22:11:55.078Z
---

A session that merged a PR need not have worked in a worktree named after its branch. On 2026-10-10
the owner was handed `retire _wt-ecr-base and delete codex/ecr-base` after PR 5719 shipped. Neither
existed: `git worktree list` had no `_wt-ecr-base` (that session worked elsewhere), and
`codex/ecr-base` was already gone both locally and on origin, because `delete_branch_on_merge`
removes the remote branch the moment a PR merges. He sent the command and it named nothing.

**Why:** the folder name was inferred from the branch name instead of read. The two coincide often
enough here to look like a rule, and the Next step box demands a named target, which is exactly the
pressure that turns an assumption into quoted words he will send.

**How to apply:** before quoting a retirement, read all three — `git worktree list` for the folder,
`git branch --list <name> -vv` for the local branch, and `git ls-remote --heads origin <ref>` for the
remote one. A merged PR's branch is normally already deleted, so the leftover is usually a **closed**
PR's branch, whose remote survives because nothing merged (here `codex/docker-base-mirror`, PR 5718,
closed as contained in 5719).

For a branch whose PR closed rather than merged, ancestry is the wrong test — a squash means the
commit is not an ancestor of `main`. The test that holds is the one `new-session.mjs --remove`
prints: every file the branch changed is **byte-identical** on `origin/main`. Also archive the ref
(`git update-ref refs/deleted-branches/<name> <sha>`) before `git branch -D`, which archives nothing
on its own — and that archive is local only, never a backup.

Related: [[the-next-step-box-must-not-manufacture-the-next-task]].
