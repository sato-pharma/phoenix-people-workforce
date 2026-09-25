---
name: arabic-name-search-needs-orthographic-normalization
description: "A plain ILIKE on an Arabic name silently misses most real hits — normalize ة/ه, أإآ/ا, ى/ي and strip harakat on BOTH sides first."
metadata: 
  node_type: memory
  type: reference
  originSessionId: f92f2e0d-b5e9-4641-858a-f7863f7ea89a
  modified: 2026-08-04T08:03:51.314Z
---

Arabic names in this database are spelled inconsistently by the distributors who type them.
Searching `client_name ilike '%الشركة%'` returns a fraction of the real matches because the same
company is stored as `الشركة`, `الشركه`, `الشركـة` and `الشركة` with harakat, all at once.

The fix is to normalize the stored name **and** the search word with the same expression before
comparing:

```sql
lower(translate(regexp_replace(<col>, '[ًٌٍَُِّْـٰ]', '', 'g'), 'أإآٱةىیک', 'ااااهييك'))
```

That strips harakat + tatweel, folds أ إ آ ٱ → ا, ة → ه, ى ی → ي, ک → ك, and lowercases any latin
characters in the name. Verified 2026-08-04 against production `source_of_sales_import_rows` +
`source_of_sales_customer_map` (49,201 sales customers / 45,103 mapped) while finding customers
named مخزن / فارما / تريد / الشركة / الجمعيه / للتجارة.

**Why:** without it the answer looks successful — it returns rows, just the wrong count — which is
the [[no-data-must-never-render-as-absence-or-zero]] failure class in query form. `الجمعية التعاونية`
(3.3M EGP of sales) is invisible to a raw `%الجمعيه%` search.

**How to apply:** pick the SHORTER stem when one word is a prefix of another (`فارم` catches both
فارما and فارماسي — searching both is redundant). Match on the customer's whole set of name
variants, not one row: a code can carry several spellings and only one may contain the word. Key the
customer on distributor + code, remembering direct rows carry an empty code
([[direct-sales-area-code-is-empty-string-not-null]], [[sos-client-code-is-not-unique-across-distributors]]).
This is orthographic folding only — for matching org names to people you still need the token-subset
approach in [[sales-sheet-rep-mapping-join-paths]], never ILIKE.
