# The memory index — budget, cliff, and the displacement rule

This is the detail behind the hooks in [AGENTS.md](../AGENTS.md) §2.2. **The hook there is the cue;
this file is the fact** — the same split §2.1 and `docs/agents-session-traps.md` run under, and the
same reason.

**Why the detail lives here.** `CLAUDE.md` pulls `AGENTS.md` in via `@AGENTS.md`, in full, on every
single request. A one-line rule earns that; a 14,000-byte write-up about how to edit a 21,000-byte
file does not — it was ~3,600 tokens of fixed context on every message, to explain a procedure that
is only wanted once a session is already editing `MEMORY.md`, at which point the SessionStart hook
has already handed it the live figures. Measured 2026-08-29: the auto-loaded set was 140,003 bytes
(`AGENTS.md` 112,153 + `MEMORY.md` 20,926 + `CLAUDE.md` 6,924), ~35,000 tokens re-sent every
request, of which this section was the largest piece not already split out.

**Nothing here was rewritten.** The body below is the verbatim §2.2 text as it stood at `4d7d7cfb0`,
including every measurement, date, PR number and memory slug. Only the heading changed.

**The section heading it was under:** 2.2 The memory index and its 24,400-byte cliff (relocated from `MEMORY.md`, 2026-08-27)

---


**`MEMORY.md` is the ONLY memory file that auto-loads**, and the loader truncates it at **24,400
bytes**. Past that the tail is dropped **silently** - no error, no marker; the last lines simply
stop existing, so a hook can be present in the file and absent from every session that reads it.
The rules below governed that file from inside it, which is the one place they can be truncated
away. They live here because `CLAUDE.md` pulls this file in via `@AGENTS.md`, which has no cliff.

- **Hooks only - the label is the cue, the FILE is the fact.** An index line exists to make a
  memory findable, not to carry it. Detail belongs in the memory file it points at.
- **Re-read immediately before rewriting.** Parallel sessions append to it, so a write built on a
  copy read minutes ago silently drops whatever landed in between.
- **Never drop a hook, and keep the markers.** Being under the limit is not worth being wrong, and
  the red markers are how a tired session finds the dangerous line at 4am.
- **The floor is structural.** See `memory-index-floor-is-13kb-dont-gut-it-chasing-17` - roughly
  13KB of it is hooks that have to exist. Do not gut it chasing a smaller number.
- 🔒 **IGNORE the "compact it to under 17.1KB" message. It asks for something arithmetically
  impossible, and obeying it means DELETING memories.** Every edit to `MEMORY.md` returns a
  system message reading *"The memory index at MEMORY.md is NN KB, approaching the 24.4KB read
  limit. Compact it to under 17.1KB now: keep one line per entry, move detail into topic files,
  and merge or drop stale entries."* It is authoritative-looking, it fires on **every single
  edit**, and its number is wrong. **17.1KB was measured unreachable, twice:** with every label
  cut to 25 bytes *and* every trailing tail deleted, the file still floored at **18,612 bytes** -
  because the dominant cost is filenames plus `[]()` link syntax (**11,170 bytes at 218 links**),
  which shrinks *only* by deleting a memory. And **an unlinked memory file is invisible, not
  merely hard to find** (§5: 194 of 734 were orphaned exactly that way), so "merge or drop stale
  entries" is the expensive half of the advice, not the cheap one.
  **The only real constraint is the 24,400-byte read limit.** Land under that with genuine
  headroom and stop; a pass that ends at 20-22KB with every link intact is a SUCCESS, not a
  partial job, and no session should keep cutting toward 17.1 after reaching it.
  **Do not go hunting for this message to silence it - it is built into Claude Code, not a hook
  here.** Verified 2026-08-28: **zero** `PostToolUse` registrations exist in any settings file on
  this machine (user, project, or local), and no script in `~/.claude/hooks/` computes the index
  size - `memory-guard.mjs` is about the machine's COMMIT charge and is unrelated despite the
  name. It cannot be edited, re-pointed, or turned off from this repository, so the counter-rule
  has to live here instead. That is what this bullet is.

