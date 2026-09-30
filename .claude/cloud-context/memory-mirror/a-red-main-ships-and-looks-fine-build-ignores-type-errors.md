---
name: a-red-main-ships-and-looks-fine-build-ignores-type-errors
description: "A red main still builds, ships and serves perfectly — next.config sets typescript.ignoreBuildErrors, so a type error that breaks a real feature is invisible in the product"
metadata:
  type: project
---

**`main` was red from ~00:41 to ~21:57 Cairo on 2026-08-24 with a live user-facing bug, and
production looked completely healthy the whole time.** `/api/healthz` returned `status: ok`
throughout.

**The mechanism** — [next.config.ts](next.config.ts) line ~137:

```ts
typescript: { ignoreBuildErrors: true },
```

Its own comment says: *do NOT remove this without also confirming typecheck still gates
merges/deploys some other way.* It does gate merges — `typecheck` is a STEP inside the required
`checks` job *(Corrected 2026-10-01 — the gate is TWO, `validate` and `checks`; read the protection API, never this line.)* —
but that check runs on the **PR head**, and "require branches to be up to date" is **OFF**
(`strict: false`, deliberately, because it was the dominant Actions cost). So:

1. Two PRs each go green **alone**, on checks taken before the other existed.
2. Both merge. Nothing ever validated them **together**.
3. `main` goes red — but Railway deploys on push, the build ignores the type error, and the app
   ships and serves.

**What it cost this time.** #2395 added a ninth role family (`sales`); #2396, merged four minutes
earlier, added a table that must list **every** family. Live result:
`screeningBandForFamily("sales") -> undefined`, the sort key went `NaN`, and **sales candidates
scattered at random through the recruitment screening queue while every band header read 0**. A
`NaN` comparison does not throw, so nothing errored anywhere. Fixed by #2404 (`1d638c11`).

**How to catch it.** A green PR is not a green `main`. After merging, check the run **on `main`'s
new head**, not the one from your branch:

```
gh run list --branch main --limit 5 --json headSha,name,status,conclusion
```

Three consecutive red runs (`1139dd6b`, `9381a1f5`, `b837b0ba`) sat there unnoticed because every
individual PR author saw their own green check. **Deploys also overtake CI**: production was already
serving the #2404 fix while its CI run was still `in_progress` — so "waiting on CI" does not mean
"not yet fixed", and equally, "it deployed" does not mean "it passed".

The highest-risk window is two PRs touching the same enum/table/registry within minutes of each
other — exactly what a repo shipping ~30 commits/day produces.

**Where this belongs long-term:** `AGENTS.md` §2.1 under "CI and PRs", which auto-loads in full and
has no byte cliff. It is here instead because it was found while a parallel session held the primary
checkout and repo files could not be safely edited.

Related: [[adding-a-hub-page-trips-four-separate-ci-gates]] ·
[[two-sessions-fixed-one-bug-main-was-never-ci-validated]] ·
[[a-green-test-run-carries-no-type-signal-at-all]]
