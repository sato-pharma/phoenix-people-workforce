---
name: typecheck-incremental-false-green
description: "A local `tsc` can report a FALSE result two ways — a warm tsbuildinfo skipping real errors, and a truncated .next/dev/types/routes.d.ts stopping it after the SYNTAX pass so it type-checks nothing while printing zero. Run cold, and never filter a path out of the output."
metadata: 
  node_type: memory
  type: reference
  originSessionId: c8b118d9-d7e7-4559-a2c4-02262f7b0709
  modified: 2026-09-06T09:40:00.000Z
---

`tsconfig.json` has `"incremental": true` **and**
`"assumeChangesOnlyAffectDirectDependencies": true` (added 2026-07-03 to speed warm local re-checks).

**The trap:** after editing a widely-imported type (e.g. adding a member to a union that drives
`Record<Union, …>` maps in other files), `pnpm run typecheck` can return **exit 0 while real errors
exist** — it reuses `tsconfig.tsbuildinfo` and does not re-analyse files it deems only indirectly
affected. Confirmed 2026-07-30: it passed clean while 3 `TS2741 "property missing in Record<…>"`
errors were live in `action-center-hub.tsx` after a union grew.

**Always verify with a cold check before committing/pushing type-affecting changes:**
```
pnpm exec tsc --noEmit --pretty false --incremental false
```
CI is always cold so it WOULD catch these — but ~~the pre-push hook runs `pnpm run typecheck` (warm),~~ **[CORRECTED 2026-08-27: the pre-push hook is GONE — `.git/hooks` holds only `pre-push.bak-20260730`, verified live. The warm-cache trap below is still real for any `tsc` YOU run by hand; nothing runs one automatically any more.]**
so a false green can sail through the push and only fail in CI. The `--incremental false` run is the
source of truth locally. (The comment in tsconfig claims it "does not affect cold-run time, only
warm re-typechecks" — true, but "warm re-typecheck" is exactly what the local gate runs.)

**It also fires the other way — a FALSE RED that blocks the push.** 2026-08-08, pushing a merge
resolution: the pre-push hook printed `BLOCKED: typecheck failed`, while a cold
`tsc --noEmit --incremental false` had just passed and an ordinary `tsc --noEmit --pretty false`
passed immediately after, on the same unchanged tree. Retrying the push straight away succeeded and
the hook's own typecheck passed that time. The trigger was a just-deleted `tsconfig.tsbuildinfo`
plus a branch switch, so the hook rebuilt state mid-flight.

**So when a warm local `tsc` alone reports a type error you cannot reproduce, re-run it with `--incremental false` before
you go hunting.** Do not start "fixing" a phantom error, and do not reach for `--no-verify`. Note
the hook's failure line is easy to miss: piping `git push` through `tail` makes `$?` the exit of
`tail`, so it reads `EXIT=0` on a rejected push — check for `! [rejected]` / `failed to push`, or
use `${PIPESTATUS[0]}`.

**A SECOND CAUSE, and it is worse — 2026-09-06.** The run above at least type-checks. This one
does not type-check AT ALL and still prints zero. A `.next/dev/types/routes.d.ts` left truncated by
an interrupted dev server carries an unterminated template literal, and a file that fails to PARSE
takes the whole program down: `tsc` reports the syntax pass and never runs the semantic pass. The
output is then nothing but that artefact's own `TS1005`/`TS1160`/`TS1161` lines — so filtering them
away (`| grep -v "^\.next/"`) reads as a clean `0`. Reported clean twice, on two pushes; CI then
failed `typecheck` on four real errors in a test file written minutes earlier.

**So: never filter a path out of typecheck output, and treat ANY `TS1xxx` as "the semantic pass did
not happen" rather than as noise.** `rm -rf .next` and re-run — it is gitignored and regenerated.
CI never hits this, because it starts with no `.next`, which is exactly why it only ever surfaces as
a red PR one push later. Full account: `docs/agents-session-traps.md`, "A local typecheck printed
zero and had type-checked nothing".

Related: [[seven-module-role-access-audit-2026-07-30]] · [[failed-git-piped-to-wc-l-reads-as-zero-dirty]] ·
[[parse-diagnostics-cannot-see-a-typecheck-error]]
