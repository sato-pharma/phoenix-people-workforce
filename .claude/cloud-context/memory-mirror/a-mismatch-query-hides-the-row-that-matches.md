---
name: a-mismatch-query-hides-the-row-that-matches
description: "A query that finds disagreements by filtering `a is distinct from b` cannot see the rows that agree, so a customer with three pharmacies in two areas looks like a simple fixable split — always re-read the WHOLE set for the entity before proposing a move"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f151c304-4f1a-4527-86ae-ce961d80f72e
  modified: 2026-09-29T19:04:42.569Z
---

Finding disagreements by filtering on the disagreement is the trap. The filter that defines the
finding also deletes the evidence that would overturn it.

**Measured 2026-09-29.** A sweep for customers whose area differs from their pharmacy's ran

```sql
... where c.area_id is distinct from p.area_id
```

and reported محمد رويشة as split between his area `D14` and two pharmacies in `D15` — which reads
as an obvious re-file onto D15. He actually has **three** pharmacies:

```
الشفاء الجديدة   D14 Tanta     319 m   code 361157      -> D14   <- INVISIBLE to the query
القاضى           D15 Mahalla   251 m   code 0001507348  -> D15
محمد منديشة      D15 Mahalla    55 m   code 1507324     -> D15
```

The D14 one was filtered out **because it matched**. Moving him to D15 would not have closed a
split, it would have traded one for another and stranded الشفاء الجديدة. No single area unifies
him — which is exactly the condition the app's own `agreedMasterAreaCode` refuses to act on.

**Why:** the owner acts on these lists. A move he authorises from an artefact is a real territory
change, and he authorised this one — it was refused and explained instead of being done.

**How to apply:**

- Never propose a move from the mismatch rows alone. **Re-query the entity's FULL set of related
  rows** — all pharmacies for that customer, all codes for that pharmacy — before naming a target.
- State the disagreeing set AND the agreeing set in the report, so "3 pharmacies, 2 areas" is
  visible rather than "2 pharmacies in the wrong area".
- The general form: any `where x is distinct from y` finding is a *sample*, never a census of the
  entity. The same shape bites on code↔area, GPS↔governorate and manager↔team checks.
- When no single value unifies the set, **say so and stop** — do not pick the majority. Related:
  [[the-marketing-code-resolver-never-re-runs]].
