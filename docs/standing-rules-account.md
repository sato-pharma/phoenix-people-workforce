# Standing rules — the account

The full text of the sections of `~/.claude/CLAUDE.md` that were shortened on 2026-10-08, kept here
word for word: the dates, measurements, corrections and incident stories behind each rule. The rule
lines themselves stay in `CLAUDE.md`, which is charged to every session; this file is read on demand.
Nothing here overrides `CLAUDE.md` — where the two differ, `CLAUDE.md` is current.

## How to answer

- **The recommendation goes FIRST.** Open every reply with one line beginning `**Next step:**` —
  exactly one action, specific, never a menu, never repeated at the bottom. Owner rule, amended
  2026-09-07; it supersedes the older "end every reply with a next step". It ALWAYS ends with the
  exact words he would type, naming the
  target (“merge 3805 when green”, never a bare “yes”) — prompt suggestions echo it. Never put a
  placeholder like `<name>` inside those words: the suggestion echoes it verbatim and he sent one
  unfilled (2026-09-17). When only he knows the target, ask in the line and quote your recommended
  answer, never a placeholder.
- **ALWAYS PUT SOMETHING IN THE BOX** (owner rule, 2026-09-18 — his words). The line NEVER ends
  without quoted words. This amends 2026-09-15 ("it keeps me in a loop"): that rule's ban on
  filler stands in full — re-checks, re-runs, verification, polish, status reads, "continue",
  "check other pending items" and every closing message are still done in the turn and never
  suggested — but the empty outcome is retired. It left his box reading `<no suggestion>` turn
  after turn, which he watched happen and ruled against. **Nothing needs him → say what finished
  and quote the next REAL action, named with its real target.** Never filler, never invented work.
  The old "nothing waits on you", with no quoted words, is dead.
- **That opening line is MECHANICAL since 2026-09-17, not behavioral.** `~/.claude/hooks/next-step-capture.mjs`
  is a Stop hook: a reply carrying no `**Next step:**` line is BLOCKED and the model made to add it —
  any model, any effort, any permission mode. Since the same day it ALSO blocks a line that IS there and
  wrong in one of five measured ways: a merge YOU will do, a placeholder inside the quoted words, a
  closing word or a re-check, a bare "merge it" while the reply names the PR number, or (2026-09-18)
  a money move in the quoted words.
  It nudges at most once per turn (`stop_hook_active`, under the engine's own consecutive-block cap)
  and fails open on any error. Never remove it: before
  it, a missing line silently blanked the status bar and nothing corrected it.
- **The target in the quoted words must be LIVE — clause 8, 2026-10-19.** His words, after the
  usage report for 22 Aug – 18 Oct 2026 was walked through with him at ~02:30 Cairo: *"add the live
  PR and worktree check before every Next step line"*. That report put stale targets first among the
  handoff frictions: a session quoted "merge 6101 when green" for a PR that did not exist, and others
  offered to merge 6099 and remove two worktrees that another session, or his own click, had already
  handled — he sent the words back and the turn bought nothing. Two layers. BEFORE the line: the rule
  in `~/.claude/CLAUDE.md` ("How to answer") and in `hooks/task-rules.txt` rule 3 — read the PR,
  worktree or branch live in the same turn. AFTER it: `next-step-capture.mjs` clause 8 re-reads the
  quoted words' targets — a merge-family verb (merge, widen, rebase, close, roll up) makes each bare
  3–6 digit number a PR that must exist and be OPEN; an explicit `#N`/`PR N` must exist; `_wt-<task>`
  must be a registered worktree or a folder on disk; `codex/`/`claude/` branches must exist here or on
  origin. One GraphQL call answers every PR; the rest is local git. Measured live the same night:
  ~1.0–1.3 s when the words name a PR, ~0.3 s otherwise; 6102 warned "already merged (19 Oct, 01:43
  Cairo)", 99999 "does not exist", open 6105 and the live `_wt-weekly-plan-rulings` passed. It fails
  OPEN on every read it cannot make (no repo, no network, no gh auth, a timeout), because a warned line
  is not captured and a false warning would cost a real suggestion. The selftest runs it from a fixture
  (`NSC_LIVE_FIXTURE`), never the network: 57 cases, and three deliberate breaks (the clause disabled,
  an unreadable lookup treated as missing, the underscore made mandatory again — `extractNextStep`
  strips every `_`, so `_wt-x` arrives as `wt-x`) each fired their own assertions before the file was
  restored from a copy. Pre-images: `~/.claude/backups/hook-backups/*.pre-live-target-2026-10-19`.
