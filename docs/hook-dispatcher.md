# The hook dispatcher — every PreToolUse hook in one process

Since 2026-10-08, `.claude/settings.json` has one PreToolUse entry. It runs
`.claude/hooks/hook-dispatch.mjs`, which runs the ten project hooks in its own process. The guards
themselves are wired in `.claude/hooks/dispatch.json`, in the same shape a settings.json hooks block
uses: `matcher`, `command`, `timeout`.

**To add a PreToolUse hook, add it to `dispatch.json`, never to settings.json.**
`tests/hook-dispatch.test.ts` fails if settings.json's PreToolUse holds anything except the
dispatcher.

## Why

Measured on the owner's laptop on 2026-10-08.

A Bash or Edit call matched 7 project hooks, and Claude Code started each one as its own node
process. Each guard's own work takes a few milliseconds. Almost all of the cost was node starting up,
about 60 ms of CPU and 57 MB of memory per process.

| Per Bash/Edit call, median of 15 | 7 processes | Dispatcher, one isolate |
| --- | --- | --- |
| CPU | 649 ms (850 ms with RAM tight) | 93-124 ms |
| Peak memory, summed | 397 MB | 61 MB |
| Wall-clock wait | 138-181 ms | 132-169 ms |
| Node processes | 7 | 1 |

A Read call matches one hook, so it costs the same either way: 92 ms against 100 ms of wait.

Free RAM is what freezes this machine, so 340 MB less on every tool call is the point.

The wall-clock wait was never the sum of the hooks. Claude Code runs hooks in parallel, so the wait
is the slowest one; `scripts/slow-audit.mjs` has reported the two separately since #5514.

**Worker threads were measured first, and they do not help.** On this machine a worker costs about
76 ms of CPU to start, the same as a process. They cut peak memory, but saved no CPU.

## How

1. **One read, one selection.** The dispatcher reads the payload once and picks the hooks whose
   matcher fits the tool, using Claude Code's own rule: plain names and pipes are an exact list,
   anything else is a regex.
2. **Each hook runs unchanged, one after another**, with exactly what it had as a process:
   - the payload on fd 0;
   - its own path as `argv[1]`, followed by its arguments;
   - its own captured stdout and stderr;
   - a `process.exit()` that ends that hook only. The first call's code is its exit code, and
     nothing it writes afterwards counts.
3. **Nothing leaks between hooks.** `process.env`, the exit code and process-level listeners are
   restored after each one.
4. **The answers are merged the way Claude Code merges parallel hooks:**
   - exit 2 blocks;
   - otherwise deny > ask > allow, keeping the winning decision's reasons;
   - every `additionalContext` is kept;
   - a crash or timeout is reported in `systemMessage` and never blocks.

## The contract a hook keeps to run in-process

Both rules are checked from each hook's syntax tree by `tests/hook-dispatch.test.ts`.

1. **Its work ends when its module finishes loading.** Use top-level code, or a top-level `await`.
   Never leave a floating `main()` promise, or its output lands in the next hook.
2. **A `catch` around code that can exit must not swallow the exit.** It either exits too, or
   rethrows:

   ```js
   } catch (e) {
     if (e?.[Symbol.for('phx.hook-exit')]) throw e;
     …
   }
   ```

A hook that cannot keep the contract is marked `"run": "worker"` (its own worker thread) or
`"run": "process"` (its own process) in `dispatch.json`.

## Proof it changes nothing a session sees

The same test runs a corpus of real tool calls through the dispatcher twice: once in-process, once
with `PHX_HOOK_DISPATCH_PROCESSES=1` (one process per hook, the old way). The answers must be
byte-identical.

The corpus covers:

- a denied typecheck;
- a frozen mobile path;
- a protected file;
- a risky settings allow;
- a module-memory read;
- git commands;
- a Supabase SQL call.

The corpus must also draw at least three allow, ask or deny decisions, because identical silence on
both sides proves nothing.

