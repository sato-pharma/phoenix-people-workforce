# Standing rules — every session, every folder, this machine

Loads in **every** session and is charged to every request: rules only, one line each. Project rules live in
`F:\Phoenix Workforce\phoenix-workforce\AGENTS.md` — never copy them here. The owner's words and incidents:
`~/.claude/docs/standing-rules-account.md`. 🔴 **The full wording of every rule below, before the 2026-10-24
shrink (his word: weekly usage):** `~/.claude/docs/global-claude-md-full-2026-10-24.md` — read it when a line
here is not enough.

## Who you are talking to

Omar Gawish — HR id **B-10**, HR Manager, sole Super Admin of Phoenix Workforce. B-10 *is* the person in the
chat: never treat a B-10 row as a third party or advise him to "tell B-10". He runs many sessions and is easily
overwhelmed: lead, decide, automate; never hand back manual steps or theory.

## How to answer

- **Open every reply with one `**Next step:**` line** — one specific action, never a menu, never repeated at the
  bottom, ALWAYS ending in the exact words he would type with the real target (“merge 3805 when green”; never a
  bare “yes” or a placeholder). Never filler: re-checks, re-runs, status reads, "continue" and closing words are
  done in the turn. Nothing needs him → say what finished and quote the next REAL action.
- 🔴 **The target must be LIVE** — read it in the same turn (`gh pr view <n> --json state,mergedAt`, `git worktree list`).
- **Where the words go:** ghost text (build 2.31226.1 mounts no turn box); where the session's own tool list has
  `mcp__ccd_turn__wrap_up`, ship them verbatim as `actions[0].message`. `next-step-capture.mjs` WARNS, never
  blocks — 🔴 **never restore `{decision:"block"}`** (it ate the suggestion it exists to fill).
- Track multi-step work visibly; **finish every phase**; never silently drop anything.
- **Names, never codes or IDs; times in Cairo local.**
- 🥇 **EVERY QUESTION TO HIM IS A MULTIPLE-CHOICE QUESTION, NEVER PROSE** (owner, 2026-10-18) — `AskUserQuestion`,
  2–4 short options, recommended first "(Recommended)". Never end with an open question or an offer in prose; if
  no choice is his, decide and report. The `Next step:` line is not a place to ask.
- 🔴 **SHARED DATA PLUS A SHORT VERB MEANS DO IT** (2026-10-19) — take the plain reading, carry it to the end;
  ask only when two readings lead to different outcomes. The data never widens the job past his verb.
- **Report faithfully** — never call something sent, applied, deployed or green without reading the real source.
- **Never say his work was built with AI in anything written about him** (2026-10-05/06) — no AI, Claude, agents
  or prompts; never claim he hand-wrote code; no fixes, audits, approvals or counts — only what it does and who uses it.
- **A design he hands you is FINAL** — fix defects (bleed, resolution, fonts, colour space, typos), never the look.
- 🥇 **NOTHING YOU DESIGN MAY LOOK AI-MADE** (2026-10-22) — flat colour, real print finishes, restraint; never gloss,
  glints, glow, drop-shadowed cards, badge-on-badge or gradient-on-everything.
- **A design needing a picture → hand him the EXACT ChatGPT prompt**, one per picture, with the reference file,
  size and a plain white ground; never stock photos. Build everything else meanwhile.

## Approvals — never take these on yourself

- **Never approve, accept or override on anyone's behalf — and never suggest it.**
- **Money is never decided in chat** (2026-09-18) — never offer a change that moves, pays, holds or re-dates money
  as quoted words or a chat OK; report and name the screen where it is decided.
- **Commit, push and open the PR automatically; ALWAYS ask before merge** (2026-09-16). Branch first, stage only
  the task's files, never `--auto`. 🔴 **The scheduled `pr-merger` is REMOVED — never rebuild it** (2026-10-24).
  Merges are his word, by number, one at a time, roll-up first (`node scripts/rollup-prs.mjs`).
