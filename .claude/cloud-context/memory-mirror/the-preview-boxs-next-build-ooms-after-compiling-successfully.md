---
name: the-preview-boxs-next-build-ooms-after-compiling-successfully
description: "The preview box build is OOM-killed by CONTENTION, never by its own size — and the per-stage typecheck lock was NOT enough: `lint` and `test` take no lock, so a second session's `all` kills a build anyway (measured twice, 2026-10-04 and 2026-10-05). The run now takes /tmp/phx-remote-check.lock for its WHOLE duration — a different file from the per-stage one, because flock locks a file description and re-taking the same one would deadlock the run against itself. Exit 137 is SIGKILL after `Compiled successfully` and now reports NO VERDICT (exit 4), never FAIL. And a lock cannot bind a branch that never heard of it, so remote-check now ASKS THE BOX before it pushes anything — it reads /proc/*/cwd for a process under remote-check/runs/ and REFUSES to start a second run (PHX_CHECK_FORCE=1 overrides); the probe fails CLOSED, so an unreadable answer refuses rather than reading as an idle box. And ssh exit 255 (`Connection reset by peer`) is the TRANSPORT, never the branch - it arrived after two stages had already printed PASS and was reported FAIL, halting a push; it now exits 5 as NO VERDICT, and SSH_OPTS carries ServerAliveInterval=30/CountMax=10 because `next build` is silent for minutes. An automated chain must RETRY 2, 3, 4 and 5 - only 0 and 1 are verdicts. Capping workers or heap is measurably inert."
metadata:
  node_type: memory
  type: reference
  originSessionId: 369b9c60-2032-48eb-8853-ad2148939e4f
  modified: 2026-10-05T08:14:39.512Z
---

🔴 **CORRECTED 2026-10-05. The earlier version of this note said the build "now fails" on the box
and left the stage uncovered. That was true of one reading and false as a standing fact** — the
build runs fine here; it has no headroom, which is a different problem with a different fix.

**What was actually measured** (`phx@46.225.184.142`, 7740 MB RAM, 4 CPUs, 8 GB swap), four runs,
sampled every 10s for `free -m` and per-process RSS:

| workers (`PHX_BUILD_CPUS`) | heap cap | result | peak available | peak `next-build` RSS |
| --- | --- | --- | --- | --- |
| 2 | 3072 MB | PASS 113s | 307 MB | — |
| 2 | 2048 MB | PASS 118s | 213 MB | — |
| 1 | 2048 MB | PASS 123s | 215 MB | 6455 MB |
| 3 (uncapped control) | none | PASS 118s | 295 MB | 6458 MB |

**The uncapped control passes**, so no cap was ever the fix. Both knobs are inert because the
"workers" are **threads inside a single `next-build` process** — `next-server` and `node` sit
beside it at 5 MB and 2 MB — and its ~6.4 GB is Turbopack's **native Rust** allocation, which
`--max-old-space-size` does not bound and `experimental.cpus` barely moves.

**The real constraint: ~7.4 GB of a 7.7 GB box, whatever you pass it.** It survives alone and dies
beside anything substantial — which is exactly the 2026-10-04 reading, ~300s to die against ~118s
to finish, and three concurrent checks have left this box at 250 MB available on their own.

🔴 **THE PER-STAGE LOCK WAS NOT ENOUGH, AND THE NEXT BUILD PROVED IT THE SAME DAY.** #5333 gave
the `build` entry the typecheck lock; the first run of the new `all` was OOM-killed anyway, in 210s,
at the same "Collecting page data" stage. Sampling the box straight afterwards: two unrelated node
processes holding **~4.7 GB** of 7,740 MB, and a second `remote-check` minutes later — a
`tsc --noEmit` at **5,499 MB**. **`lint` and `test` take no lock at all**, so a second session's
`all` collides on its two unguarded stages, and the box also carries a standing preview dev server.

**The unit of exclusion is the RUN, not the stage.** `buildRunScript` opens
`/tmp/phx-remote-check.lock` on fd 9 and holds it for the whole run. A **different file** from the
per-stage lock on purpose: `flock(2)` locks an open file *description*, so re-taking
`/tmp/phx-typecheck.lock` inside the typecheck would deadlock the run against itself. It falls
through to a warning after 30 minutes and never fails the run — a lock that can turn a check red is
a check people learn to skip. 🔴 **Do not add `PHX_BUILD_CPUS` or `NODE_OPTIONS` back** — the table
above is what happens, and ci.yml's `PHX_BUILD_CPUS: 4` is a different host with a different
failure (47 visible CPUs, a thread-spawn abort), not a precedent for this one.

