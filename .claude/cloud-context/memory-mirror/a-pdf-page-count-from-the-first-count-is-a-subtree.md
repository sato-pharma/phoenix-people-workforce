---
name: a-pdf-page-count-from-the-first-count-is-a-subtree
description: Reading a PDF's page count from the FIRST `/Type /Pages … /Count N` returns a SUBTREE of a balanced page tree, not the document — it reported a whole 15-page handbook as 8 pages and made five complete sections look deleted.
metadata:
  type: reference
---

A PDF's page tree may be **balanced**: a root `/Pages` whose `/Kids` are intermediate `/Pages`
nodes, each with its own `/Count`. A regex that takes the FIRST match therefore reads **one
branch**.

Measured 2026-10-07 on `production-planner-handbook-2026-10-06.pdf`: the `/Count` values in file
order are **8, 7, 15** — the root is the *last*, and the true length is **15**. Reading the first
gave 8, which matched the shape of a real defect so convincingly that it survived three further
checks: page 8 rendered as mid-document with white space below it, the HTML held **13** sections
while "8 pages" suggested only 8 had printed, and sections 9-13 rendered to 6 pages **on their
own**, which read as proof the tail was printable but being dropped. **Nothing was wrong with the
document at all.**

The tell that should have stopped it sooner: rendering prefixes of 8, 9, 10, 11, 12 and 13
sections all reported **exactly 8 pages** while the file grew from 265 KB to 382 KB. A page count
that will not move while the bytes climb is a broken measurement, not a truncating renderer.

**How to apply:** count `/Type /Page` objects (not `/Pages`) and cross-check against the LARGEST
`/Count`, taking the maximum:

```js
const objs = (s.match(/\/Type\s*\/Page(?![s])/g) || []).length;
const counts = [...s.matchAll(/\/Type\s*\/Pages[\s\S]{0,300}?\/Count\s+(\d+)/g)].map(m => +m[1]);
const pages = Math.max(objs, ...counts);
```

A flat tree (one `/Count`, which is what Chrome emits for short documents) hides this entirely —
the period card's 4 and 5 page counts were right by luck, which is why the method looked sound
before it was used on a long document. Instance of the standing rule that an instrument precise
about one thing is not evidence about another: see [[verify-the-emitted-artifact-never-the-source]]
and [[the-four-shapes-a-stale-citation-sweep-misreads]].
