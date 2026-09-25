---
name: memory-index-floor-is-13kb-dont-gut-it-chasing-17
description: "The MEMORY.md compaction hook asks for <17.1KB — do not delete memories, gut labels, or strip the owner's red-dot markers to hit that number. Measured four times: filenames cost 11.2KB at 218 links but only 6.2KB at 114, so the floor rises with every memory ADDED and falls when pointers relocate into AGENTS.md."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 26968de2-24de-4b16-a339-4065a48eba87
  modified: 2026-08-28T08:27:41.835Z
---

**It is NOT a hook, and there is nothing on this machine to fix — verified 2026-08-28.** The owner
asked for it to be silenced or re-pointed at 24.4KB; it cannot be. There are **zero** `PostToolUse`
registrations in any settings file here (`~/.claude/settings.json`, the repo's `.claude/settings.json`,
and `.claude/settings.local.json` all read 0), and **no script in `~/.claude/hooks/` computes the
index size at all**. `memory-guard.mjs` is a red herring twice over: it is a *SessionStart* hook and
it measures the machine's Windows COMMIT charge, not this file. The message is built into Claude
Code's own memory tooling. **Do not spend a session hunting for it.** The counter-rule therefore
lives in `AGENTS.md` §2.2, which auto-loads in full and has no truncation cliff, and it says plainly:
obey the 24,400-byte read limit, ignore the 17.1KB number, and never delete a hook to satisfy it.

The message that fires on `MEMORY.md` says "compact to under 17.1KB". **It is not reachable without
deleting memories, and it gets further away every time one is added.** Measured twice while
actually compacting:

| part | 08-21 #1 (175 links) | 08-21 #2 (206 links) | 08-22 #3 (218 links) | 09-01 #4 (114 links) | reducible? |
| --- | --- | --- | --- | --- | --- |
| filenames + `[]()` syntax | 9,235 | 10,766 | **11,170** | **6,228** | only by DELETING a memory |
| label text | 6,358 (avg 36) | 8,210 (avg 38) | 7,650 (avg 35) | 4,354 (avg 38) | yes, at the cost of recall |
| trailing prose | — | 2,504 | ~1,900 | **5,653** | yes — move it to the ARCHIVE |
| headings, bullets, `·`, emoji | 2,675 | 2,571 | ~1,077 | ~771 | mostly not |

**Compute the floor before cutting, every time.** With every label cut to 25 bytes *and* every
tail deleted, the second pass still floored at **18,612**. Landing anywhere near 17.1KB now means
dropping hooks — and **an unlinked memory file is invisible, not merely hard to find**
(AGENTS.md §5: 194 of 734 were orphaned exactly that way).

**The real constraint is the 24.4KB read limit, not 17.1KB.** Past it the tail of the file is
silently dropped on load, so the last entries stop existing for practical purposes. Aim to land
with real headroom — pass #2 landed at **20.7KB with 206 of 206 links intact**, pass #3 at
**21.3KB with 218 of 218** (the 0.6KB rise is 12 new filenames, not slack) — because parallel
sessions append constantly: the index grew 25,903 → back over the limit within a single day.

**The `🔴` bullet marker is the OWNER'S, and it stays. Do not strip it — he asked for it back.**
Pass #3 removed it on the reasoning that it sat on **94 of 94** bullets, so it distinguished
nothing and cost 470 bytes (4-byte emoji + space × 94). He said *"put the red dots back"* the same
day. It is a visual property of a file he reads, not slack to be reclaimed — 470 bytes is under 2%
of the file and never the difference between fitting and not. `🔒`×3 and `🥇`×1 stay too.

Restoring it is exact, not guesswork: `95` bullets open with `- `, `1` of them carries `🔒`, and
the other `94` are precisely the stripped set — `sed -i '/^- [🔒🥇]/!s/^- /- 🔴 /'` puts them back
and nothing else moves. **Keep announcing any change you make to the look of this file** — a
compaction is authorised to shorten text, not to restyle it.

**Why:** the hook emits a generic 70%-of-ceiling target; it cannot see that this index's cost is
structural. Chasing it destroys the thing the index is for.

**How to apply:**
1. Snapshot the sorted `](*.md)` set BEFORE touching anything.
2. Append the index lines you are about to shorten to `MEMORY-ARCHIVE.md` **verbatim, under a dated
   `## Index caveats trimmed <date>` heading** — then no tail is ever lost, only relocated.
3. Cut trailing prose first, then long labels. **Keep any tail that states an owner rule or a
   safety rule** — "never print the value", "removing an id needs the owner's go". Those belong in
   the always-loaded index, not only in a topic file. Pass #2 over-cut two secret-handling tails
   and had to put them back.
4. **Link-diff before writing** — `comm -23` the sorted old/new sets; it must be empty. That diff
   caught a parallel session appending **three separate times** during pass #1 (the Write tool's
   staleness check forced each re-merge — do not work around it). **Use the identical regex on both
   sides, case-insensitively.** A lowercase-only `[a-z0-9-]*\.md` silently misses the 6
   `MEMORY-ARCHIVE.md` pointers and reports 6 phantom losses — pass #3 raised exactly that false
   alarm. Then check every target actually exists on disk; a pointer to a deleted file is the one
   failure the diff cannot see.
