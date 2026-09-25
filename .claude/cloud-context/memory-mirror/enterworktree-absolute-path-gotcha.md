---
name: enterworktree-absolute-path-gotcha
description: "EnterWorktree switches the session's logical cwd, but Read/Edit/Write calls using an absolute primary-repo path still hit the primary repo, not the worktree"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ba4bc4c4-86c9-49c8-a3dd-d627cb69b215
---

After calling `EnterWorktree`, Bash calls correctly run inside the new
worktree directory (confirmed via the "Shell cwd was reset to ...worktrees\..."
notices after each Bash call). But `Read`/`Edit`/`Write` take an absolute
path argument that the tool uses literally — if you pass the primary repo's
absolute path (e.g. copied from an earlier Read before EnterWorktree was
called), the edit lands in the shared primary checkout, not the isolated
worktree, silently defeating the whole point of isolating the session.

**Why:** discovered 2026-07-04 while fixing [[dsms-performance-hyphen-stripped-hrid-bug]].
Another Claude session was reported active in the primary directory, so
EnterWorktree was used to isolate the fix. The fix was written correctly in
content but Edit calls kept using the primary path out of habit (paths from
before entering the worktree). Caught only because a live re-test inside the
worktree's own dev server still showed the bug — the worktree file genuinely
hadn't changed. Recovered by diffing the primary (confirmed the diff was 100%
my own edits, nothing pre-existing mixed in), copying the edited files into
the worktree, then `git checkout --` on those exact files in the primary to
restore it to clean HEAD.

**How to apply:** immediately after `EnterWorktree` returns a path, use that
path as the prefix for every subsequent Read/Edit/Write call for the rest of
the task — don't reuse absolute paths gathered earlier in the conversation.
When in doubt, `grep` for a distinctive string from the edit in both the
primary and the worktree copy of the file before trusting a live-preview
result; a dev server started `cd`'d into the worktree only proves the
worktree's *current* file contents work, not that your edits went there.

**Second-order trap when recovering from this:** don't "fix" it by copying
the primary checkout's edited file wholesale into the worktree. The primary
was on `codex/agents-policy-v2`, which had fallen behind `origin/main` (its
own merge-base was several merges back); `EnterWorktree`'s fresh worktree was
correctly branched from the current `origin/main` tip. Copying the whole file
overwrote the worktree's up-to-date version with the older branch's version,
silently reintroducing a type error (`EmployeeDirectoryRow` missing
`displayName`/`nickname`) that had nothing to do with the actual fix. Caught
only because the pre-push typecheck gate failed with an error that hadn't
been there minutes earlier. Correct recovery: diff the intended change as a
patch (or re-apply the same Edit calls again, this time at the worktree
path) rather than copying a whole file across branches — `git checkout
<correct-base-commit> -- <path>` to reset, then reapply edits, so the only
diff versus the worktree's actual base is the intended change.
