---
name: pnpm-run-tries-to-purge-node-modules-when-the-lockfile-moved
description: "Once main's lockfile moves ahead of a checkout's node_modules, ANY `pnpm run <script>` tries to DELETE node_modules before running — it aborts only because there is no TTY, and forcing it through would break every live session sharing that checkout"
metadata: 
  node_type: memory
  type: project
  originSessionId: b974beb4-54ef-40e3-a9b5-e4abda597572
  modified: 2026-08-23T14:35:00.000Z
---

Hit 2026-08-23 running a plain `pnpm run repo:doctor` in the primary checkout. It never ran the
script. Instead:

```
[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] Aborted removal of modules directory due to no TTY
  ... at runDepsStatusCheck
```

**What is actually happening.** pnpm runs a dependency-status check before *any* script. If
`pnpm-lock.yaml` is newer than `node_modules`, it decides the store is stale and its first action is
to **remove the modules directory** and reinstall. Measured that day: `node_modules` dated
2026-08-19, lockfile 2026-08-23 — `4c1e3bad` (#2301, *sharp is a runtime dependency*) had moved the
lockfile while this checkout's install stayed put.

🔴 **The only thing that stopped it was the absence of a TTY.** Non-interactive tool calls have no
TTY, so it aborted. An interactive terminal would have shown a confirm prompt, and the two "fixes"
pnpm itself suggests in the error — `CI=true` or `confirmModulesPurge=false` — **both mean "yes,
delete it".** Do not set either to get past this. With several sessions sharing one checkout (normal
here — 4-6 at a time), deleting `node_modules` mid-flight breaks every one of them at once, and a
reinstall on this 16GB machine is minutes of RAM pressure on top ([[laptop-m17r2-ram-soldered-16gb-ceiling]]).

**How to apply.**

- **To run a repo script without touching the store:** invoke it directly —
  `node scripts/repo-doctor.mjs` instead of `pnpm run repo:doctor`. Worked first time. Most scripts
  in `scripts/` are plain `.mjs` on node builtins.
- **If you genuinely need the deps refreshed**, run `pnpm install` deliberately, as its own announced
  step, when you know no other session is mid-build — never as a side effect of trying to run
  something else.
- **Do not read this error as "repo:doctor is broken."** It is upstream of the script entirely; the
  script never started.

**Why this is easy to misread.** The error names `pnpm install` and a stack inside pnpm's own
bundle, so it looks like a tooling fault in the script you asked for. It is not — it is pnpm
declining to silently destroy state, which is the correct behaviour. Treat the abort as a **guard
that worked**, and route around it rather than disabling it.

## 🔴 The TTY guard is NOT absolute — the store was emptied anyway, 2026-08-23 ~16:01 Cairo

Later the same day the primary checkout's `node_modules` was found **emptied down to 3 entries**
(`.package-map.json`, `.pnpm/`, `.pnpm-workspace-state-v1.json`), `.pnpm` cut 1042 → 791, and
`require.resolve('next')` throwing `MODULE_NOT_FOUND`. Ten other sessions were live in that one
folder. Ruled out: `repo:doctor` (its husk deletion is inside `if (fix)`, and the strip pass logged
"Stripped 0") and this session (never invoked `pnpm`; measured 1042 intact beforehand). **Cause never
established** — most likely another session running a pnpm command in the shared checkout.

**So do not read the abort above as a guarantee.** It stops the purge on *your* non-TTY tool call; it
does not stop a sibling session, and nothing warns you. Symptom to recognise instantly: top-level
`ls node_modules | wc -l` returns ~3 instead of ~54.

**The repair, and the flags that matter:**

```bash
pnpm install --frozen-lockfile --prefer-offline
```

`--frozen-lockfile` because a shared checkout must not have `pnpm-lock.yaml` rewritten underneath the
sibling sessions — one of them would commit the churn without knowing where it came from.
`--prefer-offline` because the surviving `.pnpm` entries link from disk: **32.7s**, not a download.
Verified after: 54 top-level / 1041 `.pnpm`, `sharp` native encode works (libvips 8.18.3), `tsc`
`next` `eslint` binaries run, four real repo tests pass through `tests/alias-loader.mjs`, and a bare
`pnpm run` lists scripts instead of aborting — that last one is the cheapest proof the dep-status
check is satisfied again.

Related: [[dont-skip-validation-for-ram-wait-instead]], [[repo-doctor-strip-idle-cannot-run-with-sessions-open]],
[[another-session-can-remove-a-worktree-under-you]] (same family: shared-checkout actions with
blast radius beyond your own session).