5. Report the number you actually landed on and say plainly that 17.1KB was not reachable.
6. **When a parallel session compacted the same file, MERGE — never overwrite, and never port its
   conclusions unverified.** 2026-08-23: a peer's draft dropped 6 hooks whose files still existed,
   so overwriting would have orphaned them. Re-merging was right. But I then copied two "new facts"
   straight out of that draft, and one — "`refs/deleted-*` now holds 0" — was FALSE and already
   retracted at the source. Re-derive a peer's *evidence*, not its *summary*; the peer had run
   `for-each-ref 'refs/deleted-*'`, which reads 0 because `*` never crosses `/`, while 19 tips and
   10 stashes sat untouched under the full prefix. A wrong memory is worse than a missing one: that
   one invited the cleanup that would have made it true, on the only copy of unpushed work.
7. **Verify a pointer by its FILENAME, never by its label text** — compaction rewrites labels by
   design, so grepping your old wording reports a phantom loss. Two sessions hit this the same
   night. The mirror-image failure is a broken *checker*: MSYS `grep` cannot match emoji and
   returned 0 for the owner's red markers, reading as "already stripped" when all 108 were present.
   Census emoji in Node with `\u{1F534}` and the `u` flag. When a check says something vanished,
   suspect the check before the file.
8. **State WHICH count you mean — three sessions disagreed on the pointer total and all were
   right.** The same index reads 223, 217, or 216 depending on the question: total `](*.md)`
   occurrences (223), unique filenames (217), or distinct memory files pointed to (216). The gap is
   exactly the **6 duplicate `MEMORY-ARCHIVE.md` pointers**, which are links but not memories.
   `repo:doctor` quotes total occurrences; a link-diff must use unique filenames or it reports
   phantom losses. When you hand a peer a number, say which of the three it is — otherwise the next
   session "reconciles" a discrepancy that does not exist.

See [[running-vacation-service-standalone-needs-an-extended-loader]] for the same "measure the
floor before cutting" habit.

## 2026-08-23 — MEASURED: label trimming is worth ~5 bytes an edit. Stop estimating it in KB.

A session (this one) recommended a label-trim pass to "give back another 1–2 KB". **It gave back 90
bytes across 18 trims.** The estimate was wrong by more than an order of magnitude, and the reason is
measurable rather than a matter of judgement:

| Component | bytes | share | compressible? |
| --- | --- | --- | --- |
| filenames inside `](...)` | ~10,700 | ~46% | **no** — only by deleting memories |
| label text inside `[...]` | 7,339 over 218 labels | ~32% | barely — **33.7 b average already** |
| structure (`- 🔴 `, `·`, brackets, newlines) | ~4,000 | ~17% | no |

**33.7 bytes is the floor, not a starting point.** Successive sessions have already squeezed these;
what is left is `NULL \`agent_hr_id\` on a PLAN row = LEAVER` — no filler to remove. The 18 trims that
did land averaged **5 bytes each**, and every one carried a small risk of blunting a hook to buy those
5 bytes. That is a bad trade and it is not worth repeating.

**How to apply.**
- **Never quote a KB figure for a label trim again.** Count it first: labels total ÷ label count. Above
  ~30 b average, the answer is "a few hundred bytes at most" and usually not worth the risk.
- **The lever that actually works is archiving pointers** whose fact already auto-loads from
  `AGENTS.md`/`CLAUDE.md` (`CLAUDE.md` line 10 is `@AGENTS.md`). That returned ~1,000 bytes on the
  first pass — but it is nearly exhausted too: 15 pointers found the first time, **3 the second**.
- **When headroom gets tight, the honest answer is that the index is near its structural floor and the
  next real reduction means retiring memories, not rewording them.** Say that plainly instead of
  proposing another cosmetic pass. See [[staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones]].
- Peers trim this file concurrently. Of the headroom gained this session, **most came from other
  sessions** — measure before and after your own edit, and never claim a peer's bytes.

## 2026-08-23 (pass 4) — MEASURED: demoting TOPIC GROUPS returns ~86 B a pointer. That lever is NOT exhausted.

The section above says "the lever that actually works is archiving pointers ... but it is nearly
exhausted too: 15 the first time, **3** the second." **That sentence is about a different lever, and a
session reading it as "archiving is done" will conclude wrongly.** Two distinct levers exist:

| Lever | What it moves | Yield when measured |
| --- | --- | --- |
| *Redundancy* archiving | pointers whose fact ALREADY auto-loads from `AGENTS.md`/`CLAUDE.md` | 15 pointers, then 3 — **genuinely exhausted** |
| *Topic-group demotion* | whole low-traffic subsystems, pointer line left behind | **51 pointers, 4,078 bytes, one pass** |

Pass 4 took the index **25,002 → 20,924 bytes (24.42KB → 20.43KB)** by demoting five groups: SoS/weekly
closing internals, org/role-write detail, Marketing pharmacy-code internals, Recruitment/ATS/CV +
iReports360, and registry/field-shape/Claude-config/DB-perf detail. That is **~86 bytes per pointer** —
seventeen times what a label trim returns. It works because these are *reference-grade* facts: real, but
consulted when you are already inside that subsystem, where the archive is one read away.

