---
name: namesbyhrid-cannot-replace-an-hridsmatch-name-lookup
description: "namesByHrId matches on canonicalHrIdKey ALONE, while hrIdsMatch also matches with punctuation stripped (B-10 = B10) — so folding an hrIdsMatch name lookup into namesByHrId silently loses names; read a whole names roster instead, which needs no .in(hr_id) filter at all."
metadata:
  node_type: memory
  type: project
  originSessionId: f1479c36-700b-425f-a493-804d277da62c
  modified: 2026-10-23T09:05:33.941Z
---

The employees module rule says **an HR id becomes a name through `namesByHrId`, never a hand-rolled
`.in("hr_id", …)` over `employees`** — and that rule is right about the trap it guards (PostgREST
matches case-sensitively, so an un-canonicalised or over-long `in` filter returns **no rows and no
error**). But it does **not** apply to every name lookup, and applying it to one particular shape
loses names silently.

**The shape it must not be applied to: a lookup whose matcher is `hrIdsMatch`.**

- `namesByHrId` keys its index on `canonicalHrIdKey` and asks the database for
  `hrIdLookupKeys(id)` — the trimmed, lower, upper and canonical spellings.
- `hrIdsMatch` (`src/lib/hr-id.ts`) tries `canonicalHrIdKey` equality **and then**
  `normalizeHrIdForAccess`, which is `canonicalHrIdKey(...).replace(/[^a-z0-9]/g, "")` — so it also
  matches **with punctuation stripped**: `B-10` ≡ `B10`.
- `hrIdLookupKeys` never generates the punctuation-stripped spelling. So an item whose stored
  `employee_hr_id` differs from the `employees` row only by a hyphen resolves under `hrIdsMatch` and
  **returns null** under `namesByHrId` — the name falls back to whatever string the request stored,
  with no error anywhere.

**What to do instead when the caller only needs names:** read a **whole** names roster (no id
filter), which sidesteps the `.in("hr_id", …)` trap entirely — there is no filter to get wrong — and
keeps the looser match intact. `getEmployeeNameRoster()` in
`src/lib/employees/employee-directory.ts` is that read: `hr_id, full_name, nickname` plus the six
fields the directory's membership filter decides on, in one query, run through the directory's own
`isActiveDirectoryEmployee` (see [[directory-active-filter-gate]] — a module that bypasses the
directory misses that gate).

🔴 **And membership is the other half of the correctness.** A resigned employee is **absent from the
directory on purpose**, so a resignation item deliberately falls back to the name stored on the
request. Any roster that quietly includes leavers **renames people on the one screen where they are
leaving**. Never filter a names read by `employment_status` in SQL either: `normalizeLifecycleStatus`
reads a blank status as `active`, so a NULL row is a live employee.

Measured on production 2026-10-23 when the action inbox stopped loading the whole directory for
names (PR #6336): 112 of 112 people resolved to the identical name in both directions, and the cold
read went 1,800 ms → 164 ms, 511.6 KB → 65.9 KB.
