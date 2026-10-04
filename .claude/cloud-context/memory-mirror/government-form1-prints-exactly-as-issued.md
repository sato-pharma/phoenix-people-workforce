---
name: government-form1-prints-exactly-as-issued
description: "Owner rule — social-insurance Form 1 and Form 6 print as the Authority issues them, duplex; the back page's identification blanks (company name, insurance number, address, insured name and number) DO print data since 2026-09-03 (Form 1) and 2026-10-04 (Form 6); signatures never."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ad53de17-d4b2-4840-be09-4ee95dd4eaa5
  modified: 2026-08-22T15:24:47.624Z
---

**Owner instruction, 2026-08-22, verbatim:** *"No. No. No. Don't you ever change in the template I
uploaded to you? It's a governmental template as it is exactly. The second page is not as I sent to
you. Don't put your touch."*

He said this after I had written three values (company name, company insurance number, company
address) onto the back page's إقرار blanks. The artwork itself was never altered — a 200 DPI diff
showed zero pixels of mine absent from his original — but **writing anything at all on the back is
"putting my touch" on a government document.**

**Why:** the form is filed with the National Organization for Social Insurance. An office clerk
knows it by sight. Anything Phoenix adds is a deviation from the issued document, and it is the
owner's company that carries the consequence, not the person who thought the blank looked helpful.

**How to apply:**

- `FORM1_PAGE_2_PLACEMENTS` in [src/lib/hiring-pack/form1-layout.ts] is `[]` **on purpose**, and
  `tests/hiring-pack.test.ts` asserts it. A red assertion there is the rule firing, not a stale test
   — do not "fix" it by re-adding placements. The four measured back-page coordinates are preserved
  in that file's doc comment, so reversing the decision needs the owner's word, not re-measurement.
- **Form 1 is duplex, obligatory** — page 2 is the back of page 1, and the employee signs it. Three
  copies (its own instruction 1: "من أصل وصورتين"), on **US Legal**, at 100% scale.
- The contract is the opposite: **single-sided, four copies** — its own مادة (19) says
  "حُرر هذا العقد من أربع نسخ", which is where `systemContractDefaults.contractCopies` comes from.
- The same instinct applies to any pre-printed government or bank form he supplies later.

Related: [[marketing-system-validated-means-no-human-looked]] — the same "don't invent what a
document does not say" reflex.
