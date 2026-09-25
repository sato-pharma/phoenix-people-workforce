---
name: monthly-closing-matrix-cannot-fit
description: "The Monthly Closing matrix can NEVER fit a screen - CNS is 14 products x 6 metrics, about 9,600px against a 1,144px container. The owner chose a fitting family-grain summary BESIDE it (PR #3287); the matrix keeps its scroll deliberately. Do not 'fix' that scroll."
metadata: 
  node_type: memory
  type: project
  originSessionId: ad7f6844-5aef-4d22-9a7e-51c9934c566e
  modified: 2026-09-05T17:10:20.514Z
---

The fits-the-screen golden rule forbids a horizontal scroll, and the Monthly Closing matrix has one.
**It is not a defect and must not be "fixed".**

The matrix is areas x **PRODUCTS** x six metrics, and CNS also carries the CNS-only Office column.
Width model, validated against the live page on 2026-09-05 (predicted 1,558px for Anti Infective,
**measured 1,559**):

```
tableWidth = area(92) + name(196)
           + products x (466 + office 92)
           + families x 266
           + grand total (110 + 110 + 68 + 96 + 64)
```

| line | products | width | container | over |
| --- | --- | --- | --- | --- |
| Anti Infective | 2 | 1,558px | 1,144px | 1.4x |
| Pedia | 4 | ~2,490px | 1,144px | 2.2x |
| **CNS** | **14** | **~9,600px** | 1,144px | **8.4x** |

Fitting CNS leaves **29px per product** — less than one figure. So the rule's own remedy (merge
columns, never shrink type) does not reach this board, and trimming widths would make only the SMALL
lines fit while CNS still scrolled: a rule holding where it does not matter and failing where it
does.

**The owner's decision, 2026-09-05, asked directly:** leave the matrix exactly as it is — it is the
auditor's detail view — and ship a fitting **family-grain summary beside it**, which also matches
[[the-old-monthly-closing-export-is-never-touched]] ("anything we will do will be aside it").

`ClosingSummaryFits` + `buildClosingFamilySummary` do that: one value and achievement per area per
family, `w-full table-fixed` with a `<colgroup>` of PERCENTAGES so it fits by construction whatever
the family count, cards on mobile. Measured live: 1,228px inside a 1,268px container at 1280, no
overflow at 375, zero rounded elements.

**It is FOLDED from the same matrix object and carries the matrix's own `rowTotal` through
untouched** — never re-queried, never re-added — because a second view of the same money is how
"one area, one number" gets broken. Achievement is recomputed on the summed slice, never averaged
across products; a family whose products carry no target has NO target (summing nulls as zeros
invents one and turns a dash into 0% or Infinity).

The measurement trap that hides all of this: `main` reads clean (1248/1248) because the scroll lives
in an inner container. See [[never-horizontal-scroll-always-mobile-and-desktop-friendly]].
