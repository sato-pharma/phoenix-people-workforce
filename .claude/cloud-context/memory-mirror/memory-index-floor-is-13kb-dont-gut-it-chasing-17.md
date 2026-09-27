---
name: memory-index-floor-is-13kb-dont-gut-it-chasing-17
description: "The MEMORY.md 'compact to under 17.1KB' nag is UNREACHABLE and must be ignored - it is built into Claude Code's memory tooling (no hook on this machine computes index size; do not hunt for it), and the real ceiling is the ~24,400-byte SILENT read cliff past which the tail is dropped on load. AGENTS.md 2.2 is the authoritative counter-rule. 17KB is unreachable because ~40-46% of the index is filenames inside ](...) syntax, irreducible except by DELETING memories, and label text already averages ~33-35 bytes. Do not delete memories, gut labels, or strip the owner's red-dot / lock / medal markers to hit a number. The levers, by yield: relocate REPO-OPERATING traps to AGENTS.md 2.1 (never Phoenix domain/owner/safety facts); demote topic groups to MEMORY-ARCHIVE.md; last resort is RETIRING a resolved memory, which is the owner's call, not mechanical."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 26968de2-24de-4b16-a339-4065a48eba87
  modified: 2026-09-25T22:50:55.679Z
---

**The `MEMORY.md` "compact to under 17.1KB" message is unreachable, and chasing it destroys the thing
the index is for.** Ignore the number. The real constraint is the **~24,400-byte silent read cliff** —
past it the tail of the file is dropped on load, so the last entries stop existing for practical
purposes. Land with real headroom, because parallel sessions append constantly. The authoritative
counter-rule lives in **`AGENTS.md` §2.2**, which auto-loads in full with no cliff; read it for the
live budget/cliff figures rather than quoting a number from here.

**It is NOT a fixable hook.** Verified: no script in `~/.claude/hooks/` computes the index size, and
there are zero `PostToolUse` registrations in any settings file. The message is built into Claude
Code's own memory tooling — **do not spend a session hunting for a hook to silence.**

**Why 17KB is structurally unreachable.** Measured many times: **~40–46% of the index is filenames**
inside `](…)` syntax, reducible only by DELETING a memory; **label text already averages ~33–35
bytes** (below that it stops being recognisable); the rest is structure and load-bearing prose.
Landing near 17KB means dropping hooks, and **an unlinked memory file is invisible, not merely hard to
find** — 194 of 734 were orphaned exactly that way. Say the ceiling plainly; do not invent another
cosmetic pass.

**The owner's markers stay.** The `🔴` bullet marker is his — he said *"put the red dots back"* after
a pass stripped all 94 to reclaim 470 bytes. `🔒` and `🥇` stay too. They are visual properties of a
file he reads, never slack. **Announce any change you make to the LOOK of this file** — a compaction
is authorised to shorten text, not to restyle it.

## The levers, by yield — and what each costs

1. **Relocate REPO-OPERATING traps to `AGENTS.md` §2.1** (highest yield; reopens whenever a fresh crop
   of tooling traps accumulates). Move ONLY shell/git/CI/migration/validation/worktree/runtime/browser
   facts. 🔴 **Never move a Phoenix domain fact, owner rule, or destructive-action guard** — those
   describe a live business and a person's decisions, they change without a commit, and `AGENTS.md` is
   a reviewed repo doc, not a notebook.
2. **Demote whole low-traffic topic groups to `MEMORY-ARCHIVE.md`** (~86 B/pointer, far above a label
   trim). Keep every owner rule, safety rule and guard inline; split a mixed line, guard staying,
   reference half leaving.
3. **Redundancy archiving** (a pointer whose fact already auto-loads from `AGENTS.md`/`CLAUDE.md`) —
   genuinely exhausted.
4. **Label trimming** — ~5 bytes an edit, each risking a blunted hook. **Never quote a KB figure for
   it**; count `labels ÷ count` first.
5. **The next real reduction is RETIRING a resolved memory — the owner's call, not a mechanical one.**
   Run that decision by CLAIM: [[staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones]].

## How to apply — the mechanics that keep it lossless

- **A pointer in `MEMORY-ARCHIVE.md` keeps a memory reachable but not auto-loaded** —
  `repo-doctor.mjs` sets `INDEX_FILES = ["MEMORY.md", "MEMORY-ARCHIVE.md"]`. So archiving/demoting
  clears an orphan at **zero index bytes**, and every cut line goes there **verbatim under a dated
  heading** before it leaves `MEMORY.md`.
- **Relocating a fact to `AGENTS.md` needs BOTH halves or it orphans the file** — `repo-doctor` does
  NOT read `AGENTS.md`. (1) fact → §2.1, re-derived from the memory FILE (never paraphrased from the
  index label); (2) pointer → `MEMORY-ARCHIVE.md`. And **verify the fact is actually on `main`** (fetch
  at the merge SHA and grep) before cutting the index line — a hook removed against an unmerged PR
  reaches nobody. `grep -c <filename> MEMORY-ARCHIVE.md` per candidate; dual-listing is a property of a
  line, never of a batch.
- **Verify a pointer by its FILENAME, never its label** — compaction rewrites labels by design, so
  grepping old wording reports a phantom loss. And **state WHICH count you mean**: total `](*.md)`
  occurrences ≠ unique filenames ≠ distinct memory files (they differ by the duplicate
  `MEMORY-ARCHIVE.md` pointers).
- 🔴 **Never punctuation-normalise (`—`, `·`, `→`, `≠`, quotes) across a backticked span — the
  character IS the fact.** An em-dash pass once rewrote the Head Office `` `—` `` rule to a hyphen and
  told every session to render those rows wrong. Split each line on `` ` `` and transform only the
  outside-code segments; a byte-count check cannot catch this.
- **Peers append while you edit** (measured ~500–600 B in ~20 min with several sessions live). MERGE,
  never overwrite; content-anchor splices, never line numbers; re-read the whole buffer immediately
  before writing and abort on drift.
- **Edit with the Write tool or a script FILE, never inline `node -e "…"` from Bash** — double quotes
  turn every backtick into a command substitution and silently corrupt these backtick-dense files
  (one run substituted an empty string for `` `repo:doctor` ``). Run **`node scripts/repo-doctor.mjs`**,
  not `pnpm run repo:doctor` (the pnpm purge aborts before the check).