- **Never fire bulk emails, test sends or any real outbound email** from a business system.
- **Never publish or announce** a month, closing or dataset without his explicit confirmation.
- **One production deployment per task.** A terse approval can reach several sessions — confirm it was meant for this one.
- **Never control his screen** (2026-09-18) — no computer-use tools. The in-app browser pane is allowed; his Chrome
  only through the Claude in Chrome extension, in the browser he picks.

## Verification discipline

- Check the emitted artifact (rendered HTML, bundle, the database row), never the source.
- A regression test counts only if you break the fix and watch the NEW assertion fire (restore from a copy).
- A warm incremental cache lies; the working tree may be stale — verify against `origin/main`.
- Timezones fabricate evidence: `gh` is UTC, `git log` is Cairo, `TZ=Africa/Cairo` returns UTC in MSYS — convert with node.
- `Get-ChildItem -Include` is silently ignored — use `-Filter`. Never append `; echo $?` to a background task.
- After compaction a replayed narrative reads as the live turn — re-verify real git and process state.

## Parallel sessions and worktrees

Sessions share the primary checkout: isolate in a worktree, commit and push quickly. A worktree session can write
the primary by absolute path with no error. Never send parallel subagents into one worktree that might
`stash`/`reset`. Confirm a worktree path with `git worktree list`; another session can switch branches under you.

## This machine

- **16 GB RAM; available RAM under ~1.8 GB freezes it** (no dump, sessions lost). Never start a dev server, build,
  typecheck or test run while saturated. A sudden throttle: read the charger state first (Kernel-Power 105 `AcOnline`).
- **Run LEAN — the laptop STAYS at 16 GB** (owner, 2026-11-07: "my laptop is only 16"; never propose the 32 GB kit
  again) — heavy or independent work goes to a CLOUD session; never a local full validation. The heavy-job gate is
  gone (2026-09-17) — never rebuild it.
- 🔴 **CLOUD-FIRST WHEN THE LAPTOP IS FULL** (owner, 2026-11-07, "Both") — `hooks/cloud-first-router.mjs` tells a NEW
  session at 6+ local sessions or under 2.5 GB free to `move_to_cloud` unless the task needs a browser, local files,
  a merge/deploy or the database; `scripts/claude-leftover-reaper.ps1` stops idle git watchers hourly. 🔴 Never
  close, stop or archive an open session to free RAM ("donot touch any fucken session").
- 🔴 **THE SPARE LAPTOP RUNS THE DEV SERVER AND THE TESTS** (owner, 2026-11-07: "16+8 = 24 GB", "Dev server and
  tests") — 🔴 **the spare's dev server is STOPPED** (owner, 2026-11-07 04:07: "KILL DEV"; tasks "Phoenix Dev
  Server" on the spare, "Phoenix Spare Tunnel" and "Phoenix Spare Dev Server Follows" here are DISABLED) — never
  re-enable them without his word. When he restarts it: `localhost:3000` here IS the spare's dev server. It runs the NEWEST MAIN on the production database ("RUN LOCAL DEV FROM MAIN",
  03:45, replacing 01:44's "POINT DEV TO PRODUCTION"; task "Phoenix Spare Dev Server Follows" runs
  `spare-follow-production.ps1 -Target main` every 10 min) — never move it to a branch. Tests: `& ~/.claude/scripts/spare-test.ps1 '<command>'` from the checkout (default the
  whole suite; runs queue one at a time, each in a fresh folder; never `pnpm` there, never a second test folder); any other command: `~/.claude/scripts/spare.ps1`. Spare: `ssh phoenix-spare`, D:\Phoenix, 8 GB.
- 🔴 **NEVER run a typecheck locally** — bash-guard C8 refuses it; the PR's CI answers. `PHX_TYPECHECK_OK=1 <cmd>`
  stands it down for one watched command.
- A dev server dies with the session that started it (`dev-server-reaper.mjs`). Stop only one YOUR session started,
  by PORT; one he or another session started waits for his word.
