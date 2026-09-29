---
name: never-put-his-physical-actions-in-the-next-step-box
description: "The Next step box is words he SENDS TO CLAUDE and that CLAUDE CAN ACT ON NOW — never a physical act (press, pick a file, reset a tablet, scan a QR), never a MESSAGE HE SENDS TO A PERSON, and never an action BLOCKED BEHIND A GATE such as a running CI run. Each makes the ghost text hand it straight back, and the turn is spent explaining why not. Four times 2026-09-28; three more 2026-09-29 ('tell HR …'); twice again 2026-09-29 with a worktree retirement blocked on CI."
metadata:
  node_type: memory
  type: feedback
  originSessionId: ad19fe4d-689f-439a-a7a2-fab162bd5049
  modified: 2026-09-29T09:52:00.632Z
---

🔴 **The quoted words in the `Next step:` line are a MESSAGE HE SENDS TO CLAUDE, not a description
of what he should physically do.** If the quoted words name an act only his hands can perform — press
a button in a web UI, choose a file in a Windows dialog, factory-reset a tablet, scan a QR, wake a
device — the prompt-suggestion box offers them as ghost text, he sends them, and they arrive as an
instruction to Claude to do the impossible thing. The turn is then spent explaining why not.

**Measured 2026-09-28, four times in one evening**, all mine: `"press edit beside app file"` (opens a
Windows file picker), `"open the managed play page for phoenix workforce"`, `"upload the versionCode 4
aab"`, and `"factory reset PHX-TAB-0002 and scan the config 3 QR"` — the last one for a tablet
physically in his hands. Each came back verbatim as his next message.

🔴 **A MESSAGE HE SENDS TO A PERSON IS THE SAME FAILURE, and it is the easier one to walk into** —
measured 2026-09-29, three times in one session, all mine: `"tell HR to start scanning the hiring
documents"`, then `"tell HR to work the pedia checklist first"` **twice**. It looks like a decision,
which is why it passed: it is a real next action, it needs him, and it is his call. But Claude cannot
send anything to staff (no outbound email or bulk send from a business system, and a notification to
people is his own decision), so the ghost text hands Claude an order it must refuse, and the reply is
one more draft he has already been given. **The test is not "does this need him" — it is "can Claude
act on these words".** Drafting the message is Claude's work and belongs in the PROSE; the sending is
his and belongs nowhere in the box.

**Why:** ALWAYS PUT SOMETHING IN THE BOX (2026-09-18) says the line must end in words he could send
as-is. "Send as-is" is the whole test — and a physical act fails it, because sending it changes
nothing. The rule wants a DECISION, an APPROVAL, or an INSTRUCTION Claude can act on.

**How to apply:** when the real bottleneck is his hands, say so in the prose — plainly, with the
exact path — and put something CLAUDE CAN DO ON HIS WORD in the quoted words. Prefer the instruction
that follows the physical act (`"link the phoenix app to config 3 and push the rules"`), a merge
(`"merge 4652 when green"`), or a build Claude fires (`"build the mdm apk at code 4 for headwind"`).
Never quote a click, a file pick, a reset, a scan, a plug-in or a power-on. See
[[recommendation-goes-first-not-last]] and [[commands-handed-to-the-owner-must-be-powershell]].

🔴 **MECHANICAL SINCE 2026-09-29 — this is no longer behavioural only.** `~/.claude/hooks/next-step-capture.mjs`
already had `isHisOwnClick`, but it only fired on an imperative that ALSO named a surface from a
hard-coded list, and that list knew `play console` while the box said *"upload the code-5 aab in the
**Managed Play iframe**"* — so a physical act sailed through and he sent it straight back. Three changes
closed it: the managed-Play screens joined the surface list (managed play · private apps · iframe · play
developer · google cloud · api access · billing · expo.dev); `open` joined the imperatives (closing
*"open the managed play page"*); and a new `ALWAYS_HIS_HANDS` blocks **press · click · tap · scan · plug ·
swipe · photograph · factory reset · power on/off** with NO surface needed, because a surface list is only
ever as complete as the last incident and this session may never control his screen anyway. 🔴 **upload,
download, install, run and set deliberately stay surface-gated** — this session really does those (it
uploaded the mdm APK to Headwind over the API and installed it on a tablet remotely). `aab` counts as an
unreachable destination; `apk` does not. Verified 22/22 on real cases before trusting it.

🔴 **AND A MESSAGE TO A PERSON IS MECHANICAL TOO SINCE THE SAME DAY — `MESSAGE_TO_A_PERSON` /
`isMessageToAPerson`, clause 6.** `ALWAYS_HIS_HANDS` would never have caught it: `tell HR to work the
pedia checklist first` has no physical verb and names no surface, and it passes every test the
physical case fails — a real next action, genuinely his, unambiguously his call. Only the performer
differs from `merge 4729 when green`. It matches an imperative aimed at a THIRD PARTY —
tell · ask · remind · message · text · email · whatsapp · call · ring · chase · notify · inform ·
announce to · escalate to · follow up with · check with · confirm with · reply to · answer — with
`me`/`us`/`myself` excluded by lookahead, so `tell me what the closing shows` still passes. Verified
13 blocked and 10 allowed on real lines from this session, then driven end-to-end through a real
transcript: the message case and a physical act both block, a merge and a retire both pass. Backup:
`~/.claude/backups/hook-backups/next-step-capture.mjs.2026-09-29-message-to-a-person`.

🔴 **A THIRD FAILURE, AND THE SUBTLEST: AN ACTION CLAUDE CAN DO BUT IS BLOCKED FROM DOING YET.**
Measured 2026-09-29, twice in one session, both mine. With a PR mid-CI I put *“retire _wt-<task> and
delete its branch”* in the box. It passes every earlier test — Claude can do it, it needs his approval
(AGENTS.md §5), and it names a real target — so nothing refused it. But `scripts/new-session.mjs
--remove` gates on the **merged PR**, and the PR was still red-or-running, so the only possible reply
was *“I cannot yet, here is why”*. He sent it, got that, and sent it again a turn later. The same shape
ate two turns.

**The test is therefore three-part, not two:** can Claude act on these words, does this need him, and
**can it run RIGHT NOW**. An action waiting on a CI run, a deploy, a queued build or another approval
fails the third part even though it passes the first two — because the suggestion box has no notion of
“later”, and he reads ghost text as *do this next*.

**How to apply:** while a gate is pending, keep the blocked action in the PROSE (“the cleanup runs the
moment it merges”) and put something in the box that is actionable the instant he reads it — a decision
only he holds, a question already put to him, or the next piece of real work. Offer the gated action
ONCE, in the turn where the gate has actually cleared. Never re-offer it while it is still blocked: the
second offer is what turns one wasted turn into two.