**Break-tested on 2026-10-08.** Each break below fired its assertion, and each file was restored
from a copy and byte-compared afterwards:

| Break | What fired |
| --- | --- |
| A floating `main()` in `module-memory-injector.mjs` | The contract check and the equivalence check |
| The rethrow removed from `trap-injector.mjs` | The contract check |
| The dispatcher handing hooks an empty payload | The equivalence check |

## The user-level copy

`~/.claude/settings.json` has its own PreToolUse hooks, and they fire in every folder, not just this
repo. So they cannot call this repo's dispatcher. Since 2026-10-08 a **byte-identical copy** of
`hook-dispatch.mjs` and `hook-dispatch-worker.mjs` lives in `~/.claude/hooks/`, and runs the
`dispatch.json` beside it. Edit the copy here, then copy it over; never edit the copy itself.

| User hook | Matcher | Timeout | Where it runs now |
| --- | --- | --- | --- |
| weekly-review-readonly | `^(Write\|Edit\|NotebookEdit\|Bash\|PowerShell\|mcp__.*)$` | 15 | the user dispatcher |
| scratchpad-guard `pre` | Bash\|PowerShell | 90 | the user dispatcher |
| risky-allow-guard | Write\|Edit | 10 | the user dispatcher |
| dev-server-reaper | Bash\|PowerShell, `async` | 10 | **its own entry in settings.json** |

- **The weekly-review matcher is a regex on purpose.** Until 2026-10-08 it read
  `Write|Edit|NotebookEdit|Bash|PowerShell|mcp__`. Claude Code reads plain names and pipes as an
  exact list, so `mcp__` matched no real tool, and the guard's block on MCP tools that can write
  never fired. The dispatcher's own entry in `~/.claude/settings.json` was changed to the same regex,
  so MCP calls reach it at all.

  Proved through the installed dispatcher:
  - in a weekly-review session, `execute_sql` and `update_scheduled_task` are denied;
  - a read-only MCP tool and an ordinary session pass;
  - `BashOutput`, `Read`, `MultiEdit` and `Grep` still match nothing.

  With the old matcher swapped back in, the two denials disappear. The guard now starts one node
  process per MCP call in every session, and outside the weekly review it exits at once.
- The dev-server reaper stays separate. An async hook never holds the call, and the dispatcher waits
  for every hook it runs.
- User settings write hooks as `"command": "node", "args": [script, …]`. `commandOf()` folds that
  form into the same command string, and `parseCommand()` accepts an absolute script path.
- Two hooks gained the rethrow line:
  - `scratchpad-guard.mjs`: its `pre` catch would have swallowed the exit.
  - `weekly-review-readonly.mjs`: its catch exits, so the contract check passed it, but it would have
    logged a false "hook error" on every call first.
- **Proof**, measured 2026-10-08:
  - 11 tool calls through the installed copy, in-process and as one process per hook, gave identical
    answers, 5 of them real decisions;
  - all three hooks' own selftests reported `0 failed`.
- A Bash, Write or Edit call now starts two node processes in all, one per dispatcher. Before, it
  started nine or ten.
- `~/.claude/scripts/claude-scripts-backup.mjs` copies `.mjs` files off the machine but never
  `.json`. The table above is therefore the off-machine record of `~/.claude/hooks/dispatch.json`.

## When it misbehaves

- **Fall back to the old way at once:** set `PHX_HOOK_DISPATCH_PROCESSES=1` in the environment. The
  dispatcher then runs every hook as its own process.
- **If the dispatcher itself throws,** it reruns the same hooks as processes on its own. No guard
  stops enforcing because of this file.
- **Timeouts:** an in-process hook cannot be stopped mid-way. The dispatcher entry's own timeout
  (90 s) bounds the whole call, and is at least the slowest hook's.
