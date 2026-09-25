---
name: turbopack-cannot-resolve-a-junctioned-node-modules-here
description: "next dev fatals on a junctioned worktree with \"Symlink [project]/node_modules is invalid\" — but that is TURBOPACK only; the explicit --webpack flag runs fine there (corrected 2026-08-29)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5a20639a-f9ab-4e8c-90fb-5937b0daeb67
  modified: 2026-08-29T16:35:00.000Z
---

`next dev` in a `.claude/worktrees/<name>` worktree panics as soon as it serves the first route, with
`Error [TurbopackInternalError]: Symlink [project]/node_modules is invalid, it points out of the
filesystem root`. Reproduced twice on 2026-08-28, both with `--turbopack` and without it — Next.js
16.2.11's CLI banner prints "(Turbopack)" either way.

🔴 **CORRECTED 2026-08-29 — there IS a fallback, and this file previously said there was not.** The
explicit `--webpack` flag works. `node node_modules/next/dist/bin/next dev --webpack --port 3000`
started in a junctioned sibling worktree (`_wt-admin-calculator`, Next 16.2.11) and printed
`▲ Next.js 16.2.11 (webpack)` / `✓ Ready in 1770ms`, then served `/admin` 200 and ran a full browser
verification session — dev-auth, hydration, HMR after a source edit, all fine. The earlier attempts
only ever tried *with* and *without* `--turbopack`; **neither is the same as passing `--webpack`**,
and concluding "no webpack fallback from the CLI flag alone" from those two data points was the
error. Turbopack's Rust resolver is what rejects the junction; webpack's resolver does not care.

**Root cause, as far as reproduced:** the worktree's `node_modules` was a **Windows directory
junction** (`New-Item -ItemType Junction`) pointing at the primary checkout's real `node_modules`,
per `AGENTS.md` §5's own prescribed pattern ("junction node_modules from the primary"). Turbopack's
Rust-side resolver treats that junction as a symlink escaping the project root and refuses to start.
A dev server running from the **primary checkout** at the same time, same repo, same Next version,
had no such problem — its `node_modules` is a real directory, not a junction, which is the one
variable that differs.

**Why:** AGENTS.md's junction-based worktree setup is written and tested for `typecheck`/`lint`/
`node scripts/…` — none of which go through Turbopack's project-root resolution. `next dev` is a
different consumer of that same junction and hits a path this repo's own worktree tooling had not
exercised before.

**How to apply:** in a junctioned worktree, reach straight for `--webpack` — do not retry Turbopack
and do not conclude the worktree cannot run a dev server. Only if `--webpack` also fails should you
fall back — either verify against the primary checkout's already-running server (if
one exists and is confirmed idle/available) or treat data-level verification (unit tests run directly
against the real source file, or a before/after diff against live production rows) as sufficient proof
for a change that has no visual/CSS component. This is exactly the situation on 2026-08-28: the
`candidate-role-family.ts` Area→District reclassification was already proven three independent ways
(direct test execution, full production title diff, live production row classification) before this
was attempted — the browser check was a confirmatory extra, not the only evidence, so hitting this
blocker did not leave the change unverified.

Not yet tried: copying `node_modules` instead of junctioning it (AGENTS.md explicitly warns against
this — ~1.9M path amplification per worktree) or a Turbopack env var to disable the root-escape check.
If this recurs often enough to matter, that is the next thing to investigate — file it as a real
`AGENTS.md` §5 addendum if a fix is found, since the section currently states junctioning as the
default with no caveat for `next dev`.
