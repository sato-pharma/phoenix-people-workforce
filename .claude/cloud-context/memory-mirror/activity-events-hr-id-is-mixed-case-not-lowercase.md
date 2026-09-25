---
name: activity-events-hr-id-is-mixed-case-not-lowercase
description: "activity_events.hr_id holds BOTH casings and the split MOVES — B-10 has 12,607 rows as \"B-10\" (frozen since) and 3,137 as \"b-10\" (growing). A lowercase .eq() read 3% of that history when this was found and reads 20% now, so lower() BOTH sides rather than betting on either casing"
metadata: 
  node_type: memory
  type: project
  originSessionId: cb4c91ae-fb4e-4c94-afdf-9fa2898433f8
  modified: 2026-08-21T22:46:45.132Z
---

**Measured on production 2026-08-22:** for the owner over 90 days, `activity_events` holds
**`B-10` → 12,607 rows** and **`b-10` → 443 rows**. Both spellings are live in the same table.

**Why this bites:** `src/lib/activity/service.ts` carries a comment (near `forceLogoutUser`) that
says, in as many words, *do not* copy the multi-spelling matching used for `app_sessions` to
`activity_events`, because that table "stores the LOWERCASE form (23,967 of 23,967 rows), so its own
`.eq(normalized)` is already correct." That was true when written and is not true now. A
`.eq(normalizeHrId(hrId))` against this table today reads **3.4%** of the owner's history.

**How to apply:** read `activity_events.hr_id` with `.in("hr_id", hrIdLookupKeys(hrId))` (from
`src/lib/hr-id.ts`), never a single normalized `.eq`. This is the READ side and is the opposite of
[[marketing-approver-hrid-casing-fk]], which is about never WRITING a lower-cased id into a column
that FKs to `employees(hr_id)` — `activity_events.hr_id` has no such FK, which is exactly why it was
free to drift.

**Why it stays silent:** nothing errors. A ranking, a dashboard, or an activity count built on the
lowercase slice returns a plausible, populated, entirely wrong answer. It was found while building a
top-bar shortcut loader that would have ranked the owner's shortcuts off 443 of 13,050 page views —
**that PR (#2285) was closed unmerged at the owner's instruction on 2026-08-22 and the file no longer
exists**, but the casing split is a property of the production table, not of that work, and still
holds. The next consumer to read this table hits it fresh.

**Before asserting either casing again, re-run the count** — the split moves as writers change:

```sql
select hr_id, count(*) from activity_events
where lower(hr_id) = 'b-10' and created_at >= now() - interval '90 days'
group by hr_id;
```

Related: [[hr-id-normalization-fix-2026-07]] [[how-to-attribute-a-production-write]]
[[dsms-performance-hyphen-stripped-hrid-bug]]

## 2026-09-04 — re-measured: the uppercase half is frozen, the lowercase half is growing

| `hr_id` for B-10 | measured when found | live 2026-09-04 |
| --- | --- | --- |
| `"B-10"` | 12,607 | **12,607** — unchanged |
| `"b-10"` | 443 | **3,137** |
| lowercase share of the history | 3.4% | **19.9%** |

The uppercase count did not move by a single row while the lowercase count grew sevenfold, so new
writes are landing lowercase and the old rows are simply history. **That makes the direction of the
error unstable**: a lowercase `.eq()` was catastrophic (3% of history) and is merely bad (20%)
today, and a bet that the table is "really uppercase" gets worse every week.

**The rule is unchanged and is casing-agnostic on purpose:** `lower()` both sides. Do not
re-derive a percentage and decide one casing is now safe enough — that is the reasoning this
memory exists to prevent.