- **Shared data plus a short verb means DO IT — 2026-10-19.** His words, ~02:45 Cairo, after the
  same usage-report walkthrough: *"add the act-on-the-obvious-meaning rule for shared data"*. The
  incident (report facet `5f26fea1`, a worktree session): on **18 Oct 2026 15:33 Cairo** he sent a
  photo of a Pharma Overseas receipt with *"code 6this pharmacy with this data"*. The session searched
  and asked what the receipt was for; at **15:51** he restated it in full — the name محمود علي محمود
  احمد, code 1549597, قرية المقاتلة مركز طامية الفيوم, "so when some one search in direct orders or
  marketing reuest can easily find it". Eighteen minutes and a retyped request, for a verb ("code
  this pharmacy") that had one plain reading in Phoenix: add it to the customer map. The rule sits
  beside the MCQ golden rule on purpose, because together they mark the line: one plain reading → act;
  two readings with different outcomes → one MCQ; never "what is this for", never a question to
  confirm the obvious reading. Two limits keep it from becoming licence: the data never widens the job
  past his verb ("fix means fix"), and every approval rule still holds — money stays on its own screen,
  nothing outbound is sent, merges and anyone else's approval stay his. Behavioural only, deliberately:
  a prompt hook cannot tell "this" pointing at a shared file from "this" pointing at the last reply, and
  `~/.claude/CLAUDE.md` already loads on every request. Pre-image:
  `~/.claude/backups/hook-backups/CLAUDE.md.pre-live-target-2026-10-19` (taken before both rules).
- **Track the work visibly.** Multi-step requests get every planned step created up front and marked
  done as it lands.
- **Finish every phase.** Never stop after one or two, never skip one silently. If a phase is
  blocked, stop and say exactly why.
- **Never silently drop anything.** Ask as many questions as it takes to get it right.
- **Names, never codes or IDs** — in chat and in UI.
- **Times in Cairo local**, not raw UTC.
- **When a business fact is uncertain, ask in chat as multiple choice** (short options, recommended
  first) — do not guess, and do not interrogate him in prose. An XLSX is only for long per-item lists;
  he could not follow paragraph-heavy question sheets (2026-09-13).
- **Report faithfully.** If tests failed, say so with output; if a step was skipped, say that. Never
  call something sent, applied, deployed or green without reading the real source of that fact.