**Demoting is NOT orphaning, and this is the fact that makes the lever safe.** `scripts/repo-doctor.mjs`
sets `INDEX_FILES = ["MEMORY.md", "MEMORY-ARCHIVE.md"]` — a pointer in the archive keeps its memory
*reachable*; it only stops being *auto-loaded*. Verify that line still reads both files before relying on
this. After pass 4 `repo:doctor` reported **832 files, 833 pointers, zero orphans, zero broken**.

**How to apply.**
- **Selection rule: demote reference-grade detail; keep every owner rule, safety rule, and
  destructive-action guard.** Test each line against it explicitly. Pass 4 tested and **kept**
  `system_validated` = NO HUMAN LOOKED, REGISTERED-CODE-beats-GPS, PROD PITR OFF, the
  15s-timeout-commits-anyway trap, and the allow-rule-bakes-a-live-secret hook. Two mixed lines were
  **split** — safety hook stayed, reference hooks moved, original archived verbatim.
- **Census the markers in the DRY RUN, not after.** The SoS group swept up a line carrying the owner's
  `🔒` (Fayoum/Beni Suef). A before/after `🔴`/`🔒`/`🥇` count caught it while nothing was written; that
  line was pulled from the group. Also assert **no surviving bullet is markerless**.
- **Anchor edits on the FILENAME, never the line number.** A peer appended to `MEMORY.md` *between* the
  two writes of this pass (+16 bytes). Content-anchored splices absorbed it with no merge and no loss;
  line numbers would have silently hit the wrong row. Re-read and compare the whole buffer immediately
  before `writeFileSync`, and abort if it moved.
- **Run it as `node scripts/repo-doctor.mjs`.** `pnpm run repo:doctor` aborts on the
  [[pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved]] purge and never reaches the check.
- **Where the floor now sits: ~180 index pointers is not the floor, but the next pass has less to take.**
  The five obvious low-traffic groups are spent. Landing at 20.4KB buys roughly a day and a half at the
  observed ~3KB/day of peer appends — so expect to do this again, and expect the *next* honest answer to
  be retiring memories rather than moving them.
- **Never edit these files with `node -e "..."` from Bash — double quotes make every backtick a command
  substitution.** Pass 4 wrote the string ``All 51 resolve; `repo:doctor` reports 832 files`` and bash ran
  `repo:doctor`, got *command not found*, and substituted **empty** — silently landing "resolve;  reports
  832 files" in `MEMORY-ARCHIVE.md`. The script reported success; only re-reading the line caught it. These
  files are dense with backticked identifiers, so this corrupts almost any edit. Use a **quoted heredoc**
  (`node <<'EOF'`) or a script file, and grep the written token back afterwards. Sibling of
  [[heredoc-eats-backslashes-and-makes-a-test-that-only-passes]]: the shell mangles the payload and the
  tool still exits 0.
- **Pass 5 (2026-08-23) measured the regrowth rate and confirmed the prediction above.** Pass 4 landed at
  20.4KB; **~4 hours later the index was back to 23,799 B** — peer sessions append faster than the stated
  ~3KB/day when several are live at once. Pass 5 took four more groups (marketing evidence/validation ×3,
  deductions+incentive+outstation ×9, geocoding ×2 **split** so the two safety clauses stayed in the index,
  WhatsApp coexistence ×1 **split** so the PostgREST trap stayed) and landed **22,030 B — only 1,769 B**,
  against pass 4's much larger yield. 196 → 183 pointers, 13 relocated, 0 lost, markers 110→105 🔴 with
  🔒/🥇 untouched. **That is the floor arriving.** What is left in `MEMORY.md` is owner rules, safety
  rules, destructive-action guards, and traps that bite any session — moving any of those is a downgrade,
  not a compaction. **The next pass must be a retirement pass**: decide what is no longer true and delete
  it, which is the owner's call, not a mechanical one.

## 2026-08-23 (pass 6) — the LAST mechanical lever: signpost lines are not hooks. 661 B, and that is the end.

Pass 5 concluded "the floor is arriving; the next pass must be a retirement pass." **That is correct about
hooks, and it missed one non-hook category.** Some index lines carry NO memory pointer at all — they point
only at `MEMORY-ARCHIVE.md` and exist purely as navigation ("*N* hooks in ARCHIVE § pass 4"). Measured:
**12 such lines costing 1,284 B**, of which 9 were consolidatable into a single `ARCHIVE by topic` line.

**Result: 22,030 → 21,369 B, 661 B saved, 183 → 183 unique pointers, ZERO hooks touched.** Every topic
name and count survives on the merged line, so nothing became unfindable — only unpositioned.

**Find them mechanically, do not eyeball it:** for each line, collect `](*.md)` targets; a line where
*every* target is `MEMORY-ARCHIVE.md` is a pure signpost. A line with even one memory pointer is MIXED and
must not be merged — exactly one existed here (the PostgREST `neq` hook with a backlog note appended).

**Two of the twelve were deliberately KEPT**, and the rule generalises: a signpost that also states a rule
is a rule. `39 prod changes 08-10→08-19 — do NOT undo` is a destructive-action guard wearing a signpost's
clothes, and the `## Prod & approval (Railway)` heading is structure. Only merge lines that are *purely*
counts and section names.

