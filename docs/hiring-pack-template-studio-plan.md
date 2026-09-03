# HR Forms — the five improvements, and the Template Studio

The plan behind two pieces of work the owner asked for on 2026-09-03, in one place so a later
session can pick either up without re-deriving it.

- **Track A — the five improvements** to the field table and page editor that already exist.
- **Track B — the Template Studio**: *"I am able to upload any document and give it a name and a
  role, and after that it's in the system … adding another template is done inside the system UI
  instead of giving it to you and you making it from the code."*

Track A ships first and on its own. Track B depends on nothing in Track A, but it is much larger,
and doing A first means the editor Track B hands a new document to is already the better editor.

---

## What was measured before planning any of this

Every number below is a reading, not an estimate. They are what make the phases the shape they are.

| Reading | Value | Why it decides something |
| --- | --- | --- |
| Active employees | **108** | The denominator for "who would this rule print blank for". |
| Of those, with any `employee_hiring_profile` row | **5** | A placeholder over a profile field is blank for almost everybody. |
| Of those, with `job_title_ar` stored | **2** | `{{jobTitleAr}}` would blank its whole field for **106 of 108**. |
| Rows in `hiring_pack_document_fields` | **0** | Nothing is at risk yet — the cheapest possible moment to change how rows are keyed. |
| Files referencing `HiringPackDocument` | **13** | The blast radius of widening the document type. |
| Exhaustive `Record<HiringPackDocument, …>` | **6**, across 2 files | Each one silently loses a key when the type widens. See B3. |
| Storage buckets already in use | **11**, all private | A template bucket follows an existing pattern rather than inventing one. |
| Template versions already superseded | **1** (`contract-v1` to `contract-v2`, 2026-08-30) | Version changes are real, not hypothetical. |

### The one finding that makes Track B small

`renderSheet` in `src/lib/hiring-pack/render-placement.ts` is, in full:

```html
<section class="sheet">
  <img class="artwork" src="${svg}" alt="" aria-hidden="true">
  ${fields}
</section>
```

The artwork is **an `<img src>`**, and today that src is a static path such as
`/forms/social-insurance-form1-page1.svg`. Everything else about a government form — the drag,
the drop, the field table, the placeholder engine, the hide, the reset — is already generic over
"an image with absolutely positioned spans at point coordinates".

So the Template Studio is not a new renderer. It is **a different source for that one `src`**, plus
a registry that is data instead of a TypeScript union.

---

## Track A — the five improvements

### A1. Say how many people a rule would blank, before it is everyone's rule

**The failure.** A rule applies to every person the document is printed for, and the editor resolves
it against the ONE employee on screen. With `jobTitleAr` filled for 2 of 108, a rule that previews
perfectly for the person in front of you prints an empty field for 106 others — silently, because one
unresolvable placeholder blanks the whole field by design.

**Build.**

- `GET /api/hiring-pack/field-fill-rate?keys=a,b,c` — for each key, how many of the printable roster
  have a non-empty value. One query over the profile and employee rows, not 108 pack builds.
- Under the existing "Prints:" line: **"Fills for 2 of 108 · blank for 106"**, in the warning tone
  once the blank count is material, with a disclosure listing who.
- A **dry run**: render the paper with the pending rule applied but not saved, so the effect is
  visible before it becomes everyone's. Today a rule only appears on the page after it is committed.

**Not a blocker.** The owner's standing rule is that the system flags, never refuses. A rule that
blanks for 106 people may be exactly right — being told is what matters.

### A2. Carry the layout forward when a template gets a new version

**The failure.** Field rows are scoped to `template_version_id`. `contract-v1` was superseded by
`contract-v2` on 2026-08-30, so version changes happen. When the next one lands, every rule and every
added box written against the old version stops appearing, with no error — the field is simply back
where it started, and nothing on any screen says why.

**Build.**

- A `carryForwardDocumentFields(document, fromVersionId, toVersionId)` service: copy every row,
  keeping geometry and source, under the new version id.
- Offer it in the editor when the current version has zero rows and an older version has some:
  *"v2 has 7 changes you made. Bring them over?"* — with a preview of what carries.
- **Never automatic.** A page document's coordinates are read off the authority's artwork; if the
  artwork moved, carrying a coordinate forward puts text in the wrong place. Carrying is a decision
  a person makes with the two versions in front of them.

### A3. A record of what a field used to say

**The failure.** `updated_at` and `updated_by_hr_id` are written on every save and displayed nowhere,
and a save **overwrites** — the previous rule is gone. On papers people sign, "what did this field
print in September" has no answer.

**Build.**

- `hiring_pack_document_field_history`: append-only, one row per save, holding the previous source
  and geometry. A statement-level `BEFORE TRUNCATE` trigger, per the house rule for append-only
  tables — `TRUNCATE` fires no row triggers and a revoke never binds the table owner.
- In the table, on any row you have rewritten: *"changed 12 Sep, 14:20"*, opening to the history.
- **Lead with the date, not the name.** `updated_by_hr_id` is known to be unreliable across this
  system; the timestamp is the trustworthy half.

### A4. Warn when a box lands off the paper, or on top of another

**The failure.** The drag clamps at zero on the top and left (`Math.max(0, …)`) and has no upper
bound, and `.sheet` is `overflow: hidden`. A box dragged past the right or bottom edge is therefore
**clipped in silence**: it looks placed on screen and prints nothing.

