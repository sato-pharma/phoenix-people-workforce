# The hook dispatcher — every PreToolUse hook in one process

Since 2026-10-08, `.claude/settings.json` has one PreToolUse entry. It runs
`.claude/hooks/hook-dispatch.mjs`, which runs the nine project guards in its own process. The guards
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
| weekly-review-readonly | Write\|Edit\|NotebookEdit\|Bash\|PowerShell\|mcp__ | 15 | the user dispatcher |
| scratchpad-guard `pre` | Bash\|PowerShell | 90 | the user dispatcher |
| risky-allow-guard | Write\|Edit | 10 | the user dispatcher |
| dev-server-reaper | Bash\|PowerShell, `async` | 10 | **its own entry in settings.json** |

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
