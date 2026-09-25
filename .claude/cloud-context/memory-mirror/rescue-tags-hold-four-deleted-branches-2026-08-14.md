---
name: rescue-tags-hold-four-deleted-branches-2026-08-14
description: "A parallel session deleted six local branches 2026-08-14 while another was mid-audit; four held unmerged commits, tagged before gc could reclaim them. ALL FOUR ARE ADJUDICATED and the tags were deleted the same day on the owner's instruction — only outstation-release-payroll-gate was real (merged as #2141, live). DURABLE: tag before ruling, and branch deletion here is never safe on \"merged? no\" alone."
metadata: 
  node_type: memory
  type: project
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-14T17:54:28.034Z
---

On **2026-08-14 at 19:14 Cairo** a parallel session deleted six local branches (17 → 11) while
another session was mid-audit of them. Two were genuinely merged. **Four held commits whose
subjects never appear on `origin/main`**, so their tips were tagged before `git gc` could reclaim
them:

**Every one of these tags has since been deleted** — all four served their purpose and were dropped
on the owner's instruction the same day. The table is the record, not a pointer to live refs:

| Former tag (`rescue/2026-08-14/…`) | Tip | Commits not on main | Outcome |
| --- | --- | --- | --- |
| `outstation-release-payroll-gate` | `67d68281` | 1 | **merged as #2141**, live in production |
| `pr1843-conflict-resolve` | `85d4c6fe` | 2 | superseded, dropped |
| `wip-recovery-clean` | `616383b3` | 4 | superseded, dropped |
| `mm-closing-unpushed` | `bc3122f4` | 2 | superseded, dropped |

**All four are now adjudicated. Only the outstation one was real** — it added
`isOutstationExpenseInPayroll()` to `src/lib/outstation/expense-gate.ts` because
`releaseOutstationRequestToPayrollIfReady` tested the mere existence of an `outstation_expenses` row
and so answered "already in payroll" for every queued-but-unimported claim. Confirmed in production:
**360 rows, all 360 with a null `imported_payroll_batch_id` and a null `imported_to_payroll_at`, 0
genuinely in a batch**, blocking 34 submitted and 3 approved requests. Restored, merged as **#2141
(`8563069a`) and live in production 2026-08-14 19:53 Cairo** — do NOT redo or undo it.

**The other three were SUPERSEDED, and their tags were DELETED on the owner's instruction
2026-08-14.** Do not recreate them. They were never pushed to origin, so the SHAs above are the only
handle left, and only until git prunes unreachable objects (~2 weeks by default). Why each was
dropped:

- `pr1843-conflict-resolve` — its own message declares it a *"BACKUP COMMIT — not proposed for main,
  and not verified working"*. Its channel tie-out fix landed on main in better form as
  `20260806160000_closing_channel_unattributed_buckets.sql` (same production figures, plus a second
  defect: unnamed direct orders filed as pharmacies) and `20260806190000_..._pharmacy_override.sql`.
  One claim in it is now **stale** — the remote branch it says protected commit `877532b3` no longer
  exists, and no PR was ever opened for that head.
- `wip-recovery-clean` — `resolveDirectOrderReportScope` is on main across 14 files,
  `tests/sidebar-role-scoped-headings.test.ts` is byte-identical to main, and
  `scripts/check-sos-product-mapping.ts` is on main at 338 lines against the branch's 269. Landed and
  outgrown.
- `mm-closing-unpushed` — the feature commit is on main by subject, `monthly-closing-portal.ts` on
  main carries the Marketing Manager support, and 3 of its 5 touched files are byte-identical.

**Do not test file existence with `git rev-parse <ref>:<path>`** — it *echoes the argument* instead
of failing when the path is absent, which read as "exists on main" for two files main has never had.
Use `git cat-file -e <ref>:<path>` and check the exit status.

**Do not read "the files exist on main" as "the work landed."** Every file these four branches touch
exists on main; nothing was uniquely created. The correct test is per-branch content review, not
file existence — and *not* `git diff main...branch` either, which compares against the merge base
and answers a different question. Match commit subjects against main after stripping the
` (#NNNN)` that squash-merge appends.

**Branch deletion in this repo is not safe on "merged? no" alone**, and a second session can delete
branches out from under an audit at any moment. Tag before ruling. Related:
[[repo-doctor-no-origin-ref-is-usually-squash-residue]],
[[two-sessions-fixed-one-bug-main-was-never-ci-validated]],
[[gitignored-wt-scratch-makes-a-worktree-look-clean]].