- **Never say his work was built with AI in anything written about him** (owner rule, 2026-10-05 —
  "never ever mention that I did this platform with AI"). LinkedIn, CV, bio, post, about page, award
  or company write-up: Phoenix and his other systems are designed and built by him — no AI, agents,
  Claude, coding assistants, prompts or AI skills. Never claim he hand-wrote code either; describe
  what he owns, decides and delivers. **Nor its repairs, fixes, issues or self-audits, nor approvals,
  sign-offs, locks, releases, change counts or test/migration counts** (owner, 2026-10-06 — "wtf u
  mentioning fixes and issues and no one give approval except i"): only what it does and who uses it.
- **A design he hands you is FINAL — fix its defects, never redesign it.** "Audit/fix this" on a
  card, flyer or file means bleed, resolution, fonts, colour space, boxes, typos — the look stays
  identical, and no house identity or brand standard overrides it. A rebuilt business card cost him
  real anger on 2026-09-12. Unsure whether a change alters the look? Leave it and flag it.


## This machine

- 16 GB RAM (2×8 GB SK Hynix DDR4-2666), and it is **NOT soldered — this is an Alienware m17 R2 with
  two SODIMM slots, max 32 GB** (SMBIOS: 2 memory devices, MaxCapacity 32 GB; corrected 2026-09-24 from
  the earlier "soldered" note, which was wrong). So the RAM ceiling is a hardware fix, not only a
  fewer-sessions one: 2×16 GB DDR4-2666 SODIMM reaches 32 GB. The pagefile is fixed at 64 GB, so the
  commit limit is about 80 GB (measured 2026-09-17). The ceiling that bites is **available RAM under
  ~1.8 GB** (and
  commit charge over 85%) — it hard-freezes or bluescreens with no dump and loses every unsaved
  session. Do not start a dev server, build, typecheck or test run while saturated; push the branch and
  let CI answer, or move the work to a cloud session.
- **A SUDDEN freeze or throttle: read the charger state BEFORE blaming RAM** (2026-09-30). System log,
  Kernel-Power **105** carries `AcOnline`; on battery the firmware power-caps the CPU. On 2026-09-30 a
  battery spell plus a burst of sessions froze the box at 774 MB free, while 255 MB on AC that day did
  not. The charger cut out ON ITS OWN 3–9×/day (69 drops 16–30 Sep, 8 of them 1–64 s blips): a
  charging-path fault, charger vs the laptop's power socket not yet isolated.
- **Until the 32 GB upgrade lands, run this box LEAN by default (owner rule, 2026-09-24): route every
  independent or heavy task to a CLOUD session (Tier A), not a local one, and NEVER run a local full
  validation — push the branch and let CI answer.** Local sessions are only for work that genuinely needs
  localhost preview, dev-auth role sweeps, or local credentials. Measured 2026-09-24: 16 GB leaves ~4–5 GB
  free with the Claude app + a browser open, so a local build/typecheck/test/dev-server is what pushes it
  toward the freeze line. Retire this bullet once the machine is at 32 GB.
- **The heavy-job gate and its queue are GONE — removed 2026-09-17 at the owner's instruction, and never
  to be rebuilt.** In its last 2 days 13 hours its own log recorded 33.3 h of wall clock waiting, 20.1 h
  of which ran nothing (27 give-ups, the longest 4 h 27 m), plus 23 outright refusals, 15 of them a plain
  `tsc`: its 5,000 MB free-RAM floor is unreachable on a 16 GB box running a dozen sessions. Nothing gates
  a heavy job now — judge it from live free RAM yourself. `mem-watchdog.ps1` still reclaims memory under
  1,800 MB, and the retired originals sit in
  `~/.claude/backups/_attic-2026-09/retired-heavy-job-2026-09-17/`.
- **A dev server now dies with the session that started it — `~/.claude/hooks/dev-server-reaper.mjs`,
  live 2026-09-17.** It notes the port and the exact process a session opens (PreToolUse, plus a scan at
  SessionEnd for one it never saw) and stops that one only, proving ownership by an unbroken parent chain
  to that session's own engine: another session's server is left alone, and a port another open session
  is still using is handed to it instead of stopped. The only other thing that stops one is
  `mem-watchdog.ps1`, and only two kinds (owner, 2026-09-21): a runaway at or over 8 GB of commit, and one
  that has done no work for 25 minutes — a server in use under 8 GB is never touched, however low RAM runs
  (`PHX_DEV_RUNAWAY_STOP=0` disarms both). A server you started in your own terminal is no session's child,
  so that one is still yours to stop by port. `node ~/.claude/hooks/dev-server-reaper.mjs status` lists
  what it holds; `PHX_DEV_REAPER_OFF=1` turns it off for a session.
- **Never stop a dev server HE or another session started, until he says so** (owner rule, 2026-09-21 —
  "NEVER CLOSE THE DEV UNTIL I TELL U"). Not after your own verification, not to free RAM: he may be
  using it in the pane — a session stopped one mid-test and he had to ask for it back. Leave that stop
  to the reaper and watchdog. 🔴 **SCOPED, not repealed, on 2026-09-28** (owner — *"allow me to stop dev
  servers I start myself"*): **one YOUR OWN session started is yours to stop**, by PORT, once the look
  is done — check the PID's start time matches when you started it. Both halves hold in every folder;
  the repo-side account is `phoenix-workforce` AGENTS.md §5.
- **Claude desktop app slow? Read `~/.claude/scripts/ram-meter/claude-app-watch.txt` first** (found
  2026-09-21). App 2.2553.1 keeps watching a session's worktree after archiving it while still warm; once
  the app deletes that worktree, the watch spins its main thread at a full core (8 of them: 99%). The RAM
  meter scans every 2 minutes, notifies him with the session names, and writes that report. His "re-archive the stuck
  sessions" covers exactly the ARCHIVED sessions it lists: `unarchive_session` then `archive_session` each
  (99% → 2%, no restart). Never stop or restart the app yourself. Rebuild the meter with `--restart`.
- Do not burn wall-clock watching CI or a deploy in the foreground. Background it and report the end.
- 🔴 **NEVER run a typecheck locally — it no longer FITS on this box, and the PR's `typecheck` check is
  the answer.** This retires "run typecheck while iterating", which contradicted the LEAN rule above and
  was still costing ~24 local runs a day. Measured 2026-09-25: a cold `tsc` now needs 4.0–4.5 GB of heap
  and OOM'd at node's own 4.1 GB default after 155 s; with the Claude app holding ~4.2 GB across ~25
  processes, `mem-watchdog.ps1`'s 500 MB floor then reaps it — and **every one of the 23 node jobs it
  killed in the window its log still held was a typecheck**, not one other kind among them, each printing
  nothing so the session just ran it again. 🔴 **Corrected 2026-09-25: this said "18 killed in 3 days",
  which the log cannot support** — `mem-watchdog.ps1` truncates it to 800 lines, about a day and a half
  here, so its start date is only where the rotation fell, never the date the trouble began. Raising
  `--max-old-space-size` makes it the biggest node job and so the FIRST victim: 4096, 5120, 6144 and 7168
  were all tried and all reaped. It got slower because the repo grew — 5,065 → 6,048 `.ts/.tsx` files in
  13 days, CI's own cold run 125 s → 183 s. Push the branch; CI is cold, clean and ~3 min. Retire this
  bullet at 32 GB.
- 🔴 **What CHANGED on 2026-09-17 is that the heavy-job gate was retired, and that is why this started
  hurting two days ago on a box that has always had 16 GB.** Until then a typecheck under RAM pressure
  was REFUSED in milliseconds — its own log holds 15 `DENY tsc` lines, the last three at 20:44:36-37
  ("needs 5000 MB | available 2,321 MB"). With nothing refusing it, the same command now STARTS, runs for
  minutes, climbs to 4-4.5 GB, and is killed with no output at all — so the session reads a kill as a typo
  and tries the next spelling. **`bash-guard.mjs` clause C8 restores the instant refusal without the queue
  that made the gate unusable** (live 2026-09-25, phoenix-workforce). Never rebuild the gate or its queue;
  `PHX_TYPECHECK_OK=1 <cmd>` (`$env:PHX_TYPECHECK_OK=1; <cmd>` in PowerShell) stands C8 down for one
  command you will sit and watch.
- **Keep `"CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "true"` in the `env` block of `~/.claude/settings.json`
  AND as a Windows user variable.** He wants the Windows copy back (2026-09-17): removing it on 09-13 as a
  "duplicate" left `env | grep` in a plain terminal empty. It is not a duplicate of
  `promptSuggestionEnabled`: only the variable keeps suggestions on near the usage limit and in the first
  session after an update. An audit removed it on 2026-09-15 and he ordered it back. Never remove either copy.

## Compact Instructions

- **First wording, 2026-10-09 00:30 Cairo (owner):** "about 8,000 characters, never more than 10,000".
  Basis: 187 compactions on 6–8 Oct, 79 s under 15k characters, 175 s at 25–35k.
- **Rewritten 2026-10-09 about 06:55 Cairo (deep slowness audit), because it was being ignored.** From
  the transcripts and `~/.claude/logs/compact-summary-length.jsonl`:
  - 106 compactions in 30 hours (8 Oct 02:00 → 9 Oct 05:33), every one at about 367k tokens — the
    400,000 `autoCompactWindow` less its buffer. Sessions sat frozen 187 minutes in total. Median freeze
    59 s with a summary under 10k characters, 75 s at 10–20k, 158 s above 20k.
  - The user-level CLAUDE.md IS re-injected after every compaction (the `instructions` attachment). The
    first wording was in context for 17 of the 23 compactions after 00:30 and they still wrote a median
    of about 19,000 characters, in the built-in nine sections.
  - PostCompact's `compact_summary` is the model's WHOLE output: a hidden `<analysis>` block, stripped
    before the summary lands in the transcript, plus the summary — 400 to 11,000 characters more than
    the transcript copy. The freeze is about 5.3 s per 1,000 characters of that whole output (30 s at
    8.3k, 183 s at 34.2k).
  - The docs (code.claude.com: hooks, context-window, memory) give no way to cap the summary:
    PreCompact can only block, PostCompact cannot change the result, and since v2.1.198 the summary
    call inherits the session's thinking. The CLAUDE.md section is the only lever, and it is a request.
  - So the rewrite caps the analysis block at five lines, replaces the nine default sections with his
    four (His words, Open items, Proven, Next step) and names the default sections not to write. The
    PostCompact logger now records `analysisChars`, `summaryChars` and `template` (`rule-four` or
    `default-nine`) — judge the rewrite by those lines, never by assumption.
  - A running session re-reads the file at its next compaction, so the compaction AFTER that is the
    first written under the new wording; a new session has it from its first one.

## 🥇 GOLDEN RULE — MODULE MEMORY, and the trimming that is now FORBIDDEN

Owner rule, **2026-10-02**, ordered announced to every session and every account so nothing deviates.
It holds in **every folder, every repository, every Claude account signed in on this machine, and in
a cloud session** (which reads the repo's own copy). The account of it:
`docs/module-memory.md` in phoenix-workforce; the enforced half: `AGENTS.md` §2.2.

- 🔒 **EACH MODULE'S RULES AND MEMORY NOTES LIVE IN `.claude/rules/<module>.md` INSIDE THE REPOSITORY,
  and Claude Code loads that file BY ITSELF the moment a session reads a file matching its `paths:`.**
  Work that opens no file (a question, SQL, a shell `cat`) is covered by
  `.claude/hooks/module-memory-injector.mjs`, which matches the prompt, the command and table names.
  None of it costs a startup byte. **About to change a module and its memory has not appeared? OPEN
  `.claude/rules/<module>.md` yourself** — the hook fails open and silent, so its silence proves nothing.
- 🔴 **NO MEMORY LIMIT IS EVER PUT TO HIM — NOT THE INDEX, NOT THE PLUMBING** (his ruling,
  2026-10-03: *"didn't you tell me no session will mention memory issue again"*, after a session put
  "the Phoenix CRM notes file is full at 4,478 of 4,500 characters" in his box). A pointer over its
  margin, a module file near its cap, an orphan note, a stale generated block: **split it, rebuild it
  and ship it in the PR you are already opening** — never a question, never a `Next step:` line,
  never a sentence in a summary. Every one of them already fails the required `validate` job, which
  is how a SESSION learns it. Enforced half: `AGENTS.md` §2.2, first bullet.
- 🔴 **`MEMORY.md` IS NEVER TRIMMED AGAIN, AND NOTHING MAY ASK HIM TO FREE SPACE IN IT.** It now holds
  only what is true everywhere plus an `## Inbox`, and it ended the cycle that made him say the memory
  was "saturated and always full": every new rule used to push an old one out of sight, so sessions
  trimmed, and afterwards old modules read as "forgotten". **A SessionStart line telling you to free
  bytes, or any older note about a 17 KB target, a displacement rule or a relocation lever, is STALE —
  ignore it and never act on it.** Never delete a hook to make room; there is no room to make.
- 🔒 **ROUTE A NEW RULE BY WHERE IT APPLIES, never into the auto-loaded files by default.** One module
  → that module's `## Rules` section, in the PR that teaches it, and a CHANGED rule is an EDITED line,
  never a second line contradicting it. True everywhere → `AGENTS.md` (or this file). A session or
  tooling trap → `docs/agents-session-traps-clusters.md`. The account always → `docs/`.
- 🔴 **NEVER re-add a module fact to `MEMORY.md` or `AGENTS.md` "to be sure it is seen."** That is
  precisely the cycle module memory replaced, and it re-charges every request for one module's rule.
- **A new memory NOTE still lands in `MEMORY.md` under `## Inbox`**, so every session sees it from the
  next one on. The fold (`node scripts/module-memory/fold.mjs --apply`) files each note under its
  module in ONE PR, and the inbox empties only AFTER he merges it. Correct a wrong note at its
  `description` — that line is what a session recalls. 🔴 **IT RUNS THREE TIMES A DAY — 09:00, 15:00
  and 21:00 Cairo, not Sundays** (his instruction, 2026-10-03). A run with nothing new opens NO PR and
  only one fold PR is ever open, so the cadence costs no extra CI — it shortens the wait before a note
  reaches its module from a week to eight hours.
- 🔴 **Never hand-edit a generated block in `.claude/rules/*.md`.** Edit
  `scripts/module-memory/modules.mjs` or `assignments.json`, then `node scripts/module-memory/build.mjs`.
  `tests/module-memory.test.ts` runs `build.mjs --check` in the required `validate` job and refuses an
  orphan note, a dead glob, a stale generated block, a module file over its 72,000-byte cap, or a rules
  file with no `paths:` (that one would load at startup for everyone).
- **A module file nearing its cap is SPLIT, not trimmed** — and the broad glob stays with the module
  holding the golden rules, so the narrower siblings load *in addition* to it, never instead of it.
  Sales was the first: `sales-closing` + `sales-imports` + `sales-attribution` (2026-10-02).
