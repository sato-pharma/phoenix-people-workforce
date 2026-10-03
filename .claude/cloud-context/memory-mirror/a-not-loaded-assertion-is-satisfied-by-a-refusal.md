---
name: a-not-loaded-assertion-is-satisfied-by-a-refusal
description: "A test asserting something is \"never loaded\" passes when the code REFUSES it and tells the user he got it wrong - so the user-facing half is unpinned; and a mode wired at the screen and the SQL with nothing pinning the SERVICE between them ships a feature that does nothing, green."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d41425c2-6025-431c-a298-1dba017ffbf4
  modified: 2026-10-03T04:49:59.897Z
---

Two sibling traps, both found on PR #5202 (the SFE list template, 2026-10-03), both of which left
**green tests over a broken feature**. Each is about a test that measures one half of an outcome.

## 1. "Not loaded" is satisfied by a refusal

The template's guidance row rode as the sheet's first data row. The test said:

```ts
assert.equal(parseTemplateRow(...).kind, "refused", "the sheet's own hint row is never loaded as a customer");
```

True, and useless. **A refusal satisfies "not loaded"** — so the test never looked at what the SFE is
*told*, and every upload of an untouched template came back refusing the instruction line Phoenix
itself had written, telling him to go and fix it. The assertion described the outcome I did not care
about and skipped the one I did.

**The fix that actually holds is the whole-artifact question:** feed every row of the real built
workbook through the real importer and assert it refuses **nothing**. That is what then found a
*second* bogus refusal nobody had reported — `writeHouseTable`'s own note line, printed inside the
span the importer reads. One assertion about the artifact beat two about its parts.

**So: when a rule is "X is not treated as data", pin what the USER SEES, not just what the store
receives.** `blank` and `refused` are both "not loaded" and only one of them is correct.

## 2. Both ends pinned, the seam pinned by nothing

The Validate screen sent `mode: "listed"`. The SQL had its `listed` branch. `validateCustomer`
in between knew only `reference`, `new` and `outside`, and fell through to *"Reload the page and try
again."* **Every customer loaded from a sheet would have sat in To validate for ever** — the whole
feature shipping as a no-op, with the migration applied and nothing red.

A test pinned the screen's payload. A test pinned the SQL branch. Nothing pinned that the service
accepts the mode the screen sends and forwards the key the SQL reads.

**So: when a value crosses layers, pin the CHAIN in one assertion block** — derive the set from one
end and require the others to honour it:

```ts
const sent = [...screens.matchAll(/mode: "(\w+)"/g)].map((m) => m[1]);
for (const mode of new Set(sent)) assert.ok(new RegExp(`mode === "${mode}"`).test(service), ...);
```

Then a mode added at one end and not the others fails in CI, not in a rep's hand at a clinic door.

## The common shape

Both are [[verify-the-emitted-artifact-never-the-source]] wearing a test's clothes: the assertion was
about a *component's* behaviour, and the defect lived in what the component *composed into*. Related:
[[choosing-test-suites-by-grepping-your-symbols-misses-the-source-pinning-ones]] — the same PR's
`"doctor name"` alias violated an owner rule and only the full off-laptop suite caught it.

**How to apply:** before calling a test suite coverage of a feature, ask it two questions — *what
does the user see when this passes?* and *which seam between layers does nothing assert?* A review
bot found all of these; the suite had not.
