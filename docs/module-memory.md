# Module memory

**Owner decision, 2026-10-02.** Each module of Phoenix Workforce carries its own memory — its rules
and every memory note about it — in `.claude/rules/<module>.md`. Claude Code loads that file by
itself the moment a session opens a file of the module. The startup files (`AGENTS.md`, the laptop's
`MEMORY.md` index) keep only what is true everywhere. AGENTS.md §2.2 holds the hooks; this file is the
account.

## Why it exists

The startup files have hard ceilings: `MEMORY.md` is truncated by the loader at 25 KB / 200 lines,
and `CLAUDE.md` + `AGENTS.md` are held to their CI share. Every new rule pushed an older one out of
sight, sessions kept asking the owner to trim, and a session returning to an old module no longer
knew its rules. Measured on 2026-10-02, before this change:

| | Before |
| --- | --- |
| Memory notes on the laptop | 1,064 (4.8 MB) |
| Notes pointed to by anything a session reads at startup | 233 (22%) |
| Notes listed only in `MEMORY-ARCHIVE.md`, which no session opens unless it thinks to | 831 (78%) |
| `AGENTS.md` | 113,652 bytes, with 2,989 bytes left in its CI share |
| `MEMORY.md` | 21,206 bytes of a 25 KB loader cliff |

Storage was never the problem — the notes were on disk and mirrored into the repo. **Recall** was:
nothing told a session a note existed. A database "brain" would have failed the same way, because an
agent only queries for what it already knows exists.

## How it loads