**Marker arithmetic that will otherwise look like vandalism:** 🔴 drops 105 → 97 because nine whole
bullets left, each taking its own marker. That is NOT the marker-stripping the owner objected to. Assert
the right invariants — 🔒 and 🥇 unchanged, and **zero markerless surviving bullets** — rather than a flat
🔴 count, which legitimately falls whenever a bullet is removed.

**Where the floor now sits, honestly: 21,369 B with 3,002 B headroom, and no mechanical lever remains.**
Redundancy archiving is exhausted (15, then 3). Topic-group demotion is exhausted (51, then 13, then 0 —
what is left is owner rules, safety rules, destructive-action guards and traps). Label text is **32.5 B
average over 195 labels**, below the 33.7 B already called the floor. Broken pointers: **0**. Duplicate
pointers: **0**. **The next pass is a retirement pass and it is the owner's call** — which facts are no
longer true — not a mechanical one. Say that plainly rather than inventing a seventh cosmetic pass.

## 2026-08-23 (pass 7) — pass 6's "no lever remains, retirement is the owner's call" was WRONG. The ceiling is the LOADER's, not the context's.

Pass 6 closed with *"no mechanical lever remains. The next pass is a retirement pass and it is the
owner's call."* The owner rejected that outright — a 182-row classify-this XLSX was built for him and
his answer was to go audit it instead. **He was right, and the audit found the opposite of what pass 6
predicted.**

**First: there was nothing to retire.** Measured across all 182 index-pointed memories — **182 pointers
to 182 distinct files, ZERO duplicates, ZERO broken, and 180 of 182 modified inside the same month.**
A scan for referenced repo paths that no longer exist flagged only **3**, and reading all three they
were all KEEP (one is `continue-verifying-resumes-sos-audit` — deleting it makes the owner's trigger
phrase re-run a 20-agent audit he stopped to save usage). Spot-checks against live state all came back
TRUE: `sharp` really is in `dependencies`, `refs/deleted-*/**` really holds 44 refs. **A corpus this
fresh has no slack, and a retirement pass over it would have deleted true facts to buy bytes.**

**The lever pass 6 could not see: `MEMORY.md`'s 24,400-byte cliff belongs to the MEMORY LOADER, not to
the context.** `AGENTS.md` is **34KB+** and auto-loads *in full* every session through `CLAUDE.md`'s
`@AGENTS.md` include — verified by reading its own tail out of the live context. So a fact does not
have to sit in `MEMORY.md` to reach every session; it only has to sit somewhere that auto-loads. **The
repo auto-loads and has no truncation cliff.**

| | before | after |
| --- | --- | --- |
| `MEMORY.md` | 21,369 B | **17,306 B** |
| headroom to 24,400 | 3,031 B | **7,094 B** |
| yield | — | **4,253 B / 15 lines / 40 pointers** |

That beats pass 4's 4,078 B and is the largest single reduction ever measured on this file. Shipped as
PR #2349, moving the traps into `AGENTS.md` **§2.1**, which is what §2 "Hard-Learned Rules" already
existed to hold — so they also gained review and version control, which a user-directory file never had.

**Selection rule, and it is a hard boundary.** Move only **repo-operating** facts: shell, git, CI,
migrations, validation, worktrees, Next.js runtime, browser/dev-auth. **Never move Phoenix domain
facts, owner rules, or destructive-action guards** — those describe a live business and a specific
person's decisions, they change without a commit, and `AGENTS.md` is a reviewed repo document, not a
notebook. What remains in `MEMORY.md` after pass 7 is exactly those three categories, which is why
**this lever is now spent too** — but spent honestly, with 7KB of headroom instead of 3KB.

**How to apply.**
- **Leave a signpost with NO `.md` link.** One line in `MEMORY.md` says the tooling traps live in
  `AGENTS.md` §2.1 and must not be re-added. Write it as plain backticked text: **any `](anything.md)`
  makes `repo-doctor` treat it as a pointer to a memory file and report a BROKEN pointer.**
- **Keep the pointers in `MEMORY-ARCHIVE.md` as well as the facts in `AGENTS.md`.** Belt and braces —
  the archive keeps all 40 reachable (`INDEX_FILES` reads both), so `repo:doctor` stayed at
  **848 files / 849 pointers / 0 orphans / 0 broken** across the whole move.
- **Assert four invariants before writing, and abort on any:** every pre-move target still reachable in
  `MEMORY.md` ∪ `MEMORY-ARCHIVE.md`; `🔒` and `🥇` counts unchanged; zero markerless surviving bullets;
  and a final re-read equal to the buffer you started from. `🔴` legitimately falls 97 → 82 because 15
  whole bullets left — assert the other three, never a flat red count.
- **Anchor on the FILENAME and require exactly one match per anchor.** A peer appended a sixth pointer
  to one of the fifteen lines *during* this audit; content anchoring absorbed it, a line number would
  have cut the wrong row.
- **Run the edit from a script FILE, not an inline heredoc.** One inline `node <<EOF` aborted with
  **exit 66 and no output at all** from the permission layer; the identical logic in a `.mjs` file ran
  first try. Also `export` any env var the script reads — an unexported `$SP` reaches Node as the
  literal string `undefined` and writes to `.../undefined/file`.