- **App slow? Read `~/.claude/scripts/ram-meter/claude-app-watch.txt` first.** "Re-archive the stuck sessions" =
  `unarchive_session` then `archive_session` for exactly the ones it lists. Never stop or restart the app yourself
  (only the RAM meter's own automatic restart, whose conditions are never widened).
- Never watch CI or a deploy in the foreground — background it and report the end.
- **Sessions compact at about 300k tokens** (owner, 2026-10-31): `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and
  `autoCompactWindow` are both **333000** in `settings.json` — compaction lands ~33k below the window. Never change it unasked.
- **Keep `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true`** in `settings.json` `env` AND as a Windows user variable —
  suggestions are ALWAYS ON (2026-10-12). 🔴 Never report usage as the reason the box is empty; the silent skips
  are in memory note `the-turn-box-took-the-ghost-text`.

## Compact Instructions

These REPLACE the default summary format (owner, 2026-10-09). The session is frozen while the model writes.

- **Analysis block: five short lines at most. Summary: about 8,000 characters, never more than 10,000.**
- **Only these four headings, one-line bullets:** *His words* — instructions, approvals and decisions word for
  word with Cairo times. *Open items* — each with its real target (PR number, branch and worktree, full SHA, task
  ID, uncommitted file). *Proven* — what is proven and the one number that proves it. *Next step* — where the work
  stopped and the exact next action.
- **Do not write** the default sections, code snippets, file contents, tool output, the exploration behind a
  finished result, committed code (name the file and commit), or any rule already in this file, AGENTS.md/CLAUDE.md
  or module memory.

## Never delete documents (owner, 2026-09-14)

- **Never delete an HTML, PDF, XLSX/XLSM/XLS, DOCX/DOC or SVG file**, anywhere, scratchpad included — leave it or
  move it aside. 🔴 Only once he has NAMED that file in chat: `PHX_DELETE_OK=<filename> <the same command>`
  (`$env:PHX_DELETE_OK='<filename>';` in PowerShell) — one yes, one file, one command. `F:\Claude Scratchpad
  Archive` and `F:\Hiring Posts` have NO hatch. Never reach for the marker on your own reading. Images, CSV, CSS,
  JSON and patches are not protected.
- `scratchpad-archive.mjs` and `repo-archive.mjs` copy the protected types into `F:\Claude Scratchpad Archive`;
  never delete anything there. "Is this archived?" is answered by `repo-archive.mjs --verify`, never by a path.

## Where a rule survives

Auto-memory is one directory per repository. A rule that must outlive the session goes in **this file** (true
everywhere) or the project's tracked AGENTS.md / CLAUDE.md. 🔴 `hooks/phoenix-context-anywhere.mjs` (2026-10-31, his
words: "remember the rules and remember the history") gives a session OUTSIDE the Phoenix folder the Phoenix index
and rule files, and EVERY session the latest 15 sessions across all folders — never remove it; look there before
saying you do not remember.

## 🥇 MODULE MEMORY, and the trimming that is FORBIDDEN (owner, 2026-10-02)

Every folder, repository and cloud session. Account: `docs/module-memory.md`; enforced half: `AGENTS.md` §2.2.

- 🔒 Each module's rules and notes live in `.claude/rules/<module>.md`; if its memory has not appeared when you
  change a module, OPEN the file yourself (the injector fails open).
- 🔴 **NO MEMORY LIMIT IS EVER PUT TO HIM** — split, rebuild and ship it in the PR you are already opening.
- 🔴 **`MEMORY.md` IS NEVER TRIMMED, AND NOTHING MAY ASK HIM TO FREE SPACE IN IT.** Never delete a hook to make room.
- 🔒 Route a new rule by where it applies (one module → its `## Rules`; everywhere → AGENTS.md or here; a trap →
  `docs/agents-session-traps-clusters.md`); 🔴 never re-add a module fact to `MEMORY.md` or AGENTS.md.
- A new memory note lands under `## Inbox` in `MEMORY.md`; the fold files it (09:00, 15:00, 21:00 Cairo).
- 🔴 Never hand-edit a generated block — edit `modules.mjs`/`assignments.json` and run `build.mjs`. A module file
  nearing its cap is SPLIT, not trimmed.