**Build.** Compare each row's box against the document's page size and against its siblings, and show
it as a warning row in the Fields tab — *"Outside the page — this will not print"* and *"Overlaps
Employee name"*. A warning, not a block: overlapping boxes are legitimate when one of them is hidden
or empty for most people.

### A5. Arrow keys nudge the selected box

Being straight about this one: the fine-tune panel already takes exact X, Y, width, height and text
size in points, so this is speed rather than capability. But nudging a point at a time while watching
the paper is much faster than typing a number and re-reading, and on Form 1 a point matters.

Arrow = 1pt, Shift+Arrow = 10pt, on the selected box only, and only in layout mode.

---

## Track B — the Template Studio

### What it is

Upload a document, give it a name and say who it is for, and it becomes a template in the system —
placed, filled and printed with the editor that already exists. No code, no deploy, no session
with me.

### B0. Two decisions taken up front, and why

**A PDF is rasterised in the BROWSER, not on the server.** pdf.js draws each page to a canvas and the
canvas is uploaded as a PNG at print resolution. The alternative — rasterising on Railway — means a
native dependency in the server bundle, and this repo has already been burned once by a top-level
`import sharp` 500ing a whole page when its `.so` was missing. The browser has canvas already.

**Name and role is built as a superset, deliberately.** "Give it a name and a role" reads two ways:
who may PRINT it, or which employees it is FOR. The row carries both — `printable_by_roles` and an
optional `applies_to` filter — because supporting both costs one column and picking wrong costs a
migration. If only one is ever used, the other stays null and does nothing.

### B1. Schema and storage

- `hiring_pack_custom_templates` — id, key, name, name_ar, page width and height in points, status
  (`current` or `archived`), version, superseded_on and superseded_by, `printable_by_roles text[]`,
  `applies_to jsonb`, and audit columns. The version columns mirror `template-registry.ts` exactly, so
  a custom template archives the same way a built-in one does and for the same reason: these are
  papers people sign, and a superseded version has to stay printable.
- `hiring_pack_custom_template_pages` — one row per printed side: template id, page index, storage
  object path, intrinsic pixel size.
- Storage bucket `hiring-pack-templates`, **private**, accepting `image/png`, `image/jpeg`,
  `image/webp`, `image/svg+xml`, 15MB — the same shape as the existing `hiring-documents` bucket.

**Migration, therefore production-protected.** Additive only: two new tables, one new bucket, nothing
existing touched. It still needs the owner's separate approval before it is applied, and production
has no PITR, so it gets announced in plain words first.

### B2. The upload flow

One screen, in the HR Forms module, Super Admin only to begin with:

1. Drop a PDF or an image.
2. A PDF is rendered page by page in the browser; each page becomes a PNG, and the page size in
   points is read from the PDF's own page box — exact, not guessed. An image gets a size picker
   (A4, US Letter, US Legal, custom) with the aspect-matched option preselected.
3. Name it, name it in Arabic, and say who may print it.
4. Save. It appears in the HR Forms list beside the built-in documents.

### B3. The document type stops being a closed union

`HiringPackDocument` widens from a fixed union to *a built-in key, or `custom:<uuid>`*.

**THIS IS THE DANGEROUS PHASE, and the danger is specific.** There are six exhaustive
`Record<HiringPackDocument, …>` — labels, default copies, signed dates, the copies state, the
sign-date state, and `DOCUMENT_SURFACES`. `ignoreBuildErrors` is on, so a `Record` that has silently
lost a key still **compiles, builds and deploys**; the failure appears as an undefined label or a
missing surface at runtime, on a document nobody has printed yet.

So each of the six becomes a lookup with an explicit fallback for the custom case, and a registered
test asserts at RUNTIME that every document — built-in and custom — resolves a label, a copy count
and a surface. The type is not the guard here; the test is.

### B4. Printing a custom template

- A custom document's surface is always `page` — it is artwork with values on it, which is exactly
  what the page surface means.
- The artwork reaches the `<img src>` through an authenticated route,
  `/api/hiring-pack/template-artwork/[pageId]`, which checks the same permission as the print route
  and streams the private object. **Not a data URI**: a 300dpi page inlines to several megabytes, and
  a larger than 2MB `unstable_cache` entry kills the dev server outright.
- Page size comes from the template row, into the existing `placedFormCss(widthPt, heightPt, …)`.

### B5. Fields on a custom template

Nothing new is needed for placing them — the paper editor and the field table are already generic.
What a custom template needs is an **inventory**: which record values it may offer. It gets the full
`PAPER_FIELD_BINDINGS` set, because unlike a government form there is no compiled placement list to
read the keys from. Every field starts unplaced, and **Add a box** is how each one gets onto the page
— the mechanism the owner asked for on 2026-09-03 and that already exists.

### B6. Listing, permissions and archiving

- Custom templates appear in the HR Forms list beside the built-in ones, marked as company templates.
- Printing checks `employee_documents` as everything else does, then the row's own
  `printable_by_roles` on top.
- Editing the artwork of a live template creates a **new version** and archives the old one — the same
  rule as `template-registry.ts`, and the same reason. A signed paper has to stay reprintable exactly
  as it was signed.

---

## Order of work

Track A end to end first — A1, A2, A3, A4, A5 — because it is small, it needs one additive migration,
and it improves the editor that Track B then hands a brand-new document to.

Then Track B, B1 through B6 in order. B3 is the phase to slow down on; the rest is wiring.

Two things in here are protected actions and stop for the owner's word regardless of how the rest
goes: **applying either migration to production**, and **merging to `main`**.
