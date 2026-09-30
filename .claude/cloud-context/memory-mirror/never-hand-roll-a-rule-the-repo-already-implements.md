---
name: never-hand-roll-a-rule-the-repo-already-implements
description: "A hand-written regex for the wholesaler rule found 13 venues where the repo's own guard finds 8 certain and 5 flag-only — importing the real module instead of restating its rule is what stopped 5 real pharmacies being deactivated on the owner's approval"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f151c304-4f1a-4527-86ae-ce961d80f72e
  modified: 2026-09-29T20:55:19.791Z
---

On 2026-09-29 a decision sheet counted the wholesalers in the June venue import with a regex written
for that sheet:

```
مخزن|جمله|جملة|توزيع|تريد|الشركة|الجمعيه|فارما   ->  13 venues
```

The owner read the sheet and approved: *"option A, deactivate the 13 wholesalers and the 18 with no
sales"*. Running the repository's own `src/lib/venues/wholesaler-venue-guard.ts` instead gave a
different and correct answer:

```
isCertainWholesalerVenue   ->  8   hard-block
suspectedWholesalerFlag    ->  5   FLAG ONLY — "never refuse"
pharmacy-protected         ->  1   («المتحدةشركة صيدليات عابدين فارما», protected on صيدليات)
```

🔴 **The regex collapsed a TWO-TIER owner rule into one tier.** «سمارت فارما», «بدر فارما»,
«ادم فارما» and «شركه الخليل فارما» carry only the ambiguous word, which the owner's ruling says must
be flagged for a human and **never refused** — deactivating one refuses a real pharmacy with no
override and no words. Acting on the sheet's 13 would have done exactly that, with his approval,
because the sheet had already told him the number was 13.

**Why:** a restated rule is a SECOND implementation that nothing keeps in step. The guard carries
precedence (pharmacy protectors win first), a named roster, code-keyed overrides and trade phrases —
none of which a regex written from the hook's wording can have. And because the owner decides from
the sheet, a wrong count in a sheet becomes a wrong instruction back.

**How to apply:**

- **Import the module; never restate its rule.** The repo's guards are importable from a script:
  `await import(pathToFileURL(path.join(REPO, "src/lib/venues/wholesaler-venue-guard.ts")).href)`,
  run with `node --experimental-strip-types --experimental-loader ./tests/alias-loader.mjs`.
- Applies equally to `isStoreCustomer`, `resolveGovernorate`, `phx_factory_price`, the closing
  engine and every locked rule: if `AGENTS.md` names a module for a rule, the module is the answer.
- **When a number in a sheet the owner approved turns out wrong, say so and act on the correct one**
  — do not execute the approved number. He approved the intent; the count was mine to get right.
- Where the rule is in SQL (`phx_factory_price`) and a script must recompute it client-side,
  **reproduce the database's own total to the cent before trusting it** — that check is what proved
  the pricing right on the same night.

Related: [[a-pre-gps-backfilled-venue-link-is-not-a-defect]] ·
[[a-mismatch-query-hides-the-row-that-matches]]
