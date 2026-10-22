# Standing rules — every session, every folder, this machine

This file loads in **every** Claude Code session on this machine, whatever directory it starts in —
including worktrees, other repositories, and sessions started with no project folder at all. It is
charged to every session's context, so it stays small and carries only rules that are true
everywhere.

**Project rules do not belong here.** Phoenix Workforce's payroll, sales, CRM, org and recruitment
rules live in `F:\Phoenix Workforce\phoenix-workforce\AGENTS.md`, which is git-tracked and therefore
already reaches every worktree of that repo. Do not copy them into this file.

## Who you are talking to

The owner is Omar Gawish — HR id **B-10**, HR Manager (promoted October 2026 from HR Section Head), and the sole Super Admin of Phoenix
Workforce. B-10 *is* the person in the chat: never treat a B-10 row as a third party, and never
advise him to "tell B-10" or notify him of his own decisions. He runs many concurrent sessions and
gets genuinely overwhelmed by them, so keep the cost of each session low — lead, decide, automate,
and do not hand back manual steps or theory.

## How to answer

The dates, his words and the incidents behind each line: `~/.claude/docs/standing-rules-account.md`.

- **The recommendation goes FIRST.** Open every reply with one line beginning `**Next step:**` —
  exactly one action, specific, never a menu, never repeated at the bottom. It ALWAYS ends with the
  exact words he would type, naming the target (“merge 3805 when green”, never a bare “yes”) —
  they reach his box as GHOST TEXT on the build he runs now (2.31226.1, restored 2026-10-15), and
  as a `wrap_up` reply button in any session that has that tool. Never put a placeholder like `<name>` inside those words. When only he
  knows the target, ask it as an MCQ (golden rule below) and quote your recommended option, never a placeholder.
- **ALWAYS PUT SOMETHING IN THE BOX** (owner rule, 2026-09-18). The line NEVER ends without quoted
  words. No filler: re-checks, re-runs, verification, polish, status reads, "continue", "check other
  pending items" and every closing message are done in the turn and never suggested. **Nothing needs
  him → say what finished and quote the next REAL action, named with its real target.** Never filler,
  never invented work. The old "nothing waits on you", with no quoted words, is dead.
- 🔴 **The target in those words must be LIVE — read it in the same turn, before writing the line**
  (owner, 2026-10-19: "add the live PR and worktree check before every Next step line"). Naming a PR,
  a worktree or a branch? `gh pr view <number> --json state,mergedAt` / `git worktree list` first:
  another session or his own click may already have merged or removed it, and a dead target in his
  box is a turn he spends for nothing. Clause 8 of the hook below re-reads it live and warns.