**When it goes over, take the bytes from formatting and filler, never from facts.** Measured
2026-08-27, when it sat **202 bytes over** and had silently dropped two real hooks - the
direct-order case-sensitivity trap (`.eq` hid 28% of reps' own orders) and the note that keeps
tooling traps out of the index:

- **An em-dash costs 3 bytes and a hyphen costs 1.** The index held 102 of them: **204 bytes** of
  punctuation that changes nothing anyone reads, and both styles were already mixed in the file.
- **Bold costs 4 bytes a pair**, 111 pairs = 444 bytes - available, but spend it last: bold is how
  the critical clause is found at a glance.
- Filler words gave another 116, with every number, rule, file name and link left intact.

**Verify a trim by COUNTING, not by reading it back.** Before and after must match on link count,
marker counts and line count, and no link may become dead - a trim that moves any of those removed
something real. The 2026-08-27 pass freed 320 bytes with all counts identical (163 links, 102 red,
4 lock, 121 lines) and left a `MEMORY.md.bak-before-trim-<date>` beside it.

**Headroom under ~150 bytes is not a fix** - that is less than one hook line, so the next session's
append re-breaks it the same silent way. When compression is exhausted, move guidance HERE rather
than deleting a hook. That is what §2.1 did in August, and what this section is.

**"Here" is three places, not one, and the SessionStart hook now names all three.** Route by KIND of
fact: an agent-operating trap to §2.1, a production or approval hook to §2.3, an **owner product
rule to §4** — which is where 2026-08-28's two relocations went, eight marketing-validation hooks
into §4.1 (#2565) and seven owner product rules into §4 itself (#2566). Filing an owner rule among
the session traps is not merely untidy: §2.1 is the section a session skims for shell and git
behaviour, so a payroll or export rule parked there is read by nobody who needs it. The hook said
"2.1/2.3" for its first day and would have sent exactly those seven to the wrong section;
`tests/session-start-memory-index-guard.test.ts` now pins all three routes.

**Trim BEFORE the cliff, and relocate rather than compress once the levers are gone.** Measured
2026-08-27 evening at **23,937 bytes - 463 bytes of headroom**, so not yet over, but every
punctuation lever the passes above used was already spent: **zero** trailing whitespace, **zero**
double spaces, and **one** em-dash left of the original 102. What remained was 43 bold pairs (172
bytes, and §2.2 says spend those last) against two index lines - the parallel-session collision trap
and the one-approval-reaches-several-sessions trap, **482 bytes together** - that were already
misfiled: the index's own last line says session and tooling traps belong in §2.1, and both of those
are agent-operating facts rather than Phoenix business rules. Relocating them to §2.1 freed more
than every remaining formatting lever combined and cost no fact anything.

**The 2026-08-28 pass — and the second thing a trim is for.** Measured at **24,230 bytes, 170 bytes
of headroom**, which §2.2 already says is not a fix: less than one hook line, so the next append
re-breaks it the same silent way. Compression was again exhausted (**zero** trailing whitespace,
**zero** double spaces, **one** em-dash, 46 bold pairs to spend last), so this was a relocation
too — four hooks that were misfiled as Phoenix business rules when they are nothing of the kind:
**two PostgREST filter traps** to §2.1 beside the `.in()` trap they are siblings of, the **Railway
`service source connect`** trap to §2.3, and **production has no PITR** to §2.3. That freed **718
bytes — headroom 170 → 888**, and every count moved by exactly the relocation and nothing else:
links 157 → 153 (the four moved hooks), lines 118 → 116, 🔴 99 → 97, 🔒 4 → 4, and **no surviving
link went dead**. The `ARCHIVE` pointer that shared a line with the PostgREST hooks was carried
verbatim onto the WhatsApp coexistence line it actually belongs to rather than deleted.

**Read every line you touch while you are in there — a trim is the one pass that reads the whole
index.** This one found a **false present-tense claim**: the index asserted "**~18 cron routes FALL
OPEN with no `CRON_SECRET`**", which #2479 closed on 2026-08-27. Verified on `origin/main` before
removing it — **0** routes carry `if (!secret) return !isProductionRuntime();`, **22** carry the
hardened `process.env.NODE_ENV === "development"` form — and the memory file behind the hook was
corrected in place too, since the file is the fact. A stale hook is worse than a missing one: it
spends a tired session's attention defending a hole that is already shut. Deleting it was safe only
because the corrected account lives in §2.3, which auto-loads in full.

**THE INDEX IS CAPPED AT 22,000 BYTES, AND THE CAP IS HELD BY DISPLACEMENT — not by periodic
rescue.** Trimming stopped working on 2026-08-28: a verified 718-byte relocation bought **fifty
minutes**. Two parallel sessions appended **567 bytes** (lines of 330 and 235) before the same
session had finished sweeping — each new line on its own **larger than the headroom the trim had
just created**. The file is append-only in practice: every session adds a hook, almost none retires
one. So any fix framed as "trim it when it gets big" loses to the append rate by construction, and
the three passes in this section that each freed a few hundred bytes were all treating a symptom.
**The file is never quiet long enough to reason about from a stale reading**: it measured 24,065
bytes that morning and 23,837 three hours later, edited by a session that was not the one holding
the number. Re-measure before acting; never quote a size from this file.

**The budget is 22,000 bytes; the loader cliff stays 24,400.** The 2,400-byte gap is about ten
hooks at the file's own average, which has held at **~230 bytes across 101 hook lines** on every
measurement so far — enough slack that several parallel sessions can append before anyone must act.
That is the difference between a budget and a fire alarm. It also stays clear of the ~13,000-byte
structural floor, so the cap constrains growth without asking anyone to gut the index chasing a
smaller number. `node scripts/repo-doctor.mjs` now prints the verdict and **the exact bytes to
free**; `scripts/memory-index-budget.mjs` holds the arithmetic and `tests/memory-index-budget.test.ts`
pins it — including a pin that the OLD ceiling-only rule stayed **silent at 335 bytes from the
cliff**, which is what proves the test discriminates rather than passing for free.

**And nobody has to go looking for that verdict any more.** `.claude/hooks/memory-index-guard.mjs`
runs on **SessionStart** and puts the same three figures — size, headroom to the budget, and the
exact bytes to free — plus the displacement rule below into every session's context *before* it
appends anything. That closes the gap the doctor cannot: the doctor is a periodic audit, and an
audit fires after the write. Two details are deliberate. It is **its own hook entry**, not a line
inside `session-lock.mjs`, because that script returns early whenever another session's lock is
live — exactly the case that produces colliding appends. And it resolves the index from the
**primary checkout**, not from the worktree a session is sitting in, or every `_wt-*` session would
look up a slug of its own path, find no directory, and stay silent while doing most of the
appending. The human is interrupted only when action is due; the session is told every time.
`tests/session-start-memory-index-guard.test.ts` pins the wiring and both lookups, and both were
proven by breaking them.

**THE DISPLACEMENT RULE: you may not add an index line without freeing at least as many bytes in
the same edit.** Retire a resolved hook, or relocate one to §2.1/§2.3. This is the only part that
changes the outcome — it turns an append-only file into a fixed-size one, and it puts the cost on
the session that benefits rather than on whoever next notices the file is full. **There is always
fuel.** Of roughly 15 hooks checked by claim on 2026-08-28, **three were stale**: one said 18 cron
routes fell open (closed by #2479), one advertised an unfixed data-loss defect (closed by #2329
with three defences), one said two active reps had no hire date (fixed 2026-08-23 — the file's own
body already said so while its description and the hook both said the opposite).

**What earns a line — all three, not two of three:**

1. **A session would act WRONGLY without it**, in work it is plausibly about to do. Not "this was
   hard to find", not "this cost me an hour", not "this is interesting".
2. **It is durable** — a rule or a trap, never a count, a status, or a date. Status rots, and rots
   invisibly: "325 pharmacies" is now 326, "2 ACTIVE reps" is 0, "1 still open" is 0. **A hook whose
   whole content is a number is a hook that will one day be wrong**, and a wrong hook costs more
   than a missing one because it is defended rather than looked up.
3. **It is not derivable in one step.** If a `git grep` or a single query answers it, the answer is
   cheaper than the line.

**What never earns a line, however true:** anything agent-operating — shell, git, CI, PRs,
worktrees, tooling, production-ops, session mechanics. Those belong in §2.1 or §2.3, which auto-load
in full and have no cliff. **Reach is identical; only scannability differs** — so the index's scarce
bytes must hold what a session has to see *before it knows it needs it*. This rule already existed
and is already broken repeatedly: four such hooks were relocated out on 2026-08-28 alone.

**What must come out — the fuel the displacement rule spends:** any hook whose claim is now false;
any "still open" or "not fixed" hook whose item has shipped; any hook that is only a count or a
status; any hook naming retired infrastructure. **Correct the FILE before the hook.** Two of the
three stale hooks found that day sat above files that were already right, with the frontmatter
`description` still asserting the opposite — and the description is what gets read when deciding
whether a memory is relevant at all, so fixing only the hook leaves the error where it does the most
damage.

**The honest limit: no required check can gate any of this.** `MEMORY.md` lives under `~/.claude/`,
not in the repository, so CI never sees it — the doctor is a local report and the displacement rule
is behavioural. That is precisely why the cap is written *here*, in the file that auto-loads in
full, instead of only in a script nobody is obliged to run.

**A relocation spanning git and `~/.claude/` must finish BOTH halves or neither, in that order.**
The destination must be **merged**, not merely written, before the index line is trimmed - between
those two moments the fact exists in neither auto-loaded file. This is not hypothetical: a session
on 2026-08-27 finished the `MEMORY.md` half and not the git half, orphaning two memories that no
repo-level check could see, because one side of the move is not in the repo at all. Full account in
§2.1 under Parallel sessions.