**Say this plainly to the next session: the index was never the problem.** It was 182 true, deduplicated,
actively-maintained facts squeezed into a 24KB box next to a 34KB box that was never full.

## 2026-08-25 (pass 8) — the file had crept back to 31 BYTES under the cliff. Swept off the edge; all six mechanical levers now spent.

Two days after pass 7 landed at 17,306 B, a request came in to "compact to under 17KB". Measured
first: **24,369 B — 31 bytes under the 24,400 cliff**, +7,063 B of regrowth. The urgent finding was
the cliff, not the 17KB nag: one more peer append of 32 B would have started silently dropping the
tail (which ended on the live `a-red-main-ships` trap). **Compaction was warranted for the right
reason — headroom — and 17KB was still structurally unreachable**, exactly as passes 5–7 recorded.

**Every regrown byte was a domain fact, so pass 7's highest-yield lever (relocate to `AGENTS.md`
§2.1) had nothing to take.** The +7KB is CV/WhatsApp/recruitment/marketing/cron investigations,
owner rules, and money facts — the hard boundary forbids moving any of those to the repo doc. The
only safe mechanical yield left was the small overlap of the two exhausted levers:
- **1 redundancy**: `a-red-main-ships-and-looks-fine-build-ignores-type-errors` already sits in
  `AGENTS.md:145` (auto-loads), so its `MEMORY.md` copy was pure duplication — verified with
  `git grep` before removing.
- **4 pure reference-grade** front-end/ops lines (CRM mobile cards CI-enforced, `data-portal-desktop-table`
  inert, server-component/RSC/row-twice, Railway-logs-current-deploy-only) — 4 of their targets were
  **already in `MEMORY-ARCHIVE.md`**, so removal stranded nothing.

**Result: 24,369 → 23,352 B, 1,017 B / 5 lines / 7 pointers, 167 → 160 pointers, 0 stranded, 🔴
102→97, 🔒/🥇 untouched, 0 markerless.** Headroom 31 B → 1,048 B. All 5 removed lines appended
verbatim to `MEMORY-ARCHIVE.md` under a dated `## Demoted from MEMORY.md 2026-08-25` heading (belt
and braces — every target reachable via `INDEX_FILES`).

**This is a holding action, not a fix, and the honest number to report is the ceiling, not the ask.**
1,017 B buys well under a day at the observed regrowth rate. Under 17KB remains unreachable without
deleting true facts, and pass 7's audit already proved a corpus this fresh has nothing stale to
retire. **The steady state is now explicit: this file will live near its cliff and needs a ~1KB
sweep whenever a session has the headroom to do one safely — there is no edit that makes 17KB real.**
The next genuine reduction only appears when either (a) a batch of live investigations resolves and
their detail can be demoted, or (b) a fresh crop of *repo-operating* traps accumulates and earns
another `AGENTS.md` §2.1 relocation. Neither is on hand today.

## 2026-08-25 (pass 9) — an ORPHAN is not a size problem, and the fix costs the index ZERO bytes

`repo:doctor` reports two separate memory-index defects and they pull in opposite directions.
Pass 8 fixed the size one. The other — **orphan memory files with no pointer** — looks like it
demands adding lines to `MEMORY.md`, i.e. undoing pass 8. It does not.

`scripts/repo-doctor.mjs` sets `INDEX_FILES = ["MEMORY.md", "MEMORY-ARCHIVE.md"]` (verified live at
line 704). **A pointer in the ARCHIVE clears the orphan.** Reachability and auto-loading are
different things: the archive keeps a memory findable at one hop; only `MEMORY.md` is loaded every
session. So route by where the FACT already lives:

- **Fact already in `AGENTS.md` §2.1** (any session/tooling trap relocated by pass 7) -> pointer goes
  in `MEMORY-ARCHIVE.md`. The fact auto-loads in full from `AGENTS.md` with no cliff, so an index
  line would buy nothing and cost ~130 B of the scarcest space in the system. `MEMORY.md`'s own last
  line already forbids re-adding these — **an orphan is not a licence to override that.**
- **Fact lives only in the memory file** and is live/dangerous -> it earns an index line, and the
  bytes come from a demotion elsewhere, never from the headroom.

Done this way on 2026-08-25: four traps written *after* pass 7 (`a-green-test-run-carries-no-type-
signal-at-all`, `an-exhaustive-record-does-not-gate-the-build-here`,
`git-auth-failed-can-be-the-credential-helper-going-oom`,
`postgrest-in-with-hundreds-of-ids-silently-returns-nothing`) were named in §2.1 but never pointed
at anywhere. 2,179 B appended to the archive; `MEMORY.md` measured **23,352 B before and after** —
unchanged to the byte. Orphans 4 -> 0, dangling 0, markers 97 🔴 / 2 🔒 / 1 🥇 unchanged.

**Two mechanics worth reusing.** Write the pointers with `fs.appendFileSync` (O_APPEND), never a
read-modify-write of the 190KB archive — a peer session appending concurrently cannot then be
clobbered, and this file's own rule is *merge with peers, never overwrite*. And guard the script on
re-read: abort if any target pointer already exists in either file, because a parallel session may
have fixed it between the scan and the write. Both mattered here — pass 8 was another session
running at the same time as this one.

