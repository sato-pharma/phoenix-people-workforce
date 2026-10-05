---
name: the-preview-boxs-next-build-ooms-after-compiling-successfully
description: "CORRECTED 2026-10-05 — `remote-check.mjs build` is NOT broken and never needed a cap. The exit-137 kill of 2026-10-04 was CONTENTION: uncapped it passes in ~118s on an idle box, but it needs ~7.4 GB of the 7.7 GB box however it is invoked, so it dies beside anything substantial. Capping is measurably inert — the \"3 workers\" are threads inside ONE `next-build` process holding ~6.4 GB of native Turbopack memory, so `--max-old-space-size` bounds the wrong thing and 2 workers to 1 returned 2 MB for 5 extra seconds. The fix is the `/tmp/phx-typecheck.lock` the build now takes. Exit 137 is never a code error."
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

**So the protection is a lock, not a number.** `remote-check`'s `build` entry takes the same
`/tmp/phx-typecheck.lock` as its typecheck and ci.yml's, so a build waits for a typecheck instead
of racing it into the OOM killer. Pinned by `tests/remote-check.test.ts`. 🔴 **Do not add
`PHX_BUILD_CPUS` or `NODE_OPTIONS` back** — ci.yml's `PHX_BUILD_CPUS: 4` is a different host with a
different failure (47 visible CPUs, a thread-spawn abort), not a precedent for this one.

🔴 **Exit 137 is SIGKILL and is never a code error.** The build prints `✓ Compiled successfully`
first and is killed after, so a 137 says nothing about the branch — compilation, the stage that
catches a client/server boundary violation, had already passed. Read `main`'s own `Build` step
before spending a minute on it.

**The coverage gap is real and unchanged.** A PR's CI does not build (`validate` builds only on
non-PR events) and `remote-check all` is lint + typecheck + test, so `remote-check build` run by
hand is the only pre-merge proof. A build failure on `main` does not go red loudly — it makes
Railway **withhold the deploy**, which looks like a successful one until `/api/healthz` `revision`
is read; see [[a-merge-is-not-a-deploy-read-healthz-revision]].

Account: `docs/ci-self-hosted-runner.md`, "The build OOM was contention, not size".
