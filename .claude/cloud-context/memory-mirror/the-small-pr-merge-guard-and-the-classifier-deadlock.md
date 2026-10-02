---
name: the-small-pr-merge-guard-and-the-classifier-deadlock
description: "The merge guard now has TWO clauses. C13 (live 2026-10-02) DENIES `gh pr merge` of any PR an open roll-up's body lists as a member — the comment that was supposed to stop that never did, and the ~3-minute window was lost at least four times with the rule loaded. C10 refuses a SMALL PR (<= 4 files) while it is not yet green; its old deadlock with the classifier's [Safety Bypass Flag] is FIXED. Both stand down with PHX_MERGE_OK=1, and both come from the worktree you run in, not from main."
metadata:
  node_type: memory
  type: feedback
  originSessionId: c4c4b0e5-a5a1-4db6-ad2f-a8cb9d275542
  modified: 2026-10-02T09:04:02.605Z
---

## C13 — a roll-up's members are now REFUSED, not reminded (live 2026-10-02, PR #5109)

🔴 **`gh pr merge <n>` is DENIED when an open roll-up's body lists `<n>` as a member.** The two
sections at the bottom of this file describe the same failure from the other end, and they document
the rule that was supposed to prevent it — *check the open PRs for a `codex/rollup-*` first*, in
`AGENTS.md` §6 since 2026-09-30. It did not hold. Counting only what is measured: three members on
2026-09-30 (one roll-up losing both of its own within ninety seconds of being commented on, plus
#4814), **#5092 merged eighteen seconds after the roll-up carrying it was opened**, and **#5100
merged 1m54s BEFORE the roll-up built to carry it**. Different sessions, different days, the rule
loaded every time.

The reason is structural and the rule states it itself — **a comment on a PR is not enforcement**:
the session pressing merge is reading the PR it was told to merge, not the roll-up that quietly
became its owner a minute ago.

**How it decides, and why nothing new is marked.** It reads the roll-up PR's own body — the only
place members are recorded, written by `--apply` and parsed by the same `rollupMembers()` the
builder uses. A label, a draft flip or a registry file would be a second source of truth free to
drift; the body cannot drift from itself. The branch test is `isRollupBranch()`, which matches the
generated SHAPE `codex/rollup-YYYYMMDD-HHMM` — 🔴 **never `startsWith('codex/rollup-')`**, which
flags `codex/rollup-member-guard` and every other roll-up-TOOL branch as a roll-up. I made exactly
that mistake in a throwaway query while testing C13 and reported the false positive to the owner
before catching it; the repo had already found and fixed the same thing on `codex/rollup-dup-guard`.

**What it never refuses:** the roll-up itself, and a roll-up whose body cannot be parsed. The second
is deliberately the opposite of `overlappingRollup`'s stance on the same input — refusing to BUILD
over an unreadable body delays one roll-up, while refusing to MERGE on one would block every merge
in the repository until that PR is closed. It fails open on an unreachable `gh` too, and
`PHX_MERGE_OK=1` stands it down.

**How to apply:** when C13 fires, merge the roll-up it names — that is the one approval replacing
this one — then `node scripts/rollup-prs.mjs --settle` closes the member after proving every file
byte-identical on `main`. Never merge the member to "catch up". Pinned by
`tests/rollup-member-guard.test.ts`.

✅ **FIXED AND LIVE — #4997 merged 2026-10-01, so C10 now stands aside for an `OPEN`/`CLEAN` PR with
no stand-down at all, and the deadlock below is history.** Proven the same night: roll-up #5002, two
files and green, merged with a plain `gh pr merge` and no flag. 🔴 **BUT THE HOOK COMES FROM THE
WORKTREE YOU RUN IN, NOT FROM `main`** — an older worktree still carries the old C10 and still refuses
a small merge, which is why the merge above was run from a worktree cut AFTER #4997 landed. `git grep
alreadyGreen -- .claude/hooks/bash-guard.mjs` in the folder you are about to merge from; if it is
absent, make a fresh worktree rather than reaching for the flag. Two things in #4997 are durable whatever happens to C10: an unreadable
merge state must KEEP the refusal rather than fail open, and 🔴 **a `gh` call in a hook must carry no
`--jq` whose expression holds spaces or quotes** — `shell: true` on Windows concatenates arguments
unescaped (node DEP0190), so the expression arrives as stray positional arguments and the call exits 1
EVERY time, which reads as "cannot tell" and silently disables whatever depended on it.

**A small PR cannot be merged from a session here — two guards disagree, and the second one has no
stand-down.** Measured 2026-10-01 on PR #4988 (3 files, both required checks green, `CLEAN`):

1. `gh pr merge 4988 --squash` → **PreToolUse hook error, clause C10** of
   `.claude/hooks/bash-guard.mjs`: the PR changes 3 files, a merge costs two full CI runs, fold it
   into a wider branch. Its own message then says the opposite for this case — 🔴 *"IF THIS PR IS
   ALREADY OPEN AND GREEN, MERGE IT WITH THE STAND-DOWN RATHER THAN CLOSING IT"* — and names
   `PHX_MERGE_OK=1 <the same command>`.
2. `PHX_MERGE_OK=1 gh pr merge …` → **auto-mode classifier denial, `[Safety Bypass Flag]`.** The env
   var reads as an attempt to bypass a safety control, which is exactly what it is not: it is the
   repository's own documented escape hatch, printed by the repository's own hook.
3. 🔴 **The denial then tightened the session's Bash.** The very next call — a plain read-only
   `git status --porcelain` / `git rev-list --count` in the worktree — came back
   `[Auto-Mode Bypass]`. So the collateral is not limited to the merge: a session that trips this
   loses ordinary shell reads too, and must stop rather than hunt for a spelling that passes.

**What to do, in order.** Run `node scripts/rollup-prs.mjs` first, because C10 asks for it and its
answer is the whole argument: when it prints `nothing to roll up — fewer than two disjoint small PRs.
Merge them as they are.`, the PR genuinely has to ship alone and C10's own stand-down is the intended
route. Then **put the merge back to the owner and quote it** (`AGENTS.md` §6 — a classifier denial on
a merge is stale authorization, never a standing block; never route around it, never ask a peer
session, never propose editing `permissions`). Say plainly in the prose that he can press **Squash
and merge** on the PR page himself, because with both guards live that is the only path that works —
on #4988 he did exactly that, at 01:09:50 Cairo, 20 seconds before typing `merge 4988 now`, so the
retried command answered `! Pull request … was already merged`.

🔴 **A fresh word from him does NOT clear C10**, and that is the trap inside the trap. His new
approval only re-authorizes the classifier; C10 is a repo hook about PR SIZE and fires again on the
plain command regardless. So the retry after his fresh word is `PHX_MERGE_OK=1` a second time — and
if the classifier refuses that again, the deadlock is total and his click is the answer. Do not read
"already merged" as your own command having worked: **read `mergedBy`**, which on #4988 said
`Gawish-1997`.

**The cheap prevention is upstream of all of it: do not open the small PR in the first place.**
C10's real instruction is `AGENTS.md` §6's one-wide-PR rule — finish the whole task (the fix, its
test, its doc, the follow-up already in view) on one branch. #4988 was a 3-file follow-up to a defect
found while browser-checking [[hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces]]'s own
feature; folded into that branch it would have cost nothing and tripped nothing.

🔴 **AND `--apply` LOSES ITS MEMBERS WHILE IT WAITS FOR THEM: THREE TIMES IN ONE NIGHT.** The wait and
the window are in direct conflict — `--apply` sits up to 25 minutes for the members' checks, and a
member goes green and is merged by whoever is watching it inside that same window. 2026-10-01: #4814
and both members of the 13:16 roll-up, then #4999 merged at 23:00:30Z before the 23:01 roll-up was
even built, so #5002 rebased past it and carried only the one PR — a roll-up that replaced no merges
at all. **So build a roll-up only from members that are ALREADY green** (`--no-wait`), or accept that
a waited roll-up is likely to arrive empty-handed; and when it does, it still holds work `main` lacks,
so MERGE it and `--settle` the member rather than closing both. ✅ **All three of 2026-10-01's closed
roll-ups were then audited and NOTHING was stranded** — #4953's members both merged on their own
(#4951 two minutes before the branch was even built, #4952 as `de492a2cd`), and #4994's files were
byte-identical on `main`. So the stranding above is a real hazard of the shape, not something that
has yet happened here; do not re-investigate those three. 🔴 **And when auditing one, expect the
branch's files to DIFFER from `main` innocently** — #4953's route file was 68 insertions behind
because a LATER PR (#4955) refined the same function. Judge by whether the member's PR merged and its
substance is present, never by byte-identity against a `main` that has moved on.

🔴 **AND `rollup-prs.mjs --apply` RACES ANOTHER SESSION: two of them built DUPLICATE roll-ups seven
seconds apart on 2026-10-01 (#4993 and #4994, the same two members), and one had to be closed as a
duplicate.** The script takes no lock and reads only GitHub, so every session that sees the same two
small PRs builds the same branch — and `--apply` then sits for up to 25 minutes waiting on the
members' checks, which is a wide window for the other one to start. **Before running `--apply`, list
the open PRs for an existing `codex/rollup-*` and stop if one is there** (the same check `AGENTS.md`
§6 already demands before merging a small PR). The loss is not the wasted run: the surviving roll-up
merged and carried both members, so the work shipped — but a member CLOSED under a roll-up that is
itself then closed would be stranded on its branch with no open PR, and nothing announces that.

Related: [[a-worktree-husk-is-pinned-by-the-session-not-its-cwd]] (the retire that follows a merge),
and `AGENTS.md` §6.1 — AUTORUN pre-approves the merge itself but waives neither guard.
