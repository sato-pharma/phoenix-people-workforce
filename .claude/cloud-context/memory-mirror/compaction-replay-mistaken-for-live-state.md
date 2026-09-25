---
name: compaction-replay-mistaken-for-live-state
description: "After context compaction, a replayed narrative of prior work can look like the current human turn — always re-verify against real git/process state before acting."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bb1d6fc1-71cd-4871-8c49-970bb77512e0
---

After a long session gets compacted, the next turn can arrive containing what
looks like a giant pasted transcript of prior assistant narration (tool-call
summaries, "Created a file", a full plan doc) formatted as if it were the
user's message. It is not a new instruction — it is replayed context. Acting on
it as if it were live (e.g. trusting "is anyone else editing this folder?" was
already answered) is a mistake.

**Why:** in one session this replay included a SoS batch-supersede fix that
turned out to already be committed (`bcf3bce0`), plus an open, never-answered
question about a possible second concurrent session in the same working
directory (not a worktree). Trusting the replay without re-checking real state
would have meant resuming work, or worse committing/pushing, while genuinely
blind to a live second session already active in `F:\Phoenix
Workforce\phoenix-workforce`. Fresh evidence (a brand-new migration file
appearing with a timestamp ~17 seconds before it was checked, while `date`
showed real time had moved forward) was the actual proof a second session was
live — not anything in the replayed narrative.

**How to apply:** whenever a turn opens with a large replayed-looking
narrative (especially spanning a "[Request interrupted by user]" marker) in
this repo:
1. Re-run `git status --short`, `git log -1`, `git worktree list` for ground
   truth — don't trust the narrative's claimed end-state.
2. Check file mtimes against the actual current `date` for anything
   uncommitted; a file modified seconds ago means something is writing to
   this tree *right now*.
3. Check `Get-CimInstance Win32_Process` command lines for `node`/`git`
   processes rooted in this exact folder — a running `next dev` explains
   build-cache `ENOENT` errors without implying a hostile second session, but
   a process you can't explain is a real signal.
4. If a live second session in the *same* (non-worktree) folder is confirmed,
   stop entirely in that tree and move any further work to a fresh
   `git worktree add -b <branch> <path> <known-good-commit>` — see
   [[parallel-session-swarm-hazard]] for what happens when this isn't done.
