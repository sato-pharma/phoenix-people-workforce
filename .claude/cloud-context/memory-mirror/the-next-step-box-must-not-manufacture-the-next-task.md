---
name: the-next-step-box-must-not-manufacture-the-next-task
description: "The Next step box is for what genuinely needs the owner - never a task Claude invented, because he sends whatever is in the box and it costs him a whole session"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 58f3e480-4d78-4e33-bc7c-c27f8b77f55d
  modified: 2026-10-02T09:30:29.057Z
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

**AND A THIRD TIME, 2026-10-02 — THE CONDITION LIVES IN THE PROSE AND THE BOX KEEPS ONLY THE QUOTE.**
The remove-a-visit feature had just shipped and nothing was outstanding, so Claude wrote: *"If you ever
remove one of your entries by mistake, send “put back the visit I removed by mistake”."* He sent it. The
quoted words name a real capability and read as a real instruction — but **its target did not exist**:
`phoenix_crm_removed_visits` held 0 rows, no visit had ever been entered by the Super Admin
(`capture_source = 'admin'` count 0), and the one function that can delete a visit writes its copy
first, so an empty log IS proof nothing was removed. The whole turn went on proving a negative.

**So the third clause is: the quoted words must name something that EXISTS RIGHT NOW, not something
that would be true if a condition were met.** The box is not a conditional channel — the ghost text
keeps the quote and drops every "if", "once", "when" and "should you" around it, so a hypothetical
arrives as an order. The test is mechanical and cheap: **before quoting, name the row, PR, file or
worktree the words act on and confirm it is there.** Could not point at one? It is not a next step.
A capability that has never been used yet is the classic case — a feature shipping is not an event
that needs a follow-up message, and "here is how you would use it some day" belongs in the PROSE.

🔴 **EXISTING IS NOT ENOUGH — THE ACTION MUST BE DUE, AND THE SAME SHAPE BIT AGAIN THE SAME DAY.**
With a merge still mid-CI, Claude wrote *"the next real action is “retire _wt-crm-clear-approved-notice
and delete its branch” once I confirm it shipped"*. The worktree genuinely existed, so clause 3 as
written passed — and he sent it while the PR was still OPEN with 1 commit not on main, where retiring
would have orphaned the pull request. **The qualifier was again in the prose and again stripped.**
So the test has two halves: the target exists, AND its precondition is already met — the PR merged,
the deploy confirmed, the question answered. **If the honest sentence needs "once", "after" or "when",
it does not go in the box at all.** While something is genuinely in flight, the box names what is
waiting on HIM today, and when the answer is "nothing until this lands", say exactly that in the
prose and quote the in-flight thing's own approval instead.

**And when he does send one early, never make him send it twice.** His instruction stands — carry it
out automatically the moment the precondition lands, and say so. Re-asking for a word he has already
given is the loop this whole file exists to stop.

🔴 **THIRD HALF OF THE SAME TEST: IT MUST NOT ALREADY BE DONE.** Minutes later Claude quoted *"turn on
Phoenix CRM for the Delta 1 reps"*, having never read the switch. It had been ON since 2026-09-18 —
all three lines open, and the module's own gate answering OPEN for all four Delta (1) reps and their
DM. The whole turn went on discovering there was nothing to do. So the check before quoting is three
questions, not one: **does the target exist, is the action due, and has it already happened?** All
three are one cheap read away, and the read is never optional — "it probably still needs doing" is
exactly the guess that costs him the turn.

🔴 **AND A SWITCH IS RARELY THE REAL BLOCKER.** The same read showed 8,234 reference customers loaded
and 0 validated, 0 places, 0 plans, 0 visits — two weeks open, nobody started. Before offering to
turn something on, read whether it is already on and whether anything is flowing through it; the
honest finding ("it is on and unused") is worth far more to him than the action Claude imagined.

**Related, and it cuts the same way:** [[hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces]]
is about not splitting one feature across six PRs. This is the upstream half — do not manufacture the
pieces in the first place.

**Why:** an invented suggestion costs him a real hour of a real evening, and he cannot tell from the
box which items are his work and which are Claude's imagination. **How to apply:** before writing the
box, name what is actually outstanding — a merge, an approval, a retire, a decision — **and point at
the row, PR or folder it acts on.** If nothing is, say what finished and quote the smallest TRUE
remaining action. Never a task that exists only because Claude thought of it, and never one whose
target would only exist later.
