---
name: the-cutover-guard-pins-an-exact-count-of-read-sites
description: "`readDoorTests` in tests/crm-cutover.test.ts pins the EXACT number of `.from(<unified view>)` sites per CRM file, so adding a read site reddens the required `validate` job with a bare `5 !== 3` and no file name — plan-board.ts went 3 -> 5 when one paged read became probe + day scan + single scan; raising the number is correct only when every new site reads the UNIFIED view, and because a shard stops at its FIRST failure you must then run every test file that reads the changed source, not just the one that failed."
metadata:
  node_type: memory
  type: project
  originSessionId: c2459188-d8cb-4f56-9232-71f4bd841139
---

Hit 2026-10-10 on PR 5739 (see [[an-offset-page-over-a-union-view-redoes-the-whole-window]]).

🔴 **`readDoorTests` IN `tests/crm-cutover.test.ts` COUNTS READ SITES, EXACTLY, PER FILE.** It asserts
how many times each CRM module names its unified view — `plan-board.ts` was pinned at **3** — so
splitting ONE paged read into a probe, a per-day keyset scan and the single scan kept for a
named-agent or `month` window made it **5**, and the required `validate` job failed with:

```
AssertionError: all three plan-board reads use the unified view …
5 !== 3
```

The message names the OLD count and no file, so it reads like a correctness failure. It is not: the
guard exists to require that every read go through the **unified view**, and **raising the number is
correct precisely when the new sites do.** It is wrong only if a new site reads the vendor table.
Sister assertions pin `reads.ts` at 2 vendor-visits reads, `reps-list.ts` at 2 check-in reads, and
`CRM_CHECKINS_TABLE` at zero — expect the same shape when touching any of those.

**Do not read the three `.from(CRM_PLAN_ENTRIES_TABLE)` reads in `plan-board.ts` as the same
defect.** They are deliberate: verification writes back to the vendor, so it resolves the plan's
identity, first date and last date from the vendor's own rows. They are reads, so "the vendor table
is only written" is NOT an available assertion — the count guard is the only form this check has.

🔴 **A SHARD STOPS AT ITS FIRST FAILURE, SO FIXING THE NAMED TEST PROVES NOTHING ABOUT THE GUARDS
BEHIND IT.** `crm-cutover` threw and everything after it in shard 1/2 never ran. After fixing it,
`git grep -ln "crm/plan-board.ts" -- tests` found **23** test files that read that source, and
running all 23 in one node process is what proved the branch green — about a minute, against a 5m28s
CI round trip per attempt. Do that before the second push, not after the third.