- 🔴 **A `timeout` in `dispatch.json` is NOT enforced for an in-process hook — only `worker` and
  `process` runs start a timer.** So an in-process hook that spawns a child synchronously must cap
  that child itself, well under 90 s, and spawn it with no `shell` (through `cmd.exe` a timeout kills
  the shell and orphans the child). When the 90 s runs out, Claude Code kills the dispatcher whole and
  EVERY guard's answer for that call is lost, not just the slow one's. Measured 23 Oct 2026, 08:40–10:13
  Cairo: bash-guard C12's gitleaks ran 30–95 s on every push under a 120 s cap, and three pushes went
  through with no guard at all. Fixed in `.claude/hooks/lib/secret-scan.mjs` (20 s cap, no shell, scans
  the `cd` target, skips a branch with nothing past `origin/main`).

## What the dispatcher costs — profiled 2026-10-08, and why nothing was changed

The transcripts recorded the dispatcher at p50 611 ms and p90 2.8 s per call over 6–8 October
(`node scripts/slow-audit.mjs --transcripts`), against 0.13–0.17 s on a quiet box. So the guards
were profiled one by one, in-process, exactly as the dispatcher runs them, over a realistic payload
set (a `git status`, a `git push` dry string, a PowerShell read, an Edit, a Read and a Grep):

| Payload | Dispatcher wall time (median) | Slowest guards inside it |
| --- | --- | --- |
| Bash `git status` | 152 ms | batch-nudge 12 ms, bash-guard 11 ms, trap-injector 7 ms |
| Edit of a source file | 223 ms | primary-write-guard 75 ms, module-memory-injector 23 ms |
| Read of a source file | 123 ms | — |

**The guards cost 3–75 ms; the rest is starting one node process.** The p50 of 611 ms in the
transcripts is that same process started on a box short of free RAM, so the planned fixes — a
"run in the background" mode for `session-lock beat` and `batch-nudge`, and an mtime cache in
`trap-injector` and `module-memory-injector` — would have saved milliseconds and were not built.
What makes this call slow is the machine (`docs/slowness-audit.md`), not this file. Re-measure with
the transcript audit before reopening it.

**2026-10-09 — the two process starts around the dispatcher, removed.** The dispatcher itself is
unchanged; what changed is what ran *with* it on every call:

- **No Git Bash in front of it.** `.claude/settings.json` now runs it, and every other node hook, in
  exec form — `"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/hook-dispatch.mjs",
  "PreToolUse"]` — which Claude Code spawns with no shell and still fills `${CLAUDE_PROJECT_DIR}` in.
  One Read through the dispatcher, median of 9 interleaved runs on a quiet box: **144 ms through Git
  Bash, 99 ms without it.**
- **No `git rev-parse` inside primary-write-guard.** It asked git for the checkout layout on every
  Write/Edit/NotebookEdit — the 75 ms in the table above. It now reads the same `.git` folder,
  `gitdir:` file and `commondir` pointer git reads (`scripts/lib/git-layout.mjs`), and falls back to
  git only when those cannot be read. One Edit through the dispatcher: **156–174 ms before, 120–139
  ms after** (two rounds of 9). bash-guard's pnpm-in-a-worktree check uses the same helper.

Both are pinned by `tests/hook-hot-path.test.ts`: it runs every blocking hook settings.json names
under `tests/support/spawn-probe.mjs` with ordinary payloads and fails on any process start or
network call. The persistent-process ideas above stay declined; the full account is
`docs/slowness-audit.md`, "Layer 7".

## batch-nudge — one step, several reads

Added 2026-10-08, after the owner's "building is slow". Measured from 72 hours of Phoenix transcripts
(372 build tasks): a build task took a median of 25 steps, and 14 of them were single read-only
look-arounds — one `grep`, one `cat`, one `sed -n`, one Read — each a full model round trip of
about 10 seconds. Only 10% of steps sent two or more tool calls at once. Look-arounds were 19% of all
build time, second only to the box-check waiting that #5500 and #5543 removed.

