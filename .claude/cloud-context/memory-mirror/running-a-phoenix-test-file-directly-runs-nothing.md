---
name: running-a-phoenix-test-file-directly-runs-nothing
description: "Running a `tests/*.test.ts` file directly under the alias loader executes NOTHING and exits 0 — the suites are EXPORTED functions that `tests/run-tests.ts` calls, so a standalone run prints no output and passing and failing look identical; import the exported `run<X>Tests` and call it, or run the registry."
metadata:
  node_type: memory
  type: reference
  originSessionId: fa0248ab-fe20-4436-83e9-0e1783314a87
  modified: 2026-10-09T01:44:25.634Z
---

A Phoenix test file does not run itself. `tests/module-memory.test.ts` is
`export function runModuleMemoryTests() { ... }` and `tests/run-tests.ts` imports and calls it.
So this, which looks exactly like running a test, runs **nothing**:

```
node --experimental-strip-types --experimental-specifier-resolution=node \
  --experimental-loader ./tests/alias-loader.mjs tests/module-memory.test.ts
# -> no stdout at all, exit 0
```

Node loads the module, defines the function, and exits. **Exit 0 and empty output are the same for a
passing suite, a failing suite and a suite that never ran** — on 2026-10-09 this reported "exit 0"
both with module memory healthy AND with a note deliberately orphaned, which is precisely the
evidence a session would quote as proof.

**The tell is the silence.** A Phoenix suite that actually runs prints something. No output at all
means nothing executed.

**Call the exported function instead:**

```js
const { runModuleMemoryTests } = await import("./tests/module-memory.test.ts");
try { runModuleMemoryTests(); console.log("PASS"); }
catch (err) { console.log("FAIL"); console.log(err.message); process.exit(1); }
```

run that file under the same loader, from the repo or worktree root. Or run the whole registry,
which is what CI does. The exported name follows `run<Area>Tests`; `grep` the test file for
`export function run` to get it.

This is the mirror image of the known rule that a test not registered in `tests/run-tests.ts` never
runs (`docs/testing.md`). The registration rule says CI will not run it; this says **you** did not
run it either, while believing you had.

**A second way the same break test lies:** `Set-Content -Encoding utf8` in PowerShell writes a **BOM**,
so editing `assignments.json` that way makes the file fail `JSON.parse` — the suite then fails on
invalid JSON and you credit the failure to the break you intended. Write the break with node
(`fs.writeFileSync`), assert the first byte is not 0xEF, and restore from a copy rather than
`git checkout --`. Same mechanism as [[railway-stdin-bom-trap]].

Related: [[a-selftest-probed-with-the-wrong-flag-reads-as-no-selftest]] (prints nothing, exits 0, read
as "no selftest exists"), [[check-migrations-applied-exits-zero-when-it-cannot-reach-supabase.md]],
[[verify-the-emitted-artifact-never-the-source]].