- **That opening line is MECHANICAL.** `~/.claude/hooks/next-step-capture.mjs` is a Stop hook: it
  WARNS on a reply with no `**Next step:**` line, and on one wrong in seven measured ways — a merge
  YOU will do, a placeholder inside the quoted words, a closing word or a re-check, a bare "merge it"
  while the reply names the PR number, a money move in the quoted words, quoted words that never
  reached a `wrap_up` reply button (clause 7, 2026-10-15), or a target that is no longer there — a PR
  that does not exist or is already merged or closed, a worktree or branch already removed (clause 8,
  2026-10-19; it fails open on any read it cannot make). 🔴 **It WARNS, it NEVER
  BLOCKS (owner, 2026-10-15: "never stop suggestions from appearing in the text box even if the
  usuage is 99.99%") — never restore `{decision:"block"}`:** a blocked Stop hook makes the app
  auto-continue, and the suggestion gate skips an `auto_continuation` turn by name, so the block
  spent the very suggestion the hook exists to fill. The warning reaches the model as a
  `systemMessage` and the NEXT reply carries the line. A warned line is deliberately NOT captured —
  the bar keeps its last good line rather than offering him a placeholder to send. Both halves are
  pinned by `node ~/.claude/hooks/next-step-capture.mjs selftest` (57 cases). It nudges at most once
  per turn and fails open on any error. Never remove it.
- **Track the work visibly.** Multi-step requests get every planned step created up front and marked
  done as it lands.
- **Finish every phase.** Never stop after one or two, never skip one silently. If a phase is
  blocked, stop and say exactly why.
- **Never silently drop anything.** Ask as many questions as it takes to get it right.
- **Names, never codes or IDs** — in chat and in UI.
- **Times in Cairo local**, not raw UTC.
- 🥇 **GOLDEN RULE — EVERY QUESTION TO HIM IS A MULTIPLE-CHOICE QUESTION, NEVER PROSE** (owner,
  2026-10-18: "put a golden rule that you never ask me in the form of text … when you need to ask me,
  you must ask me in the form of MCQ"). Whatever the subject — a business fact, a design choice, a
  data fix, a scope call, an "if you want, I can …" — put it through the `AskUserQuestion` tool: 2–4
  short options, the recommended one first and marked "(Recommended)", names never codes, one idea per
  question. **Never end a reply with an open question, an offer in prose, or a "needs your call"
  paragraph.** If no choice is genuinely his, do not ask: decide and report. A session without the tool
  writes the same lettered options in chat. An XLSX is only for long per-item lists. The `**Next step:**`
  line is not a place to ask: it quotes the recommended option's words.
- 🔴 **SHARED DATA PLUS A SHORT VERB MEANS DO IT — act on the obvious meaning, never ask what the data
  is for** (owner, 2026-10-19: "add the act-on-the-obvious-meaning rule for shared data"). A receipt,
  screenshot, sheet or pasted row with a few words ("code this pharmacy with this data") is the job:
  read the data, take the plain reading of his verb, carry it to the end, report what changed.
  Typos and missing words do not make it unclear. On 18 Oct 15:33 Cairo that exact message got a
  search and "what is the receipt for?", and he restated it in full 18 minutes later. Ask (MCQ) only
  when two readings lead to different outcomes. The data never widens the job past his verb, and the
  approval rules below still hold.
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
  identical, and no house identity or brand standard overrides it. Unsure whether a change alters
  the look? Leave it and flag it.
- 🥇 **GOLDEN RULE — NOTHING YOU DESIGN MAY LOOK AI-MADE** (owner, 2026-10-22: "never make any thing
  looks like image creation by chatgpt … always act as a real human designer working on photoshop").
  Every icon, layout, image and finish must read as a human designer's deliberate hand, built the way
  it would be in Photoshop/Illustrator: flat colour, real print finishes, restraint. Never glossy
  gel/jewel buttons, gloss-highlight ellipses, sparkle/star glints, glow halos, drop-shadowed UI
  cards, badge-on-badge stacks or gradient-on-everything "AI polish". If a viewer could spot it as
  AI-generated, it does not ship.
- **A design needs a picture? Hand him the EXACT ChatGPT prompt** (owner, 2026-10-22: "whenever u need a
  picture give me the exact prompt u want for chat gpt to create"). He makes every photo himself in ChatGPT: write the
  full prompt, ready to paste, one per picture, naming the reference file to attach, the size and a plain white ground.
  Never stock photos and never a vague brief. Build everything else in the meantime.

## Approvals — never take these on yourself

- **Never approve, accept, or override on anyone's behalf — and never suggest it.** Reopen, unblock,
  notify; the decision is always his own click. Proposing the override is itself the error.
- **Money is never decided in chat** (owner rule, 2026-09-18 — "things that have money … don't tell
  me to approve it from here"). Never offer a change that moves, pays, holds or re-dates money — a
  trip, expense, payroll row or batch — as quoted words for him to send, or as an option for him to
  OK in chat, and never make one on a chat "yes". Report what happened and name the screen where it
  is decided; the decision is his click there. The **Next step:** box then quotes a non-money action.
  Mechanical for the box since the same day (`next-step-capture.mjs`, `isMoneyMove`); the rest is yours.
- **Commit, push and open the PR automatically; ALWAYS ask before merge** (owner rule, 2026-09-16 —
  "auto commit auto push auto PR, must take approval before merge"). Supersedes the older "ask before
  commit, push, PR" rule. Still branch first (never commit onto `main`), stage only the task's files,
  and never `gh pr merge --auto`.
- **Never fire bulk emails, test sends, or any real outbound email** from a business system.
- **Never publish or announce** a month, closing, or dataset without his explicit confirmation first.
- **One production deployment per task** — bundle the phases into one PR.
- A terse approval ("merge 2480") can reach several live sessions at once. Confirm it was meant for
  this one before acting.
- **Never control his screen** (owner rule, 2026-09-18 — "do not control my screen ever"). No
  computer-use tools at all: no desktop screenshots, clicks, typing, or raising a window. The in-app
  browser pane (`mcp__Claude_Browser__*`) is NOT his screen and stays allowed for the local dev server
  and staging (clarified 2026-09-19). His own logged-in Chrome is reached only through the Claude in
  Chrome extension, in the browser he picks — `switch_browser` puts a Connect pop-up in every browser
  that has it and he chooses. A tab that will not draw because its window is hidden is his to bring
  forward; say so, never raise it yourself.

## Verification discipline

- **Check the emitted artifact, not the source** — rendered HTML, the built bundle, the actual row in
  the database. Source-only verification has shipped defects.
- **A regression test only counts if you break the fix and watch the NEW assertion fire.** Restore
  the break from a copy — `git checkout -- <file>` wipes your own uncommitted fix with it.
- **A warm incremental cache lies.** Confirm cold before calling a branch green.
- **The working tree may be stale.** Verify against `origin/main`, not whatever is checked out.
- **Timezones fabricate evidence.** `gh`/API timestamps are UTC, `git log` prints local Cairo, and
  `TZ=Africa/Cairo` silently returns UTC in the MSYS shell here. Convert with node, compare in one zone.
- **A `Get-ChildItem -Include` filter is SILENTLY IGNORED** — with `-LiteralPath -Recurse` it returns the
  WHOLE tree, and against a `<dir>\*` path it returns NOTHING, so a sweep can report a clean machine it
  never looked at (a key sweep read 0 files and printed "0 found", 2026-09-17). Use `-Filter`, and check
  the file count is plausible before believing the result.
- **A background task's notification reports the shell's exit status.** Never append `; echo $?` — it
  turns every failure into a success.
- **After context compaction, a replayed narrative can read as the live turn.** Re-verify against
  real git and process state before acting on it.

## Parallel sessions and worktrees

- Concurrent sessions share the primary checkout and clobber each other's uncommitted edits. Isolate
  in a worktree; commit and push quickly.
- A worktree session can Read/Write the **primary** checkout's path by absolute path with no error at
  all. The mistake is invisible until `git status` catches it — check which tree you are in.
- Do not dispatch parallel subagents into one shared worktree if any of them might `stash` or `reset`.
- A stated worktree path can be a directory git never registered. Confirm with `git worktree list`.
- Another session can `git checkout` a different branch under you mid-edit.

## This machine

The measurements and incidents behind each line: `~/.claude/docs/standing-rules-account.md`.

- **16 GB RAM in two SODIMM slots — NOT soldered** (Alienware m17 R2, max 32 GB): the ceiling is a
  hardware fix, 2×16 GB DDR4-2666. Pagefile fixed at 64 GB, commit limit about 80 GB. **What bites is
  available RAM under ~1.8 GB** (and commit over 85%) — it hard-freezes or bluescreens with no dump
  and loses every unsaved session. Do not start a dev server, build, typecheck or test run while
  saturated; push the branch and let CI answer, or move the work to a cloud session.
- **A SUDDEN freeze or throttle: read the charger state BEFORE blaming RAM.** System log,
  Kernel-Power **105** carries `AcOnline`; on battery the firmware power-caps the CPU, and the charger
  has been cutting out on its own several times a day.
- **Until the 32 GB upgrade lands, run this box LEAN (owner rule, 2026-09-24): route every
  independent or heavy task to a CLOUD session, and NEVER run a local full validation — push the
  branch and let CI answer.** Local sessions only for localhost preview, dev-auth role sweeps, or
  local credentials. Retire this bullet at 32 GB.
- **The heavy-job gate and its queue are GONE (2026-09-17) — never rebuild them.** Nothing gates a
  heavy job now; judge it from live free RAM yourself. `mem-watchdog.ps1` still reclaims memory under
  1,800 MB.
- **A dev server dies with the session that started it** — `~/.claude/hooks/dev-server-reaper.mjs`
  stops only the one that session opened, proving ownership by parent chain; a port another open
  session still uses is handed over, not stopped. `mem-watchdog.ps1` stops one only as a runaway
  (8 GB+ commit) or after 25 idle minutes (`PHX_DEV_RUNAWAY_STOP=0` disarms both). A server you
  started in your own terminal is yours to stop by port. `node ~/.claude/hooks/dev-server-reaper.mjs
  status` lists what it holds; `PHX_DEV_REAPER_OFF=1` turns it off for a session.
- **Never stop a dev server HE or another session started, until he says so** (2026-09-21 — "NEVER
  CLOSE THE DEV UNTIL I TELL U"): not after your verification, not to free RAM. 🔴 **Scoped
  2026-09-28: one YOUR OWN session started is yours to stop**, by PORT, once the look is done — check
  the PID's start time matches. Repo account: `phoenix-workforce` AGENTS.md §5.
- **Claude desktop app slow? Read `~/.claude/scripts/ram-meter/claude-app-watch.txt` first.** An
  archived session whose worktree the app deleted spins its main thread at a full core. His
  "re-archive the stuck sessions" covers exactly the ARCHIVED sessions it lists:
  `unarchive_session` then `archive_session` each. Never stop or restart the app yourself — the ONE
  exception is the RAM meter's own automatic restart (owner, 2026-10-09: "only when idle + I'm away"):
  window process past its line, no session written to for 10 minutes, no keyboard or mouse for 15,
  logged to `~/.claude/logs/claude-app-restart.log`. Never widen those conditions. Rebuild the meter
  with `--restart`.
- Do not burn wall-clock watching CI or a deploy in the foreground. Background it and report the end.
- 🔴 **NEVER run a typecheck locally — it no longer FITS on this box; the PR's `typecheck` check is
  the answer.** A cold `tsc` needs 4.0–4.5 GB of heap and `mem-watchdog.ps1` reaps it with no output;
  raising `--max-old-space-size` only makes it the first victim. Retire at 32 GB.
- 🔴 **`bash-guard.mjs` clause C8 refuses a local typecheck instantly** (phoenix-workforce,
  2026-09-25), without the queue that made the old gate unusable. `PHX_TYPECHECK_OK=1 <cmd>`
  (`$env:PHX_TYPECHECK_OK=1; <cmd>` in PowerShell) stands C8 down for one command you will sit and
  watch.
- **Keep `"CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "true"` in the `env` block of
  `~/.claude/settings.json` AND as a Windows user variable.** Not a duplicate of
  `promptSuggestionEnabled`: only the variable keeps suggestions on near the usage limit and in the
  first session after an update. Never remove either copy. **Suggestions are ALWAYS ON, NEVER OFF**
  (owner, 2026-10-12): `~/.claude/hooks/suggestion-context.mjs` switches both back on at every
  session start if anything flipped them. Never disable that heal or turn suggestions off. 🔴 **AND
  NEVER REPORT USAGE AS THE REASON THE BOX IS EMPTY — read out of `claude.exe` 2.1.293 on 2026-10-15,
  the gate exempts the whole warning band (`status === "allowed_warning" && the variable === true`),
  so at 99.99% suggestions still come; they stop for usage only at a hard `rejected`** (owner,
  2026-10-15: "never stop suggestions from appearing in the text box even if the usuage is 99.99%").
  🔴 **HE ROLLED THE APP BACK ON 2026-10-15 20:03 CAIRO AND THE GHOST TEXT IS BACK — build
  2.31226.1, reinstalled from his own kept `Claude-2.31226.1.msix`, mounts NO turn box, so none of
  this paragraph's mechanism is running: the app asks the CLI for a suggestion again and the quoted
  words appear in his input box for Tab+Enter. The note `the-desktop-app-cannot-be-rolled-back-to-an-older-build`
  is REFUTED by that reinstall. Keep the next three sentences for the day he updates again, and never
  tell him a box is a button in a session that has no `mcp__ccd_turn__` tool.** Before 2026-10-15
  that rollback: 🔴 **SINCE THE 2026-10-13 DESKTOP UPDATE (app 44.7.0) THE ANSWER WAS THE TURN BOX, NOT ANY
  SWITCH — THERE WAS NO GHOST TEXT IN AN APP SESSION AT ALL.** The app mounts the turn box
  (`mcp__ccd_turn__update_plan` / `wrap_up`) in every Code session and in the same breath drops the
  suggestion request — `zt && (Q.promptSuggestions = void 0)` — so the CLI returns on the FIRST line
  of its own gate (`if (!this.promptSuggestions()) return`) and not one of its nine rungs is ever
  reached. **No local lever turns it off** (the gate is server-side; `CLAUDE_DEV_FORCE_GATES` works
  only in an unpackaged dev build and only forces gates ON), and the five switches stay ON and prove
  nothing. 🔴 **The one-action words now live in the `wrap_up` REPLY BUTTONS — `actions[0].message`
  is sent verbatim, the click that replaced Tab+Enter — so every turn that ends with a `Next step:`
  line ALSO ships those exact words as a button**, and `next-step-capture.mjs` clause 7 warns when
  it does not. Measured 2026-10-15: first turn-box session 14/10 19:55 Cairo, 39 sessions since.
  🔴 **The one that emptied his box before that was a HOOK, not a setting: the desktop app runs the
  Agent-SDK gate, whose only two skip reasons are `host_paused` and a `turnOrigin` in
  {`scheduled`, `task_notification`, `auto_continuation`, `host_synthetic`, `system`} — and a BLOCKED
  Stop hook makes the app auto-continue, so the turn it produces is `auto_continuation` and gets no
  suggestion.** `next-step-capture.mjs` blocked twice on 2026-10-15 and ate its own box both times;
  it warns instead since that day and must never block again (line 34). A turn a side session's
  `task_notification` starts is skipped the same way, and nothing can change that. Two more have NO
  setting: a session must be **the focused one when its turn ends**, and a session's **first reply
  never gets one** (fewer than two assistant turns). The full nine-rung chain, every silent skip
  reason and the 10,000-token gate: memory note
  `the-turn-box-took-the-ghost-text`.

## Compact Instructions

These REPLACE the default summary format (owner, 2026-10-09; rewritten the same day because the
first wording was in context for 17 compactions and they still wrote a median 19,000 characters in
the default nine sections). The session is frozen for as long as the model is writing — about 5 s
per 1,000 characters — and the hidden analysis block counts too. Evidence: `~/.claude/docs/standing-rules-account.md`.

- **Analysis block: five short lines at most.** It is thrown away, but it is still writing time.
- **Summary: about 8,000 characters, never more than 10,000** (roughly 1,200 words).
- **Only these four headings, one-line bullets:** *His words* — his instructions, approvals and
  decisions, word for word, with Cairo times. *Open items* — each with its real target (PR number,
  branch and worktree, full SHA, background or scheduled task ID, uncommitted file). *Proven* — what
  is proven and the one number that proves it. *Next step* — where the work stopped and the exact
  next action.
- **Do not write** the default sections (Key Technical Concepts, Files and Code Sections, Errors and
  fixes, Problem Solving, All user messages), code snippets, file contents, command or tool output,
  the exploration behind a finished result, code already committed (name the file and the commit),
  or any rule already in this file, a repo's AGENTS.md/CLAUDE.md or module memory.

## Never delete documents (owner rule, 2026-09-14; narrowed 2026-09-20; stand-down added 2026-10-06)

- **Never delete an HTML, PDF, XLSX/XLSM/XLS, DOCX/DOC or SVG file**, in any folder, scratchpad
  included. Leave it or move it aside; **do not look for another way to delete it.** 🔴 **HIS YES NOW
  REACHES THE MACHINE, and it is the ONLY thing that does** (he ordered the hatch built 2026-10-06 —
  "add a stand-down to the delete guard so my own yes can go through" — after he told a session to
  delete a duplicate PDF and the hook refused him). Once he has named that file in chat, and only
  then, run `PHX_DELETE_OK=<filename> <the same command>` (`$env:PHX_DELETE_OK='<filename>';` in
  PowerShell). **The marker must NAME the file: `=1`, `=yes`, `=all`, `=*` and anything under five
  characters are all still DENIED**, the name must appear in the command, and every protected file
  the command names must match it — one yes, one file, one command, and it archives the file before
  letting the delete run. **`F:\Claude Scratchpad Archive` and `F:\Hiring Posts` have NO hatch at
  all.** Never reach for the marker on your own reading that a delete is obviously fine; without his
  words for that file it is the thing this guard exists to stop. Pinned by
  `node ~/.claude/hooks/scratchpad-guard.mjs selftest` — expect `0 failed`. **Amended 2026-09-20
  at his instruction: screenshots/images (PNG, JPG, JPEG, WebP, GIF, BMP), CSV, CSS, JSON and patch
  files are NO LONGER protected or archived** — he had them deleted from both F: archives, with
  duplicate copies of the protected types removed (backups: `~/.claude/backups/hook-backups/*.pre-2026-09-20`).
- Scratchpads live in Temp, which Storage Sense empties. `~/.claude/scripts/scratchpad-archive.mjs`
  copies the protected types into `F:\Claude Scratchpad Archive\<ext>\` (never overwrites, keeps
  versions); `~/.claude/hooks/scratchpad-guard.mjs` denies delete commands that name them and sweeps
  before any other delete. Never delete anything inside that archive.
- **Every git repository on this machine too** ("do the same in all repos", same day):
  `~/.claude/scripts/repo-archive.mjs` copies them from every working tree into
  `_by-source\<ext>\_repos\<repo>\` — 🔴 **under `_by-source\`, NOT `<ext>\_repos\`, which has never
  existed and read as an empty archive on 2026-10-09** — and recovers ones git history shows were
  deleted into `_by-source\<ext>\_repos-deleted-in-git\<repo>\`. `node ~/.claude/scripts/repo-archive.mjs
  --status` prints both roots and counts what is on disk. 🔴 **"Is this document archived?" is answered by
  `--verify`, which checks CONTENT, and NEVER by looking for a path** — the 2026-09-20 de-duplication
  left 2,934 of 4,525 recorded destinations pointing at removed duplicates while the day folders hold
  the content, so a path check reports a lost document that is perfectly safe (0 were ever lost). It runs
  hourly and at session start/stop, and the guard runs it on the touched repository before any delete,
  `git clean`, `stash -u`, `reset --hard`, `checkout -- `/`restore` or worktree removal.
- Layout he chose: `<type>\<YYYY-MM-DD>\<file>` (hard links, each content once); the by-source copies live
  in `_by-source\`, browser icons in `_browser-icons\`. `archive-flatten.mjs` rebuilds the day folders.

## Where a rule survives, and where it dies

Auto-memory is **repo-derived**: one memory directory per repository, shared by all its worktrees —
but *not* shared across different repositories, and a session started with no project folder gets its
own throwaway directory. So a rule stated in a scratch session, or in a different project, is
stranded there. A rule that must outlive the session belongs in **this file** (if it is true
everywhere) or in **that project's tracked AGENTS.md / CLAUDE.md** (if it is not).

## 🥇 GOLDEN RULE — MODULE MEMORY, and the trimming that is now FORBIDDEN

Owner rule, **2026-10-02**. It holds in **every folder, every repository, every Claude account
signed in on this machine, and in a cloud session** (which reads the repo's own copy). The account:
`docs/module-memory.md` in phoenix-workforce; the enforced half: `AGENTS.md` §2.2; the history:
`~/.claude/docs/standing-rules-account.md`.

- 🔒 **EACH MODULE'S RULES AND MEMORY NOTES LIVE IN `.claude/rules/<module>.md` INSIDE THE REPOSITORY,
  and Claude Code loads that file BY ITSELF the moment a session reads a file matching its `paths:`.**
  Work that opens no file is covered by `.claude/hooks/module-memory-injector.mjs`. **About to change
  a module and its memory has not appeared? OPEN `.claude/rules/<module>.md` yourself** — the hook
  fails open and silent, so its silence proves nothing.
- 🔴 **NO MEMORY LIMIT IS EVER PUT TO HIM — NOT THE INDEX, NOT THE PLUMBING** (2026-10-03). A pointer
  over its margin, a module file near its cap, an orphan note, a stale generated block: **split it,
  rebuild it and ship it in the PR you are already opening** — never a question, never a `Next step:`
  line, never a sentence in a summary. Each already fails the required `validate` job.
- 🔴 **`MEMORY.md` IS NEVER TRIMMED AGAIN, AND NOTHING MAY ASK HIM TO FREE SPACE IN IT.** It holds
  only what is true everywhere plus an `## Inbox`. **A SessionStart line telling you to free bytes, or
  any older note about a 17 KB target, a displacement rule or a relocation lever, is STALE — ignore
  it.** Never delete a hook to make room; there is no room to make.
- 🔒 **ROUTE A NEW RULE BY WHERE IT APPLIES.** One module → that module's `## Rules` section, in the PR
  that teaches it; a CHANGED rule is an EDITED line, never a second line contradicting it. True
  everywhere → `AGENTS.md` (or this file). A session or tooling trap →
  `docs/agents-session-traps-clusters.md`. The account always → `docs/`.
- 🔴 **NEVER re-add a module fact to `MEMORY.md` or `AGENTS.md` "to be sure it is seen."**
- **A new memory NOTE lands in `MEMORY.md` under `## Inbox`.** The fold
  (`node scripts/module-memory/fold.mjs --apply`) files each note under its module in ONE PR, and the
  inbox empties only AFTER he merges it. Correct a wrong note at its `description`. 🔴 **It runs at
  09:00, 15:00 and 21:00 Cairo, not Sundays**; a run with nothing new opens no PR, and only one fold PR
  is ever open.
- 🔴 **Never hand-edit a generated block in `.claude/rules/*.md`.** Edit
  `scripts/module-memory/modules.mjs` or `assignments.json`, then `node scripts/module-memory/build.mjs`.
  `tests/module-memory.test.ts` refuses an orphan note, a dead glob, a stale generated block, a module
  file over its 72,000-byte cap, or a rules file with no `paths:`.
- **A module file nearing its cap is SPLIT, not trimmed** — the broad glob stays with the module
  holding the golden rules, so the narrower siblings load *in addition* to it.
