---
name: a-rule-script-run-in-the-primary-reads-its-stale-checked-out-code
description: "The primary checkout's local `main` is never fast-forwarded, so a rule script run there computes the LIVE side from pre-merge code — `check-store-split-drift.ts 2026-09` read DRIFTED with 213 cells and 45,021.99 EGP minutes after the net was rebuilt correctly, and read \"no drift, 492 frozen cells match the rule\" from a worktree on origin/main."
metadata:
  node_type: memory
  type: project
  originSessionId: 61ac0cfb-9a45-4123-ac88-7f2173f492b1
  modified: 2026-10-09T16:43:38.603Z
---

Measured 9 October 2026, 19:45 Cairo. Three merges had shipped that evening (#5687 طاى جروب,
#5688 the Ivyronc narrowing, #5689 the `تامين` government depots), another session had rebuilt the
September store-split net from a worktree carrying all three, and `check-store-split-drift.ts`
reported clean there. Run in the PRIMARY minutes later the same script said:

> `2026-09 unpublished (live) — DRIFTED` · 213 cells across 84 line × area pairs · frozen 492 vs
> live 479 · 45,021.99 EGP ends up on a different area

**Both runs were honest; one was reading old rules.** `git worktree list` showed the primary at
`077e838dd` while `origin/main` was `3abb526f3` — nobody ever fast-forwards the primary's local
`main` (AGENTS §5 forbids committing there, and a live peer session holds the folder), so its
`src/lib/sales/**` is whatever was checked out last. A drift check compares a FROZEN database net
against a net the local code recomputes, so stale code moves the live side and every newly merged
rule reads as drift. The giveaway was in the report itself: `cns D24 −4,444.65 / D25 +4,444.65` is
exactly the movement #5689 had just introduced, i.e. the rule the local tree did not have yet.

**How to apply.** Any script that RECOMPUTES a rule — `check-store-split-drift.ts`,
`check-office-allocation-drift.ts`, `backfill-attribution-store-split.ts`, a closing reconciliation —
is only as current as the tree it runs in. Before trusting one, print the tree:
`git log -1 --format=%h` and compare with `git rev-parse origin/main`. If they differ, run it from a
worktree created on `origin/main` (`node scripts/new-session.mjs <task>` — it branches from
`origin/main`, so it carries every merge) and read it there. The same drift check then answered
`no drift. 492 frozen cells match the rule.`

A pure DATABASE read (row counts, values, `created_at`) is unaffected; this bites only the scripts
that bring the rule's own code to the comparison. Related:
[[verify-the-emitted-artifact-never-the-source]],
[[office-allocation-goes-stale-when-a-batch-is-remapped-after-it]],
[[publishing-one-line-freezes-the-whole-periods-store-split-net]].

🔴 **AND IT DOES NOT ONLY MISREAD — IT WRITES.** The same primary at `077e838dd` ran
`backfill-attribution-store-split.ts --apply 2026-09` at 19:35 Cairo on 2026-10-09 and PUT
**423 rows** of net into production (Pedia 87 / Anti Infective 47 / CNS 289), computed without
PR 5685's twelve stems, 5687's طاى جروب and 5689's `تامين` — three rulings merged earlier the same
evening and live on production at the time. Current code on `origin/main` gives **CNS 309 and Anti
Infective 53**, so the stale write was 26 relocation cells short on those two lines, and the figure
was quoted to the owner before it was caught. A rebuild run from `_wt-september-net-recheck` on
`f99947835` corrected it the same night. **Before any `--apply` of a rule-recomputing script, print
`git log -1 --format=%h` and `git rev-parse origin/main` and refuse to run them unequal** — a read
that lies is recoverable in a sentence, a write that lies sits in production as the number a manager
is paid on.
