---
name: five-sessions-fixed-one-production-error-in-parallel
description: "A single production error that surfaces while several sessions are live gets fixed five times over in one hour — triage it by diffing the changed file across every head, keep the copy already inside a green roll-up, close the pure duplicates, and comment rather than push on the one with unique extra content."
metadata:
  node_type: memory
  type: project
  originSessionId: e00847ef-5eba-4ce7-ad71-9818ac7186de
  modified: 2026-10-23T08:40:31.090Z
---

On **23 Oct 2026, 10:56–11:14 Cairo**, the `visit_lifecycle` detector's 42703 (`column
phoenix_crm_visit_recordings.id does not exist`, the table is keyed on `path`) was fixed **five
times in parallel** by five live sessions, each in its own worktree, each opening its own PR:
**#6325** (mine), **#6327**, **#6329**, **#6330**, and a hunk inside **#6319** — plus a sixth copy
sitting on `codex/visit-lifecycle-recordings-tiebreak` with no PR at all. Nothing coordinated them:
the error reached the System Audit page, and every session that read the page went and fixed it.

**Expect this whenever a deploy's first error lands while the laptop has several sessions open.** A
production error is visible to all of them at once, the fix is usually small, and the first thing
each session does is exactly the right thing.

**How to triage it, in this order:**

1. **Diff the changed file across every head before judging any of them** —
   `gh api repos/<repo>/contents/<path>?ref=<sha>` for each, then `diff`. All five copies here were
   **functionally identical**; the only differences were the wording of one comment block. Reading
   the PR bodies would not have told you that, and each body argues convincingly for its own.
2. **Keep the copy that is already inside a green roll-up**, not the "best" one. #6325 was in
   roll-up **#6328** with `validate` and `checks` both green, so it was the cheapest survivor by a
   wide margin. Verify the roll-up really carries it: compare each member file's **blob sha** at the
   member head and at the roll-up head — all seven matched.
3. **Close the pure duplicates yourself, with a comment that names the survivor and says the code
   was diffed.** Triaging open PRs is never the owner's job (AGENTS.md §6).
4. 🔴 **A duplicate carrying unique extra content is NOT closed.** #6330 had the same detector hunk
   but also a whole new module-memory module (`.claude/rules/phoenix-crm-recordings.md`), its
   registration and its test. **Comment asking its session to take `main`'s version of the shared
   file after the roll-up merges — never push to its branch**, which another live session owns.
   **It did not work here:** its session closed #6330 as DIRTY rather than rebasing, so that module
   file was lost. The trap itself survived — #6319 carried the write-up into
   `docs/agents-session-traps-clusters.md` — but if you want the narrower module memory, expect to
   write it yourself rather than to be handed it.
5. **Whichever copy merges first conflicts all the others**, so the roll-up has to reach the owner
   in the same turn you finish the triage ([[a-roll-up-must-be-merged-before-its-members]] is the
   same three-minute window).

The sessions do read each other's PR numbers: #6319's own session reverted its detector hunk at
11:11 Cairo with the message *"drop the duplicated visit_lifecycle fix — #6325 lands it inside
roll-up #6328"*. **A PR comment is a working channel between parallel sessions**, and the only safe
one — never a branch push.

Related: [[carry-the-system-audit-ledger-exceptions]],
[[a-push-that-prints-new-branch-means-the-pr-already-merged]].