`.claude/hooks/batch-nudge.mjs` runs on Read, Grep, Glob, Bash and PowerShell. It reads the tail of
the session's own transcript, groups its entries into steps by request id, and counts the trailing
steps that each ran exactly one read-only look-around. At three in a row, when the call about to run
is a look-around too, it adds one short reminder to send the next reads together. It never blocks.

- **What counts as a look-around:** Read, Grep, Glob, and a foreground shell command whose every
  piece only reads (`grep`, `cat`, `head`, `sed -n`, `ls`, `find`, `git status/log/diff/show`,
  `Get-Content`, `Select-String` …). A redirect, `sed -i`, `-delete`/`-exec`, a heredoc or a
  background call is not one.
- **What ends a streak:** an owner prompt, any step that ran something else, a step that already
  batched, and the step it last reminded after.
- **What it costs:** about 10 ms of work per look-around call inside the dispatcher (it reads the last
  1 MB of the transcript and parses only the assistant and prompt lines), and at most six reminders of
  about 450 characters per session.
- **Stand-down:** `PHX_BATCH_NUDGE_OFF=1`. Pinned by `tests/batch-nudge.test.ts`.

## comment-strip-guard — the ratchet's verdict, at the write instead of in CI

Added 2026-10-12, at the owner's instruction (*"fix the comment-strip ratchet so new test files use
the shared stripper"*), after four of that day's twenty-five red PR runs were one zero-tolerance gate
firing on a newly added test file.

`tests/comment-strip-ratchet.test.ts` refuses every hand-rolled line-wise comment strip under
`tests/` — a `.filter` on a comment prefix, an `if (line.startsWith("//")) continue`, a whole-line
`.replace` — because a line judged by how it STARTS cannot know a block comment is already open. The
rule is right; the **timing** was the cost. It is the last assertion of a 977-test shard inside the
required `validate` job: on PR 5700 (2026-10-09) it named its offender after **5m34s** with `checks`
already green, so the run reads healthy until the final second. Each firing is a full CI round that
ends in a one-line import.

`.claude/hooks/comment-strip-guard.mjs` is a PreToolUse hook on Write, Edit and MultiEdit. It reads
the text the call would **introduce** — `content`, `new_string`, each MultiEdit `new_string` — and
when that text carries a shape, it denies the call and hands over the remedy:

    import { stripComments } from "./support/comment-strip.ts";

- **Why it denies rather than warns**, unlike `test-registration-check.mjs` beside it: registration is
  legitimately a two-step (write the test, register it one edit later), so its first warning is a
  nudge. A hand-rolled strip is wrong the moment it is written, the budget is 0 and the grandfather
  list is empty, so no later edit makes it acceptable. It refuses an **edit**, never a push — the
  owner's 2026-10-04 "keep the pre-push test as a rule, no guard" is about the test SUITE, and this
  hook neither runs nor waits for one.
- **Only the text being introduced**, never the file on disk: a pre-existing site elsewhere must not
  block an unrelated edit, and an edit that REMOVES a strip has to pass, or the guard would block its
  own remedy.
