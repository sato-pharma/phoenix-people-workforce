---
name: git-push-to-origin-hangs-retry-immediately
description: "git push to this GitHub remote intermittently hangs indefinitely; an immediate retry succeeds in seconds — do not wait it out or diagnose it"
metadata:
  node_type: memory
  type: project
  originSessionId: 9174dff8-a94f-4187-b303-cb8cdbd5e8f3
  modified: 2026-08-09T13:00:53.890Z
---

`git push` to `github.com/it-gawish-hr/phoenix-people-workforce` intermittently hangs with no output
and never returns. Observed **three times on 2026-07-31/08-01** in one session (7 min, 9 min, and a
10-min tool timeout). **Every retry succeeded within seconds**, pushing the identical commit.

It is not slowness proportional to payload — the third hang was a 257-line, 6-file commit. Nothing
was ever half-pushed: the remote ref simply did not exist until the retry landed.

**[CORRECTED 2026-08-27 — this is NO LONGER the first thing to check. The pre-push hook is GONE (`.git/hooks` holds only `pre-push.bak-20260730`, verified live), and the real root cause was found on 2026-08-23: `http.postBuffer` was set to 500MB in `.git/config`, and git allocates that whole buffer up front, so a push died before sending a byte whenever free RAM dipped under it. It is now `8388608` (8MB). A hanging push today is NOT this hook. The paragraph below is kept as the record of the 2026-08-09 state.]**

**FIRST rule out the pre-push hook — added 2026-08-09, because "kill at 60s and retry" made it
WORSE.** `.git/hooks/pre-push` (core.hooksPath is the PRIMARY checkout's `.git/hooks`, so worktrees
run it too) is a Node script that runs `check:routes`, `check:migrations`, then — when the push
touches JS/TS/config — `lint` and `typecheck`, with `stdio: "inherit"`. It prints
`Pre-push gate: ...`, but `| tail` swallows that until the pipeline ends, so it looks identical to
the silent hang below. Under RAM pressure that typecheck alone ran **>7 minutes**, and every kill
restarted the gate from zero — two timeouts in a row, no progress. It runs `npm run`, not `pnpm`, so
it is safe in a junctioned worktree, and it does NOT run `build`.

So: let the first push run to completion in the BACKGROUND (no short timeout). Only if it returns
with no `Pre-push gate` output at all does the hang below apply.

**How to apply:**
- If a push produces no output for ~60–90s **and the pre-push gate is ruled out**, kill it and run
  the exact same command again. Do not reason about "probably just slow" — that reasoning was wrong
  all three times and cost ~26 minutes.
- Set a short timeout on the push rather than the default, so the hang surfaces fast.
- After any retry, confirm with `git ls-remote --heads origin <branch>` before opening a PR — that
  is the only cheap proof the ref actually exists remotely.
- Do NOT add `--force` or delete/recreate the branch to "unstick" it. Nothing is stuck; the ref is
  simply absent.

Related: [[dont-foreground-watch-long-pipelines]], [[gh-pr-merge-auto-merges-immediately]].
