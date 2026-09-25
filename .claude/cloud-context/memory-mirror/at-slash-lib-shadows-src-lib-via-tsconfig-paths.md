---
name: at-slash-lib-shadows-src-lib-via-tsconfig-paths
description: "@/lib/utils resolves to the ROOT lib/utils.ts, not src/lib/utils.ts - tsconfig tries ./ before ./src/, so editing the src copy changes nothing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0cf5aa32-4d8c-4a73-9b79-a284b8c51694
  modified: 2026-08-28T13:06:32.174Z
---

`tsconfig.json` maps `"@/*": ["./*", "./src/*"]`. **`./` is tried FIRST**, so
`import { cn } from "@/lib/utils"` resolves to **`lib/utils.ts` at the repo root**, and
**`src/lib/utils.ts` is shadowed and never loaded.**

Both files existed holding **byte-identical** copies of `cn` and `formatEmployeeDisplayName`,
which is exactly why this was invisible: the app behaved correctly, so nothing ever pointed at
the duplication. It only surfaced on 2026-08-28 when a real fix was written into
`src/lib/utils.ts` and the running app **did not change at all** - the edited file is not in the
module graph. Roughly 40 minutes went into disproving stale caches, a surviving old dev server,
a wrong port, and browser caching before the resolution order was checked.

**Why the usual checks all pass and prove nothing:**

- `git grep "export function cn"` finds the src copy and looks authoritative.
- The import specifier (`@/lib/utils`) does not say which file wins.
- The edited file compiles, typechecks and lints clean - it is simply never imported.
- `.next` chunk forensics is a dead end: the compiled `cn` looks correct either way, because
  the shadowing file also defines a working `cn`.

**How to tell fast, next time.** If an edit to a `src/lib/<x>.ts` has no runtime effect, run
`ls <x>.ts` at the repo root before anything else. `lib/utils.ts` was the only tracked file in
the root `lib/` folder - `git ls-files lib/` returns one line.

**FIXED 2026-08-28** on branch `codex/sidebar-restore-as-it-was`: the real implementation lives
in `lib/utils.ts`, and `src/lib/utils.ts` is now a **re-export** of it rather than a second copy,
so the two can never diverge again and editing either path reaches the same code. Do not restore
a duplicate implementation there.

**This is a resolution-order trap, not a utils trap** - any `@/foo` where a root-level `foo`
exists behaves the same way. Related: [[tailwind-merge-strips-custom-named-font-sizes]], the
defect whose fix was written into the shadowed file.