**Claude Code's own path-scoped rules.** A `.claude/rules/*.md` file with a `paths:` frontmatter is
not loaded at startup; it is loaded when the session READS a file matching one of its globs. Proven on
Claude Code 2.1.284 (the desktop app's version) on 2026-10-02 with a throwaway module carrying a
codeword: no file read → not loaded; another module's file read → not loaded; this module's file
read → loaded (3 of 3 runs, two of them with the owner's full hooks and settings on).

`node scripts/module-memory/proof.mjs` repeats that proof for **every** module in a real headless
session (Haiku, project settings only, a prompt with no module keyword so the hook cannot be what
delivered it). **Re-run it after a Claude Code update** — the loader is Claude Code's, not ours.

**The hook covers work that opens no file.** `.claude/hooks/module-memory-injector.mjs` runs on
UserPromptSubmit and PreToolUse. It matches the owner's message against each module's keywords,
shell commands against paths and keywords, Grep/Glob paths, Edit/Write of a new file, and SQL text
(Supabase MCP or `psql`) against each module's table names. It injects a **pointer**: the module's
title, the bold headline of each of its rules, and the file to Read. It never pastes the file —
Claude Code persists any hook context over ~10 KB to disk and shows the model a 2 KB preview
(observed 2026-10-02 on the trap hook's 12.5 KB clusters), and a truncated rule reads complete. A
Read of a module file is recorded but never injected, because Claude Code already loaded it.

## The files

| File | Role |
| --- | --- |
| `scripts/module-memory/modules.mjs` | The module map: id, title, scope, globs, keywords, table names. The one definition everything reads. |
| `scripts/module-memory/assignments.json` | Every memory note -> a module, `global` (stays in `MEMORY.md`) or `history` (never loaded). |
| `scripts/module-memory/build.mjs` | Writes each rules file's frontmatter, header and notes block, the history list and the AGENTS.md directory. `--check` is the CI gate. |
| `.claude/rules/<module>.md` | The module memory. `## Rules` is hand-written and preserved; the notes block is generated. |
| `docs/module-memory/history.md` | Notes about retired platforms and frozen areas. Never loaded; never act on it. |
| `.claude/hooks/module-memory-injector.mjs` | The pointer hook above. Also records the modules each session touched. |
| `scripts/module-memory/fold.mjs` | The weekly fold below. |
| `scripts/module-memory/proof.mjs` | The live per-module proof above. |
| `tests/module-memory.test.ts` | Runs `build.mjs --check` and pins the glob dialect, the hook's routing, the pointer size and the no-regrowth rule, in the required `validate` job. |

## How memory stays current

1. **Work that ends in a PR.** A rule or fact learned in a module goes into that module's `## Rules`
   in the same PR as the work. A changed rule is an EDITED line, never a second line that
   contradicts it. It is live for every session the moment the PR merges.
2. **A ruling the owner gives in chat** goes in the same way, inside that session's PR.
3. **Work with no PR.** The note is written on the laptop as before, with its pointer under
   `## Inbox` in `MEMORY.md`, so every local session sees it at once. The weekly fold
   (`node scripts/module-memory/fold.mjs --apply`) files each unfiled note under a module — by the
   modules its own session touched (`originSessionId` + the hook's record), else by its own words —
   refreshes the repo mirror, rebuilds, and opens ONE PR. After that PR merges, the next fold removes
   those pointers from the inbox. A note whose words match no module is filed under `sessions` and
   named in the PR so it can be moved.

The fold works in a temporary worktree from `origin/main`, never merges, never deletes a note, and
waits while an earlier fold PR is still open.

## What stays in AGENTS.md, and why

Only what applies to every session whatever its module: how to answer the owner, approvals and
money, git/CI/deploy safety, environment identity, worktrees and the machine, the mobile-app freeze
(and the two dormant mobile rules `tests/mobile-freeze.test.ts` pins there), the fits-the-screen,
square-edge and document-identity golden rules, the no-PITR warning, and the Monthly-Closing
source-of-truth golden rule, which the owner ordered "locked everywhere in the system".

`tests/module-memory.test.ts` refuses an AGENTS.md rule whose every cited code file belongs to a
business module — that rule belongs in the module. A rule that truly applies everywhere but cites
one module's code is listed, with its reason, in the test's `DELIBERATELY_GLOBAL`.

## After the change (2026-10-02)

| | After |
| --- | --- |
| Modules | 25, every one of the 121 `src/lib` domains owned |
| Notes filed | 1,064 of 1,064 — zero orphans (CI-enforced) |
| `AGENTS.md` | ~64 KB (was 113.7 KB); 117 rules moved into module files |
| Module memory on disk | ~400 KB, none of it loaded at startup |
| Largest module file | Monthly Closing, ~62 KB, loaded only when sales code is touched |

## Limits — say these plainly

- A session that opens no module file AND whose words match no module's keywords gets nothing from
  that module. The AGENTS.md directory (§2.2) is the backstop: it lists every module and its file.
- The hook fails open and silent. If a module's memory has not appeared before you change it, open
  `.claude/rules/<module>.md` yourself.
- The first sort of 1,064 notes was done by eight Sonnet passes plus review; a note can sit in the
  wrong module. Moving it is one line in `assignments.json` and a rebuild.
- Claude Code updates can change how path-scoped rules load. `proof.mjs` is how you find out.
- 🔴 **TWO SIZE LIMITS APPLY, AND THE SMALL ONE BITES FIRST.** `MODULE_FILE_MAX_BYTES` (72,000) caps
  the whole file; `tests/agents-long-hooks-cite-docs.test.ts` caps each **rule bullet** at
  `LONG_HOOK_BYTES` (1,200) unless that bullet names a `docs/<file>.md`. It measures every line
  starting `- ` inside the `rules:begin`/`rules:end` block, so a module file can sit at a third of its
  own cap while one bullet turns the required `validate` job red — which is how it was found, on
  #5169, by a session whose two new bullets were 1,243 and 1,376 bytes. **Relocate FIRST, trim
  second:** write the evidence into a `docs/` file, then cut the bullet to its cue plus that pointer.
  Trimming first destroys an account that exists nowhere else, while reading as a tidy-up. Every
  module file now carries this in its own header (generated by `build.mjs`), so a session adding a
  rule reads it before it writes one.