- **Scope is exactly the sweep's:** every `.ts` file under `tests/`, at any depth, minus the three
  sanctioned ones (the stripper, the ratchet, this guard's test — their fixtures ARE the shapes).
  `.tsx` is deliberately out, because the sweep reads `.ts` only and a hook stricter than the check it
  fronts for refuses work CI accepts.
- **One detector, not two copies.** It lives in `.claude/hooks/lib/comment-strip-shapes.mjs`; the
  ratchet imports it and defines none of its own, and `tests/comment-strip-guard.test.ts` fails if
  either side grows a copy back. A hook that drifts into refusing what CI accepts — or into silence
  about what CI rejects — is worse than no hook. A fourth file that must spell the shape out joins
  `SANCTIONED_TEST_FILES` in that module, never a list inside the hook.
- **Stand-down:** `PHX_COMMENT_STRIP_OFF=1`. Fails open on any error, like every guard here. Its own
  `--selftest` runs 36 cases; `tests/comment-strip-guard.test.ts` drives the hook as a subprocess over
  every shape and every measured negative, pins its wiring, and runs that selftest.

## form-design-guard — the form ratchet's two zero-tolerance shapes, at the write

Added 2026-10-12, at the owner's instruction (*"guard the form-design ratchet at the Write too"*),
the same day and for the same reason as `comment-strip-guard` above: thirteen of that day's
twenty-six red PR runs were repo-wide contract gates, each a full CI round that ends in a one-line
import.

`tests/form-design-system.test.ts` holds his 2026-10-06 rule that **every form wears the Adverse Drug
Reaction wizard's skin**, and two of its assertions have no grandfather list at all:

1. **`SELF_SKINNED_CAP = 0`** — a form control whose className paints a radius, a full border or a
   white ground without ever reaching `phxFieldClassName` / `phxSelectClassName` /
   `phxTextareaClassName`. Any number above zero is a new form that did not use the kit, which is the
   one thing the ratchet exists to catch, and 🔴 **the cap is never raised.**
2. **The merge-semantics check** — `` `${phxFieldClassName} h-9` `` ships *both* heights in one class
   attribute, because `cn()` is tailwind-merge and a template literal is plain concatenation. The
   override silently loses to the token (on a numeric scale the larger utility wins), so the source
   says 36px and the DOM renders 40px, with nothing in lint, typecheck or the browser saying so. 177
   of these existed the day the design was swept.

`.claude/hooks/form-design-guard.mjs` is a PreToolUse hook on Write, Edit and MultiEdit that hands
down the same two verdicts at the moment the shape is typed — which is also the moment the author
still has the design in mind. Each refusal writes the remedy out: the `form-tokens` import, the
`FormField` assembly, or the exact `cn(<token>, "<override>")` call.

- **Only the text being introduced** — `content`, `new_string`, each MultiEdit `new_string`. A
  pre-existing control elsewhere in the file must not block an unrelated edit, and an edit that
  REMOVES an offender has to pass or the guard would block its own remedy.
- **The file on disk and its imports are read for ONE purpose: resolving a className that is a
  reference**, so a control wearing an imported alias of the token is recognised as on-design instead
  of reported as unresolvable. Bounded at 14 small reads (plus `form-tokens.ts` and `form-kit.tsx`,
  always in scope), never a sweep of `src/`, and it spawns nothing — hot-path safe.
- **Two scopes, because the two sweeps differ:** the control check reads `.tsx` under
  `src/components/` and `app/`; the template check reads every `.ts`/`.tsx` under `src/` and `app/`.
  A hook wider than the check it fronts for would refuse work CI accepts.
- **Every exemption comes from the sweep's own `EXEMPT` list**, his rulings included — the login
  screen, every dark ground, `hiring-pack/` and `offers/` — and so do the `h-8`/`h-9` dense table and
  filter controls, which are legitimate through `cn()`. **An unresolvable reference paints nothing and
  is allowed:** the guard is deliberately no stricter than the ratchet.
- **One detector, not two copies.** Both shapes live in `.claude/hooks/lib/form-design-shapes.mjs`
  with the exemption list and the owner's rulings that used to sit in the test's doc comments; the
  ratchet imports `commentMask`, `EXEMPT`, `fileConstants`, `scanControls` and `templateConcatSites`
  from it and defines none of them, and `tests/form-design-guard.test.ts` fails if either side grows a
  copy back. A new exemption is added to that module, never to a list inside the hook.
- **Stand-down:** `PHX_FORM_DESIGN_OFF=1`. Fails open on any error. Its own `--selftest` runs 57
  cases; `tests/form-design-guard.test.ts` drives the hook as a subprocess over 8 painted shapes and
  11 measured negatives, both template directions, Edit/MultiEdit arrival, the removal edit, both
  scopes, every entry of `EXEMPT`, the dispatch wiring and the one-detector pin.

## bash-guard C20 — a `.claude` push carries the cloud-mirror refresh

The owner asked for it mechanically on 2026-10-23 ("make it mechanical"), the same morning he said
"refresh the cloud mirror in the next PR that touches .claude" — the second instruction being the
rule and the first being the demand that nothing have to remember it.

**What it is for.** `.claude/cloud-context/memory-mirror/` IS the Phoenix memory a cloud session
wakes up with: a cloud clone never sees `~/.claude`, so the mirror on `main` is the whole of its
two-tier recall. It is therefore only ever as fresh as its last MERGED refresh. The drift was already
measured — `scripts/cloud-mirror-drift-refresh.mjs` takes a reading off the SessionStart path and
`.claude/hooks/memory-index-guard.mjs` prints it — but nothing anywhere ACTED on the reading, so the
mirror sat stale between refreshes. Measured 2026-10-02: five of 1,061 mirrored files no longer
matched live memory and three memories written since the last refresh were missing outright, among
them `saginko-repriced-retail-from-october-direct-from-today` — the mirror still said the
`analytics.sos_fact` flat-price gap was *"OPEN GAP found 2026-10-01, NOT yet fixed"* 86 minutes after
it was fixed and its migration applied. A cloud session sent at that area would have been told to go
and fix something already done, and nothing on its side could ever have corrected it.

**What it does.** On a `git push` from a checkout holding `scripts/sync-cloud-context.mjs`, it asks
one cheap question first — does `origin/main...HEAD` touch any `.claude/` path? If not, the clause is
silent and the push pays one `git diff` of names. If it does, it compares the laptop's live memory
against the mirror as the push would ship it, and refuses with the drifted files NAMED, the one
command that fixes it, and its stand-down.

🔴 **The reading is taken against the mirror in `HEAD`, never `origin/main` and never the
SessionStart cache, and that is what makes the refusal fixable.** The question here is not "has the
merged mirror drifted" — that is the SessionStart reading's question, answered off a possibly stale
ref and from a reading up to 24 hours old. It is "does the branch I am pushing carry a current
mirror". Read off HEAD, the refusal clears the moment the refresh is committed on the branch, in the
same turn. Keyed off the cache it would survive its own fix, because that reading is throttled to 30
minutes, and a guard nobody can satisfy is a guard switched off within the hour.

🔴 **A test case where the mirror is current everywhere proves nothing about the ref.** Measured
2026-10-23: flipping the clause to `ref: "origin/main"` left the whole suite green, because with
`main` and the branch agreeing both refs give the same answer. The case that pins it is the real
one — `main` behind, the refresh committed on the branch — and it must assert ALLOW.

- **The fix it names:** `node scripts/sync-cloud-context.mjs`. That command also files any new note
  under its module and rebuilds the notes blocks, which is the half that keeps the required
  `validate` job off an orphan note.
- **Untouched:** a push that touches no `.claude/` file however stale the mirror is, a `--dry-run`,
  and a machine with no memory directory at all — a cloud runner has none, so there is no live side
  to compare and the clause allows, the same fail-open contract every other reading here keeps.
- **Stand-down:** `PHX_MIRROR_OK=1`, for a `.claude` change that has to go out before the refresh (a
  hook fix mid-incident). The two modules it needs are loaded dynamically, only after a push has been
  seen to touch `.claude/`, so an ordinary Bash call parses neither.
- **Pinned by** `tests/cloud-mirror-push-guard.test.ts`: seven cases, each building its own bare
  origin, work repo and memory directory under `CLAUDE_CONFIG_DIR`, so the suite never reads the
  laptop's real memory and passes on a runner that has none.

## bash-guard C12 — a commit and a push are two commands

**What happened.** On 3 Nov 2026 a single command, `git add … && git commit … && git push`, was
allowed. C12 is a PreToolUse hook, so it runs before the whole command starts. The new commit did not
exist yet, the branch had nothing past `origin/main`, and the scan read zero commits. The push carried
a JWT: staging's public anon key, already on `main` in `.github/workflows/ci.yml`, so no harm this
time. The very next push, with the commit in place, was refused for it with the `jwt` finding. A real
key would have passed the same way, and once on GitHub the fix is rotation, not a revert.

**Why it refuses rather than scanning the staged diff.** `gitleaks git --staged` was the other option,
and it cannot close this shape, because that same command's `git add` has not run either. Measured on
a fixture with the repo's own `.gitleaks.toml`:

| The JWT's state when the scan runs | `--staged` | `origin/main..HEAD` |
| --- | --- | --- |
| Written, not yet added: what a hook sees of this shape | exit 0, clean | |
| A file the command itself would write | exit 0, clean | |
| Added | exit 1, found | |
| Committed | | exit 1, found |

Nothing readable at hook time is what the push will send, so the complete answer is to make the commit
exist first. A real `pre-push` git hook would read the right commits, but the owner removed that gate
on 2026-08-18 and it stays removed.

**What it does.** It refuses when a command makes a commit (`git commit`, `cherry-pick`, `revert`, `am`,
`merge`) and then pushes, before any of it runs. Run the commit, then a plain `git push` as a second
command, and the ordinary scan reads the new commit. Through the real guard and the real gitleaks on a
throwaway repository, that second command is refused (`1 commits scanned`, `leaks found: 1`, rule `jwt`)
and the branch never reaches the origin.

- **How it reads the command:** split at command positions by `commandSegments`, quoted text blanked,
  comments dropped, so a commit message saying `git push` is not read as running one. It looks for
  `git` anywhere in what is left, not only at the start, because `timeout 60 git push` and PowerShell's
  own `if ($?) { git push }` are pushes too. A false refusal only costs splitting the command.
- **Not refused:** a commit or a push alone, a push before the commit, a dry run, a push that only
  deletes a branch, an aborted merge, `git pull` or `git rebase` before a push (they bring what the
  remote holds or rewrite commits the scan can read), and any folder without `.gitleaks.toml`.
- **Stand-down:** `PHX_SECRETS_OK=1`, unchanged, in the command or the environment. It skips the scan
  as well, so it is only for a finding already read and judged a fixture. Splitting costs nothing.
- **Pinned by** `tests/secret-scan-push-guard.test.ts`, sections 8 and 9, through the real hook.

### Which pushes it reads, where, and what range (3 Nov 2026)

The refusal above left three holes. One regex, `GIT_PUSH`, decided whether a scan ran at all, and it
missed pushes that do not start with `git push`. The scan always read `origin/main..HEAD`, whatever
the push named. And `.gitleaks.toml` was looked for only in the folder the push ran in, so a push from
a subfolder was not recognised as this repository's.

All 7,616 commands holding `git` and `push` across the 1,380 Phoenix transcripts touched in the 14 days
to 3 Nov 2026 were read back through the new reader without running anything. 5,091 are pushes, 2,938
of them commit-then-push and 2,153 alone. Of the lone pushes, the old pattern never recognised **547**
`timeout N git push`, **77** `git -C <folder> push` and **12** others (`if`, `for … do`, `{ }`), so
**636 lone pushes, 30%, ran with no scan at all.**

**How it reads a push now.** `pushScanPlan` in `lib/secret-scan.mjs` reads the command word by word
through `lib/git-command.mjs`, the parser `push-typecheck-guard.mjs` already had. It moved to a library
because a hook runs on import, so neither guard could import the other. `GIT_PUSH` is unchanged and is
now C20's alone, since C20 reads only the session's folder and a wider regex would change it.

| A push | What happens |
| --- | --- |
| `git -C <folder> push`, `git -c k=v push`, `timeout 60 git push`, `if ($?) { git push }` | Scanned |
| `WT="…"; git -C "$WT" push`, `WT="…"; cd "$WT" && git push`, `$WT = "…"; Set-Location $WT; git push` | Scanned in that folder: a variable set earlier in the same command is read, and a `$(…)` around a branch or `rev-parse` is asked of git |
| A folder it cannot name: an unset variable, a loop variable, a `$(mktemp -d)`, a folder that is not there | Refused, because no folder can be scanned. Allowed from a session outside this repository, which is not ours to refuse |
| `git push origin other`, `other:refs/heads/x`, `+other`, `<sha>:refs/backups/x` | Scans `origin/main..other`, not HEAD |
| `git push origin a b` | Scans both ranges in one run |
| `git push origin HEAD` or a plain `git push` | Scans `origin/main..HEAD`, and the commits-ahead shortcut still skips an empty range |
| `git switch other && git push`, `git checkout other; git push`, `git reset --hard x && git push` | Refused, because the scan would read the commit HEAD is on now, not the one it moves to. `git switch other && git push origin other` names it, and is scanned |
| A ref that is not a commit yet: a branch this command makes, a loop variable, a typo | Refused |
| `--all`, `--mirror`, `--tags` | Refused: push the refs one at a time |
| Three or more repositories in one command | Refused, since each scan can take 20 s inside a 90 s hook budget |
| A subfolder: `.gitleaks.toml` is looked for at `rev-parse --show-toplevel` | Scanned at the repository's root |
| `git push origin :old`, `--delete`, `--dry-run`, `--help` | Not scanned: nothing leaves |
| `git stash push`, `echo "git push"`, `git log --grep push`, a PR titled "git push", `git -C "$X" log push` | Not a push. No scan and no refusal |

**What the refusals cost.** Read back over the same 2,153 lone pushes, it refuses 81, or 3.8%: 75 refs
it cannot read, nearly all `$TIP:refs/backups/…` archive pushes inside a loop, 3 folders, 2 moved HEADs
and 1 `--all`. The fix for any of them is to name the commit or split the command, and
`PHX_SECRETS_OK=1` remains for a push already read. False reads from text inside `echo` and `grep`: 0.

**The limits that remain, both deliberate:**

- **A commit made inside a script** (`node scripts/foo.mjs && git push`) is not seen as a commit, because
  the hook reads the command and not what a program does. The same goes for a push made by a script.
- **A command whose quotes do not balance** (a stray apostrophe in unquoted text, about 3 of 5,091) can
  hide a push inside what reads as one long quoted string.

`PHX_SECRETS_OK=1` is unchanged: in the command or the environment, it stands down every part of C12.
Pinned by `tests/secret-scan-push-guard.test.ts`, sections 10 to 16, through the real hook.

**What it costs.** This is the usual way a session pushes. In the Phoenix transcripts touched in the 14
days to 3 Nov 2026, 2,607 of 4,279 push calls committed first, in 580 of the 745 sessions that pushed.
So most sessions would meet the refusal once, at one extra step each, unless told first. The **Git**
cluster of `docs/agents-session-traps-clusters.md` carries the cue, which the trap injector hands a
session the first time it touches git.

**What it still does not see.** These are limits of the scan, not of this refusal:

- A commit made inside a script: `node scripts/x.mjs && git push` shows no commit to read.
- A lone push C12's own pattern does not recognise, so no scan runs at all: `git -C <folder> push`
  (67 of those 4,279 calls), `git -c <key=value> push`, `timeout 60 git push`, `if ($?) { git push }`.
  That is why the refusal asks for a plain `git push`.
- A push of something other than HEAD: the scan reads `origin/main..HEAD`, so
  `git switch other && git push` and `git push origin other` read the wrong range.
- A command run from a subfolder: both the scan and this refusal look for `.gitleaks.toml` in the
  folder the push runs in, not in the folders above it.