**A heredoc is not reliable under memory pressure.** Two `cat > script <<'EOF'` calls and one
PowerShell call died with *"The paging file is too small"* (10 sessions, ~2 GB free) — the shell
never started, so the script silently did not exist and the run failed with `MODULE_NOT_FOUND`.
Write the script with the **Write tool** instead: no shell process, and it sidesteps this file's
heredoc-escaping trap at the same time. Check the shell is alive with `echo alive` before blaming
the work.

## 2026-08-26 (pass 10) — the AGENTS.md lever REOPENS whenever a session generates repo-operating traps. And 100 dual-listed pointers are NOT slack.

Pass 8 predicted the next real reduction needs "a fresh crop of *repo-operating* traps [to earn]
another `AGENTS.md` §2.1 relocation". **That is exactly what happened, and it is worth naming as a
recurring lever rather than a one-off.** A session that spends a night on CI/outage/worktree tooling
*manufactures* the raw material: find it mechanically by intersecting the slugs backticked in
`AGENTS.md` with the pointers in `MEMORY.md`.

Found at 24,386 B — **14 bytes** under the cliff, tighter than pass 8's 31. Reclaimed **268 B** by
shortening the commit-limit hook after moving its detail to `AGENTS.md` §2.1 (PR #2424): live
numbers, the `nvlddmkm` decoy, Event 2004 being the one REAL memory figure, and the off-heap ExcelJS
leak. 169 → 169 pointers, 0 lost, 103 🔴 unchanged, 🔒/🥇 untouched, original archived verbatim.

**The correction that made it worth doing at all: `AGENTS.md` was quoting 31.79 GB when the live
limit is 47.79 GB.** The index held the current number and the always-loaded repo doc held a stale
one — **the wrong way round**, since only the repo doc has no truncation cliff. When a fact exists in
both, check WHICH is stale before demoting; demoting a fresher line onto a staler one loses it.

**A shortened hook is worth more than a removed one while the PR is unmerged.** Removing the line
outright would have saved ~590 B instead of 268 B, but the fact only auto-loads from `AGENTS.md`
*after* the PR merges — and this one has preceded five machine freezes. Shorten now, remove on merge.

**100 of 168 pointers are dual-listed in `MEMORY-ARCHIVE.md`, and that is belt-and-braces from passes
4–9, NOT reclaimable slack.** Dual-listing proves only that removal would not ORPHAN the memory; it
says nothing about whether the hook should stop auto-loading. What survives in `MEMORY.md` is owner
rules, safety rules, destructive-action guards and traps — demoting those is a downgrade wearing a
compaction's clothes. **Do not run `comm -12` over the two indexes and treat the output as a work
list.** The count is large and looks like an opportunity; it is the opposite.

**Landed 24,118 B — 282 B of headroom, still a holding action.** ~550 B more is available once #2424
merges (the shortened hook can then go entirely, along with the relocated interrupted-session trap).
`repo:doctor` after: 884 files, 885 pointers, 0 orphans, 0 broken.

## 2026-08-26 (pass 11) — the relocation lever paid out exactly as predicted. Archive BEFORE cutting is not ceremony.

Pass 10 shortened the commit-limit hook to a signpost and predicted ~550 B more once PR #2424 merged.
It merged as `839e4248` at 21:07 Cairo; pass 11 removed both relocated hooks and reclaimed **exactly
550 B** (24,118 -> 23,568; headroom 282 -> 832 B). 169 -> 167 pointers, 103 -> 101 red markers, both
drops intentional, 0 pointers lost, lock/gold untouched. `repo:doctor`: 884 files, 885 pointers,
0 orphans, 0 broken.

**Verify the relocation target on MAIN before cutting the index line — not the worktree, not the PR
diff.** Pass 11 fetched `AGENTS.md` at the merge SHA and grepped for all seven relocated facts
(`47.79`, `nvlddmkm`, `ExcelJS`, `0xC00001AD`, `Event 2004`, `BREAK-`, `Read the limit`) before
touching `MEMORY.md`. A hook removed against an unmerged PR is a fact that reaches nobody.

**The two candidates were NOT equally safe, and the difference was invisible without checking.** The
commit-limit pointer was already in `MEMORY-ARCHIVE.md` twice; the interrupted-session pointer was
there **zero** times. Removing the second without archiving it first would have orphaned its memory
file — the exact failure the 194-orphan sweep exists to prevent. `grep -c <filename> MEMORY-ARCHIVE.md`
per candidate, every time; dual-listing is a property of individual lines, never of a batch.

**The lever is now empty again.** Nothing else in the index is duplicated in `AGENTS.md`. The next
reduction needs another crop of repo-operating traps to earn a §2.1 relocation, or a batch of
investigations to resolve. 832 B is roughly two lines of slack, not a licence to stop watching.

## 2026-08-26 (pass 13) — the tail lever is SPENT; relocation needs a pointer or it orphans the file

Pass 12 trimmed tails that same morning and got **425 B** (23,568 → 23,143). By evening the index was
**24,323 B — 77 bytes from the cliff.** So the tail lever is not merely low-yield, it is spent: pass 12
had already curated exactly the lines a fresh session picks as "obviously too long", and what it left
behind is load-bearing. Do not open a pass by re-reading the longest lines and reaching for the prose.

**Measure the composition first — it names the lever for you.** At 24,323 B: filenames + `](…)` syntax
**9,739 B (40%)**, label text **6,275 B (25.8%, avg 35.5)**, everything else **8,309 B (34.2%)**. The
"everything else" share had grown from the ~17% recorded in pass 3 while unique pointers *fell* 183 →
174. That shape — pointers down, bytes up — is the signature of peer sessions appending prose to
existing lines, and it is what tells you the growth is not new knowledge.

**What pass 13 actually did: 24,323 → 20,814 B (−3,509), 174 → 148 unique pointers, 0 lost.**
Twenty pointers demoted as reference-grade subsystem detail (cron/Healthchecks mechanism, Office
re-run internals, iReports360, Maps/geocoding, portal responsive internals, `sharp`, audit coverage),
and six agent-operating traps relocated to `AGENTS.md` §2.1. Every owner rule, safety rule and
destructive-action guard was tested line by line and **kept inline** — mixed lines were split, guard
staying, reference hooks leaving, original archived verbatim.

**The relocation pattern that is actually safe — and the trap in it.** `repo-doctor.mjs` sets
`INDEX_FILES = ["MEMORY.md", "MEMORY-ARCHIVE.md"]` and **does not read `AGENTS.md`.** So moving a
trap's fact into §2.1 and deleting its index line **orphans the memory file** — invisible, exactly the
failure §5 describes. It has already happened once: the 2026-08-25 archive section "the pointers that
were never written" exists to clean up four files named in §2.1 with no pointer anywhere. Always do
both halves:

1. fact → `AGENTS.md` §2.1, re-derived from the memory FILE (never paraphrased from the index label);
2. pointer → `MEMORY-ARCHIVE.md`, which costs the index **zero bytes** and clears the orphan.

**Peer append rate, measured tonight: 573 B in ~20 minutes** — while this session was editing
`AGENTS.md` between its own two writes. A peer added a 🔒 golden rule and rewrote the weekly-organogram
line's evidence. Both survived, because the write was gated on a byte-for-byte comparison against a
snapshot taken at the start (abort-on-drift, content-anchored splices, never line numbers). The
"~3KB/day" figure in pass 4 is a daily average, not a rate you can plan a two-step edit around: assume
the file moves under you *within a single pass* and re-read immediately before every write.

**`repo:doctor` orphans are not always yours, and one may be an OWNER RULE from today.** Verifying this
pass surfaced 4 orphans, all written by peer sessions the same day, none from the demotion. One was
`venue-validation-rule-gps-photo-then-code-or-licence` — an owner rule dated 2026-08-26 and already
enforced in production by #2434, with no pointer anywhere. **Triage an orphan by what it IS, not by
where it turned up:** the owner rule went into `MEMORY.md` proper, the "every automated email also
pings his Telegram" one was folded onto the existing Email line because it changes what that NEVER rule
costs, the TypeScript one went to §2.1 as a tooling trap, and the reference-grade board went to the
archive. Adopting them cost the index **505 B** and is worth it — an invisible owner rule is the exact
harm the index exists to prevent.

**Where it landed, honestly: 21,892 B** — 20,814 from this pass, **+573 peer growth, +505 orphan
adoption**. Not the ~20KB asked for, and the gap is not slack that was missed. Headroom **2,508 B**.

**The next pass cannot be mechanical.** After this one, every line in the top of the file by prose
weight is an owner rule, a money guard or a destructive-action guard: the vacation-balance line, the
Head Office golden rule, venue validation, the attendance agent's never-launch-a-2nd, `NEVER raw-SQL`,
`rotate NOTHING`, `NEVER rotate with ALTER ROLE`, "post NOTHING until he says", "Ask him before the
first real one". Pass 5 predicted this and pass 13 confirms it: **the remaining lever is retirement —
deciding what is no longer true and deleting it — which is the owner's call, not a mechanical one.**
Say that plainly rather than proposing another cosmetic pass. See
[[staleness-sweeps-scoped-by-topic-miss-the-dangerous-ones]] for how to run that decision by CLAIM.

## 2026-08-27 (pass 14) — one mechanical lever DID remain: bold that wraps a whole link. 276 B, zero facts touched.

Pass 13 closed with *"the next pass cannot be mechanical."* **That was very nearly right and still
wrong by one lever.** `AGENTS.md` §2.2 lists bold as worth 4 bytes a pair but says to spend it last,
because bold is how the critical clause is found at a glance. **That warning is about bold on PROSE.
Bold that wraps an entire `[label](file.md)` buys no emphasis at all** — a link is already visually
distinct — so removing only those is a formatting-only change with no scanability cost.

**Measured: 69 link-wrapping pairs, 24,208 → 23,932 B (−276), headroom 192 → 468 B.** Every
structural count identical across the edit: 164 links, 102 🔴, 4 🔒, 1 🥇, 1 wiki-link, 121 lines, 0
CRLF, 0 dead links. Prose bold survived untouched (`**78% of the weekly table**`, `**only the line
separates them.**`, `**VALUE**`). The regex is `\*\*(\[[^\]]*\]\([^)]*\))\*\*` → `$1`; the `[^\]]`
class is what keeps it off `[**Monthly Closing** = the ONLY truth](…)`, where the bold is *inside*
the label and genuinely emphasises.

**This is small and it is the last of its kind — do not read it as "mechanical levers are back".**
276 B is under half a pass-11 yield. Pass 13's conclusion stands for everything else.

### The em-dash lever CORRUPTS FACTS inside backticks. This one cost a real rule.

§2.2 recommends `—` → `-` as free bytes (3 → 1). **It is free as punctuation and destructive inside
backticks, where the character IS the fact**, and nothing in the recommendation says so.

A compaction pass at 11:50 on 2026-08-27 took the index 24,235 → 24,208 B. Of those 27 bytes, 25 came
from rewording line 3 and **2 came from converting the last remaining em-dash — which sat inside
backticks on the Head Office line, reading `` `—` not `·` ``.** The source memory
[[head-office-sales-are-absent-from-phx-monthly-achievement]] is explicit: *"Show `—` for
value/target/achievement, and keep `·` meaning a genuine zero; the two marks must never be
interchangeable."* After the pass the index told every session to render Head Office rows with a
hyphen. Restored the same day, +2 B.

**How to apply.**
- **Never punctuation-normalise across a backticked span.** Split the line on `` ` `` and transform
  only the odd-indexed (outside-code) segments. The same applies to `·`, `→`, `≠` and quote
  characters — this index uses several of them as *data*.
- **A byte-count check cannot catch this.** Pass 14's own counter reported all structural counts
  identical while the character was wrong, because a link/marker/line census does not look inside a
  label. Audit the diff for changed characters inside backticks specifically.
- **Two bytes is never worth a fact.** The em-dash lever was already spent (102 converted, 1 left) —
  the pass reached for the single remaining one and that one was load-bearing. When a lever is down
  to its last instance, the remaining instance is usually the exception, not the leftover.
- Sibling failure to [[optional-field-written-unconditionally-is-a-silent-erase]]: a mechanical
  rewrite applied uniformly across a field that had a meaningful value.

## Measurement #4 — 2026-09-01: the floor FELL, and the composition inverted

**A relocation lowers the floor. Only an addition raises it.** This file said for three measurements
that the floor *"rises every time a memory is added"* — true, but incomplete, and the incomplete half
was the one being acted on. On 2026-09-01 the index went from **218 links to 114** because ~27 hooks
were relocated into `AGENTS.md` §2.1/§2.3/§4/§4.1 (which auto-loads in full and has no cliff of its
own). Filenames + `[]()` syntax fell **11,170 → 6,228**, and the whole index fell **21,991 → 18,975**.
That is the largest single move ever made on this file, and no editing pass came close to it.

**The composition has inverted, and that matters for which lever to reach for next:**

| | pass #3 (08-22) | pass #4 (09-01) |
| --- | --- | --- |
| filenames + syntax | 11,170 | 6,228 |
| trailing prose | ~1,900 | 5,653 |
| ratio | filenames 5.9× prose | **near parity** |

At pass #3 the file was overwhelmingly filenames, so "the floor is structural" was the whole story.
It is no longer: **prose is now nearly as expensive as filenames.** Do not quote the old 11.2KB
figure — the frontmatter carried it for four days after it stopped being true.

**But that prose is not slack, and a third pass on 2026-09-01 was declined for this reason.** The
09-01 wording trim (archived in `MEMORY-ARCHIVE.md` under *"Index caveats trimmed 2026-09-01"*)
already took every date, PR number, cron id and enumeration out of the tails. A mechanical re-scan
the same day found **only seven dates surviving anywhere outside a filename, and every one is the
mechanism rather than provenance**: the boundary date that decides which salary table to query
(`canonical starts 08-01`), the window of prod changes not to undo (`08-10→08-19`), the date
`au.line_area_map` history begins (`07-13`), the 20-day App Review clock, the `08-29` fixes that
gate a rollback pre-image, and the owner's own rule number `#2015`. Cutting any of those changes an
answer.

**So the practical floor today is ~18,975, not the ~9,849 arithmetic allows.** The arithmetic floor
(every label cut to 25 bytes, every tail deleted) is real but unreachable for the same reason it
always was: labels bought below ~35 bytes stop being recognisable, and the tails that remain are
owner rules and safety rules, which this file already warns were over-cut once and had to be
restored.

**State when measured:** 18,975 bytes against a 21,500-byte budget and the 24,400-byte silent cliff —
**2,525 bytes of budget headroom and 5,425 below the cliff.** That is the healthiest this index has
ever been measured, better than pass #2 (20.7KB) and pass #3 (21.3KB). **A file with headroom does
not need a pass.** If it is asked for again, measure first and quote these numbers before cutting
anything.

**The lever that worked is relocation, not editing** — and it is now spent. All 27 relocatable hooks
are in `AGENTS.md`, and `scripts/memory-index-reachability.mjs` pins them there: a slug removed from
`AGENTS.md` orphans its memory unless `MEMORY.md` re-links it. There is no third store to move to.
The next real reduction requires **retiring a resolved memory**, which is an owner decision, not a
compaction decision.
