---
name: the-double-add-duplicates-are-not-the-duplicates-board-set
description: "Two different duplicate sets exist in Phoenix CRM — the board's folded-NAME set and the double-add CONTACT-KEY set; the same merge function clears both, so never hand-roll one."
metadata:
  node_type: memory
  type: project
  originSessionId: 4f790619-e7a9-4759-a1bf-d4fc3647d2b8
  modified: 2026-10-12T16:54:56.215Z
---

Phoenix CRM holds **two** duplicate-customer sets, and they barely overlap:

- **The duplicates board's set** — `groupSameRepDuplicates`: one seat, one list type, one *folded name*,
  no speciality conflict. Cleared on 2026-10-08 by
  `scripts/phoenix-crm-merge-same-seat-duplicates.ts` (166 merged, visible as 166
  `customer_merged_out` events).
- **The double-add set** — the same doctor by *contact key*: the rep's own row (`origin 'new'`) and a
  copy the reference refresh minted for him (`origin 'reference'` whose `reference_contact_crm_id`
  equals the rep's `own_contact_crm_id`). The board's name fold never showed these, so 2026-10-08 left
  all of them behind. #5784 closed the hole on 2026-10-12; the rows it left were cleared the same day.

**Both are merged by the one function `public.phoenix_crm_merge_duplicate_customer`** (shipped
2026-10-08) — never hand-roll a loop that drops or deletes rows. It archives the copy as
`status 'dropped'` / `dropped_reason 'duplicate'` and never deletes it, because
`phoenix_crm_ensure_reference_customers` re-mints a deleted reference row within minutes.

**The double-add set needs no judgement about which row stays**: measured over all 244 pairs on
production, every single one had the same shape, so the keeper is always the rep's own row — 0 pairs
where the list type differed, where the copy was validated and the rep's row was not, or where the
copy was older.

**Run it as a loop with a savepoint per group**, so `phoenix_crm:plan_same_day` refuses that one group
and records the reason instead of aborting the run. On 2026-10-12: 168 of 170 merged, 2 refused
because both rows sat on one approved plan for the same day.

Related: [[a-doctor-is-on-a-seat-once]]