🔴 **Exit 137 is SIGKILL, is never a code error, and now reports NO VERDICT (exit 4) rather than FAIL.** The build prints `✓ Compiled successfully`
first and is killed after, so a 137 says nothing about the branch — compilation, the stage that
catches a client/server boundary violation, had already passed. Read `main`'s own `Build` step
before spending a minute on it.

**The coverage gap is CLOSED on the `all` side (2026-10-05).** A PR's CI still does not build
(`validate` builds only on non-PR events), but `remote-check all` now INCLUDES the build, so the
standing pre-push step covers it instead of leaving it to the `main` commit. `all` is ~7 min. A build failure on `main` does not go red loudly — it makes
Railway **withhold the deploy**, which looks like a successful one until `/api/healthz` `revision`
is read; see [[a-merge-is-not-a-deploy-read-healthz-revision]].

🔴 **AND A LOCK CANNOT BIND A BRANCH THAT NEVER HEARD OF IT — SO THE BOX IS ASKED FIRST.** The
run-level lock only serializes runs whose branch carries it; every older branch still walks straight
in. Measured 2026-10-05 while shipping this very change: **three concurrent runs** on the box at
once, from three sessions. So `remote-check` now reads the box's own `/proc/*/cwd` in the state call
it already makes, before the push, and **refuses to start when any process sits under
`remote-check/runs/`** — naming the run ids it found. `PHX_CHECK_FORCE=1` overrides it.

**The probe fails CLOSED.** It ends with `PROBE_OK`; without that marker the answer is UNKNOWN and
the run refuses, because an empty string, an ssh error or a truncated read would otherwise be
indistinguishable from an idle box — the one misreading that would reintroduce exactly the collision
this prevents. It uses no `pgrep`, `lsof` or `fuser`, none of which the box has.

🔴 **THE REFUSAL IS A QUEUE SIGNAL, NOT A VERDICT — an automated chain must RETRY it.** A
wrapper that polls the box until it is idle and *then* runs `remote-check` still loses the race:
another session started a run in the gap between the poll and the probe, and the chain read exit 2
as "did not pass" and halted without pushing. Retry exit 2 on a timer; never reach for
`PHX_CHECK_FORCE=1` to get past it, which is the collision wearing a different hat.

🔴 **Stopping the LOCAL wrapper does not kill the REMOTE run.** A stopped background task left a
37-minute orphan holding the box, and the new refusal then reads it as a live run — correctly. Kill
it by its run directory: match `/proc/*/cwd` under that run id and `kill -TERM`, then `-KILL`.

🔴 **AND SSH EXIT 255 IS THE TRANSPORT, NEVER THE BRANCH.** Measured 2026-10-05, the first run
after the busy refusal shipped: `--- lint PASS in 181s ---`, `--- typecheck PASS in 124s ---`, then
`client_loop: send disconnect: Connection reset by peer`, exit 255 — reported as **FAIL**, which
halted a push over a dropped TCP connection. The generated box script only ever exits 0, 1, 3 or 4,
so **255 can only be ssh**. It now exits 5 as NO VERDICT and says any stage that printed PASS really
did pass. 🔴 **But "run it again" was WRONG: the stranded run KEEPS GOING and KEEPS THE LOCK** —
four processes were still working under the run directory with a LIVE `sshd-session` ancestor, so
neither "the connection died" nor "the sshd is gone" tells the box a run is abandoned. A re-run
meets its own predecessor and is refused. The refusal prints how to reap ONE run by its own
directory; never a blanket `pkill`, which takes another session's live run. `ClientAliveInterval`
in the box's sshd_config would fix it server-side but `phx` has no passwordless sudo. The cause is fixed too: `SSH_OPTS` carries `ServerAliveInterval=30`,
`ServerAliveCountMax=10`, `TCPKeepAlive=yes`, because `next build` prints nothing between "Collecting
page data" and its summary and a silent channel is what a NAT or firewall idle timer reaps.

🔴 **SO ONLY 0 AND 1 ARE VERDICTS.** 2 (another run owns the box), 3 (the tree moved), 4 (OOM-killed)
and 5 (connection dropped) all say nothing about the code — an automated shipping chain retries every
one of them and halts only on 1.

🔴 **A WEAK BREAK READS AS A MISSING TEST.** Changing `status === 255` to `status === 2550` did not
fire the assertion — `255` is a substring of `2550`, so the regex still matched. The arm had to be
deleted outright. A break that does not fire is not evidence; it is a break that did not land.

Account: `docs/ci-self-hosted-runner.md`, "The build OOM was contention, not size".
