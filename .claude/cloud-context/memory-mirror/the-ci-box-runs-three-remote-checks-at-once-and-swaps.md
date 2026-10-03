---
name: the-ci-box-runs-three-remote-checks-at-once-and-swaps
description: "remote-check.mjs serializes only the TYPECHECK (flock /tmp/phx-typecheck.lock, -w 1200) and the box is 7.7 GB — three sessions' checks at once left 250 MB available, load 10.4, and one eslint took 5+ min where it takes 4s warm; a run quiet for 20 minutes is CONTENDED, not hung, so read the box (ssh -i ~/.ssh/railway_phoenix_ed25519 phx@46.225.184.142 'uptime; ps --sort=-pcpu') before killing or re-running it."
metadata:
  node_type: memory
  type: project
  originSessionId: 1baaa0f5-9436-457f-8907-da9439516d28
  modified: 2026-10-03T22:16:42.539Z
---

Measured 2026-10-04 at 01:15 Cairo, while `node scripts/remote-check.mjs all` on
`codex/heard-filename` sat with nothing printed after its `eslint` line for about 20 minutes.

The box was not hung. `uptime` read **load average 10.42** on a **7,740 MB** machine with **250 MB
available**, and `ps` showed, all at once:

- **two** sessions' `remote-check` eslint runs — mine (`runs/4570900788a9-…`, 4:51 elapsed, 86% CPU,
  1.2 GB) and another session's (`runs/e38895cc7016-…`, 3:46, 80.8%, 1.4 GB)
- a third session's `tsc --noEmit --incremental false` (0:48, 2.9 GB) and its `tests/run-tests.ts`
  (2:16, 1.1 GB)
- the **Hetzner preview dev server** on port 3001, up 1 day 2 hours
- the **self-hosted Actions runner** (`RunnerService.js`), up 1 day 15 hours

So the box this repo treats as "the CI box", "the preview box" and "the self-hosted runner" is ONE
7.7 GB machine, and every session that runs `remote-check` gets its own `runs/<sha>-<id>` tree and
starts immediately. With the laptop running ~10 sessions, three arriving together is ordinary, and the
box then swaps: a lint measured at **4s warm** took **325s**.

🔴 **ONE thing IS serialized, and it is the typecheck only** — `flock -w 1200 /tmp/phx-typecheck.lock`
wraps `next typegen && tsc --noEmit`, so a second typecheck WAITS (up to 20 minutes) rather than
putting two 3 GB `tsc` processes on a 7.7 GB box. Nothing serializes lint or the unit suite, and there
is no RAM floor anywhere, so those are what pile up. A `remote-check all` can therefore sit silent
twice over: once competing with another session's lint for CPU, once blocking on that lock — which is
the shape measured here, 325s of lint and then the lock.

**What this changes:**

- **A quiet `remote-check` is CONTENDED, not broken.** Do not kill it, do not re-run it, and do not
  read the silence as a stall — the local `node` process just waits on ssh, so its own CPU time
  (1.3s after 26 minutes) proves nothing either way.
- **Read the box before judging it:**
  `ssh -o BatchMode=yes -i ~/.ssh/railway_phoenix_ed25519 phx@46.225.184.142 'uptime; ps -eo pid,etime,pcpu,rss,args --sort=-pcpu | head; free -m'`
  A plain `ssh phx@…` is **Permission denied (publickey)** — the key is
  `~/.ssh/railway_phoenix_ed25519` (`PHX_CHECK_KEY`), which the script supplies and your own shell
  does not.
- **`remote-check test` costs the box ~1.1 GB and `all` adds a 2.9 GB typecheck**, so the standing
  pre-push step (`AGENTS.md` §7) is cheap for the LAPTOP and not free for the box. Prefer `test` over
  `all` unless the change adds a route, a file or a closed-union member — which is what the rule
  already says, and this is the reason it matters.

Related: [[desktop-slowness-oct-2026-is-thinking-level-and-model-not-memory]] and
[[perf-audit-2026-10-03-ram-is-the-bottleneck-and-two-fixes-that-are-not-safe]] are the same shape on
the laptop — free RAM is the binding constraint, and the fix is fewer concurrent heavy jobs, not a
faster one.
