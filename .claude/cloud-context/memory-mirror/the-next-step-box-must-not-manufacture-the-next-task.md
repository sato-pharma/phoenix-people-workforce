---
name: the-next-step-box-must-not-manufacture-the-next-task
description: "The Next step box is for what genuinely needs the owner - never a task Claude invented, because he sends whatever is in the box and it costs him a whole session"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 58f3e480-4d78-4e33-bc7c-c27f8b77f55d
  modified: 2026-09-29T17:21:04.937Z
---

🔴 **THE `Next step:` BOX IS FOR WHAT GENUINELY NEEDS HIM — NEVER A TASK CLAUDE THOUGHT OF. He sends
whatever is in the box, so an invented suggestion becomes a real instruction and the session loops.**
His words, 2026-09-29, ending the session: *"بقالي ساعة حرفيا يعني احط الختم شيل الختم احط الختم شيل
الختم"* — "for literally an hour: put the stamp, remove the stamp, put the stamp, remove the stamp."

**What actually happened, because the mechanism matters more than the apology.** The HR-forms stamp
feature was FINISHED and merged. Claude then filled the box, turn after turn, with stamp work nobody
had asked for: *"print an arabic salary letter with the stamp ticked"*, *"put the stamp on the
english experience certificate too"*, *"put the stamp on the arabic experience certificate"*. He sent
each one — they were pre-written ghost text, one keystroke away — and every one produced a new PR, a
new merge, a new deploy and a new "and while doing that I found…". **The box is an instruction
channel, not a notepad.** Claude was writing the next hour of his evening and calling it a
suggestion.

**The test, in one line: would he have typed this himself if the box were empty?** If the honest
answer is no, it does not go in the box. "Nothing needs you right now" cannot be said (2026-09-18 —
the empty box renders `<no suggestion>`), so the box carries a REAL outstanding item instead: a merge
that is waiting, a worktree to retire, a decision only he can make. When the only true answer is a
small piece of housekeeping, that is the right answer — a small true thing beats a big invented one.

**The specific trap is a feature that has just shipped.** It leaves a long tail of plausible
extensions — put it on this other paper too, try it with the other option, apply it to the next
form — and each one is defensible on its own. That is precisely why it loops: nothing in any single
turn looks wrong. The rule has to bite at the feature level, not the turn level: **when the thing he
asked for works, the feature is DONE**, and extending it to the next surface is his call to make from
a blank box, not Claude's to offer.

**IT HAPPENED AGAIN ONE TURN AFTER THIS FILE WAS WRITTEN, which is why the rule needs a second
clause.** Having just apologised for the loop, Claude closed with *"retire _wt-map-row and delete its
branch"* — a worktree read off a listing without checking whose it was. He sent it. `_wt-map-row`
belonged to a DIFFERENT, LIVE session: its PR **#4793 was OPEN**, a file in it had been written **one
minute earlier**, and its HEAD had moved two commits past what the listing showed while Claude was
reading it. Retiring it would have destroyed a colleague session's in-progress work on an open PR.

**So the second clause is: never put an action in the box for something Claude has not verified is
ITS OWN.** A `_wt-*` folder in `git worktree list` is not evidence of ownership — a live `_wt-*`
session reports the PRIMARY as its cwd, so its absence from any lock or process reading proves
nothing (`repo:doctor` says exactly this). Before naming a worktree in the box: its PR must be
MERGED, the tree must be clean, and its HEAD must be where the listing said it was. All three, or it
is somebody else's.

**Related, and it cuts the same way:** [[hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces]]
is about not splitting one feature across six PRs. This is the upstream half — do not manufacture the
pieces in the first place.

**Why:** an invented suggestion costs him a real hour of a real evening, and he cannot tell from the
box which items are his work and which are Claude's imagination. **How to apply:** before writing the
box, name what is actually outstanding — a merge, an approval, a retire, a decision. If nothing is,
say what finished and quote the smallest TRUE remaining action. Never a task that exists only because
Claude thought of it.
