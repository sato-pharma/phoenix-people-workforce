# The weekly dependency refresh

**What it is.** Every Sunday at 10:00 Cairo a Windows task on the laptop re-resolves every package in
`pnpm-lock.yaml`, transitive ones included, to the newest version its declared range allows, and
opens one pull request listing every package that moved. Its required checks are the gate; merging is
the owner's own word, as for every PR.

**Why** (owner, 2026-10-23: *"schedule the recurring pnpm update the fast-uri note says is due"*).
Most of the Dependabot alerts here share one shape: the range in the graph already allowed the patched
version, but the lockfile had resolved the version before it, and nothing ever re-resolved it. fast-uri
hit it five times between August and 30 September 2026, each time answered by hand-raising a floor in
`pnpm-workspace.yaml`. The note on that floor said a fifth occurrence called for a scheduled
`pnpm update` instead. hono and ip-address hit it again on 2026-10-23 (PR 6270).

## How one run goes

1. `~/.claude/scripts/deps-refresh-run.mjs` (a copy of `scripts/deps-refresh/run-refresh.mjs`) fetches
   `origin/main`, makes a throwaway detached worktree there, and runs that tree's
   `scripts/deps-refresh/refresh.mjs`. So the logic that runs is always what merged.
2. `refresh.mjs` stops at once if a refresh PR (branch `codex/weekly-deps-refresh-*`) is still open.
3. It pushes a branch identical to `main`. That starts no CI, because `ci.yml` runs on a push to `main`
   only. It then dispatches `lockfile.yml` on that branch with `mode=refresh`.
4. On GitHub, `lockfile.yml` runs `pnpm update --depth Infinity --no-save`:
   - `--depth Infinity` reaches the transitive packages, which a plain `pnpm update` never touches.
   - `--no-save` leaves every range in `package.json` as written, so the exact pins (`next`, `react`)
     never move.
   - The release-age quarantine still applies.
5. It downloads the regenerated files and stops in one of three ways:
   - **Nothing moved:** it logs `NOCHANGE` and deletes the branch.
   - **`pnpm-workspace.yaml` changed:** pnpm wanted a `minimumReleaseAgeExclude` entry, which the
     floors' notes refuse. It logs `REFUSED`, deletes the branch and opens nothing.
   - **Otherwise:** it commits the lockfile and opens the PR with a table of every package that moved.
6. The launcher writes every line to `~/.claude/scripts/deps-refresh-task.log` in Cairo time, and
   removes the worktree.

**Why the PR is opened from the laptop and not from a workflow cron.** A pull request a workflow opens
with its `GITHUB_TOKEN` starts no CI, so its required checks would never report and it could never
merge. The heavy part, pnpm resolving the graph, still runs on GitHub; the laptop only pushes, waits and
opens the PR.

`lockfile.yml`'s default mode is still `regenerate`, which is what `remote-check.mjs lockfile`
dispatches; that path moves nothing but the manifests a branch changed.

## Commands

| Task | Command |
| --- | --- |
| Install or re-install the task | `powershell -ExecutionPolicy Bypass -File scripts\deps-refresh\install-task.ps1` |
| Another day or time | `... install-task.ps1 -Day Monday -At 09:30` |
| Remove the task | `... install-task.ps1 -Remove` |
| Rehearse without opening a PR | `node scripts/deps-refresh/refresh.mjs --dry-run` from a spare checkout; it switches that checkout to a new branch, and deletes the remote branch it pushed |
| Read what the last run did | `~/.claude/scripts/deps-refresh-task.log` |

A floor in `pnpm-workspace.yaml` is still how an advisory is answered on the day it lands. The refresh
is what stops the next allow-but-resolve-below advisory from needing one.

Pinned by `tests/deps-refresh.test.ts`; `refresh.mjs`'s flag gate by `tests/unknown-flag-gates.test.ts`.
