---
name: a-lagging-checkout-invents-memory-orphans
description: "`repo-doctor`'s ORPHAN list is fiction on a checkout behind `origin/main` — it resolves module-memory reachability from the WORKING TREE's `.claude/rules/*.md`, and only `AGENTS.md` gets an origin/main rescue, so every note the fold filed since your last pull reads as an orphan."
metadata:
  node_type: memory
  type: project
  originSessionId: 6591b3bf-083c-4444-bb06-41a2779e5795
  modified: 2026-10-08T00:00:00.000Z
---

Measured 2026-10-08. `node scripts/repo-doctor.mjs --no-auth` on the primary at `31d89debe` — **17
commits behind `origin/main`** — printed `5 orphan(s)`. The same command minutes later, after the
checkout caught up (`git rev-list --count HEAD..origin/main` = 0), printed:

```
  268 memory file(s) are reachable from AGENTS.md rather than the index — relocated on purpose
  -> none. Every memory file is reachable and every pointer resolves.
```

All five were module-filed notes. Per slug,
`git grep -l -F "\`<slug>\`" <ref> -- '.claude/rules/*.md'` answered **0 at `31d89debe`, 1 at
`origin/main`** for every one of them. The fold PR had merged; the disk had not caught up.

**The mechanism, and why only half of it is protected.** The check has three reachability channels —
an index pointer, a backticked slug in `AGENTS.md`, and a backticked slug in a module rules file
(`agentsText += readModuleMemoryText(primaryRoot)`). `AGENTS.md` gets a deliberate staleness rescue:
the code also reads `git show origin/main:AGENTS.md` into `originAgentsText` and calls a note an
orphan only when unreachable from BOTH refs, because of a 2026-09-05 incident where a checkout 29
commits behind reported `main-is-not-the-primary-checkout` as an orphan and the advice produced a
duplicate index line (PR #3298 cleaned it up). **The module rules files never got that rescue** —
working tree only. The fold runs three times a day, so on any lagging checkout this is permanent.

**Why it matters more than a miscount:** the printed advice is "give each orphan a line in
MEMORY.md", which is exactly what `AGENTS.md` §2.2 forbids — re-adding a module fact to the index is
the cycle module memory replaced.

**How to apply.** Before believing any ORPHAN line, read `git rev-list --count HEAD..origin/main`;
non-zero means the list is about your disk, not about the repository. And `grep -c assignments
scripts/repo-doctor.mjs` returning 0 does NOT mean it ignores module memory — it reads the EMITTED
rules files, which is the right artifact: `assignments.json` is the filing ledger and a note is
listed there before `build.mjs` writes its line, so keying reachability on the ledger would fail
OPEN, against the function's own stance that the safe failure is to under-claim.

Related: [[verify-the-emitted-artifact-never-the-source]] — the rules file is the artifact and the
ledger is the source, and the same distinction is what makes the ledger the wrong input here.
