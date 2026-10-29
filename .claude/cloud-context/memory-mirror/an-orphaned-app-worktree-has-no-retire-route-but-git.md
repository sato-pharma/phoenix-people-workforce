---
name: an-orphaned-app-worktree-has-no-retire-route-but-git
description: "A .claude/worktrees/<name> folder whose app session no longer exists: new-session.mjs --remove refuses it and the app's discard tool cannot find its session — unlink node_modules with cmd rmdir, then git worktree remove --force"
metadata:
  node_type: memory
  type: project
  originSessionId: 6354201e-9598-46d0-a8a5-f03e48032bbe
  modified: 2026-10-29T19:00:23.269Z
---

On 2026-10-29 the owner asked to retire `.claude/worktrees/nostalgic-khayyam-cecd1c` (an unfinished change from 23 Oct,
lock 156 h old). Neither standard route worked: `node scripts/new-session.mjs --remove` refuses any path under
`.claude/worktrees` ("belongs to another live session"), and the app's `discard_kept_worktree` needs a session id,
but `get_session` answered "not found" for the lock's `sessionId`, and `get_storage_usage` did not list the folder.

**Why:** the app only manages worktrees whose session it still knows about. A folder left behind by a deleted session
is plain git.

**How to apply:** first save the change (`git diff --binary` into `F:\Phoenix Workforce\_retired-worktree-files\<name>-<date>\`,
then `git apply --check -R` against the folder). Byte-compare the ignored local files with the primary's copies (`cmp`
for `.env*` and `.claude/settings.local.json`; compare env key NAMES only, never print values) and move aside any that
differ. Then `cmd //c rmdir "<folder>\node_modules"`: the junction points at the PRIMARY's packages, and
`git status --ignored` lists their files, `.html` included, as if they were inside the folder. Check that the primary's
`node_modules` entry count is unchanged, then run `git worktree remove --force`.

Also: a `cd <worktree>` inside a Bash call is kept between calls, and the harness then treats the session as moved
into that worktree. `cd` back to the primary in the next call.
Related: [[gh-pr-search-by-sha-finds-prs-built-on-it]].
