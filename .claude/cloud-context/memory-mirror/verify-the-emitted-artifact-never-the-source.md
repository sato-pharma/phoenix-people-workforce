---
name: verify-the-emitted-artifact-never-the-source
description: "Generated HTML, injected scripts and server-rendered PDFs must be checked as the artifact the browser receives — verifying the source text passed three separate shipped defects in one night. The DATABASE is an emitted artifact too: a source-only test cannot see a NOT NULL column, and a writer that logs instead of throwing then fails silently in production."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3a225fa2-02ae-4edc-b5f9-0feb98b6a83e
  modified: 2026-09-06T19:52:43.596Z
---

**When code GENERATES something — an HTML string, an injected `<script>`, a PDF built by
Chromium — the only thing worth asserting on is what comes OUT. Verifying the source text is
verifying a different artifact, and it passes while the real one is broken.**

Three defects shipped to production on 2026-09-05 from exactly this, all on one button, all with
green `typecheck`, green `validate` and four green required checks:

1. **A backslash died in a template literal.** The Download PDF guard was written `/\/print\/?$/`
   and reached the browser as `//print/?$/` — a line comment. The script died on a `SyntaxError`,
   so the button existed on every document and was hidden on every one. It had been "verified in a
   browser" by extracting the script text **out of the source file** and running that, which is the
   one copy that was correct.
2. **A font stack fixed in one of two places.** The container had no Arabic font at all
   (`ttf-freefont` carries the codepoints but does not SHAPE them), so filed and downloaded PDFs
   drew every letter isolated and a 3-page contract came out as 16. The body was fixed; the footer
   template carried its own hardcoded copy of the stack and was missed.
3. **A quoted font name closed a quoted attribute.** Interpolating `ARABIC_FONT_STACK` — whose
   families are `"Tahoma", "Segoe UI"` — into a **double-quoted** `style="…"` closed the attribute
   at the first family. The div was malformed and Chrome dropped the footer entirely, so the page
   numbers vanished after being correct the build before. Use a single-quoted attribute.

**Why:** none of these are type errors, none are string mismatches, and the HTML compared equal in
every test. Only the rendered page is wrong, and nothing in this stack looks at the rendered page.
Every one was found by the owner opening the file — never by CI.

**How to apply:**

- **Export the generated constant** and assert on it, so a test reads the emitted string rather than
  a retyped copy. `PAGE_NUMBER_FOOTER` and `printBanner`'s script are exported for this reason.
- **Compile the emitted script with `new Function`** — it catches a lost escape without running
  anything. `tests/print-banner-script.test.ts` does this and was proven RED against the real defect.
- **Render it and read it back.** For a PDF: produce it, extract the text, and crop the region to an
  image and LOOK. Page count is the cheapest tell — a 3-page contract arriving as 16 is a font
  problem, not a layout one.
- **When a value is interpolated into markup, check the delimiters.** A font stack, a name with an
  apostrophe, an Arabic title — any of them can close the attribute they are placed in.

Related: [[the-house-document-identity-standard]] — the standard these documents render, and the
`render-shared.ts` note on why Arabic must be laid out by a browser rather than a PDF library.

## The DATABASE is an emitted artifact too — a NOT NULL you never ran against (2026-09-06)

Same class, new surface. PR #3383 made `saveBrickCoverageSnapshot` write `null` into
`sos_import_coverage_snapshots.importable_value` and `new_customers` — correct in itself, because
that writer measures rows and units and never money or new customers. **Both columns were
`NOT NULL DEFAULT 0`**, so every one of those inserts fails `23502`.

**It shipped GREEN and was merged.** The test asserted on the source TEXT and on a pure mapper
function, and both of those are true of code that cannot run. **A suite with no database cannot see
a column constraint** — so "the source says the right thing" certified a feature that was already
broken in production the moment it deployed.

🔴 **It failed SILENTLY, which is what made it dangerous.** That writer does
`const { error } = await supabase…insert(…)` and calls `logError` instead of throwing — a deliberate
"coverage is analytics, never block an import" choice. So the import still succeeds, the snapshot is
simply never written, and the Coverage tab goes STALE rather than erroring. Nothing on any screen
says so. It was caught only because a backfill run minutes later hit the same constraint.

**How to apply.** When a change alters what is WRITTEN to a column — a new null, a new type, a wider
value — read that column's `is_nullable`, `column_default` and check constraints BEFORE shipping;
`information_schema.columns` answers it in one query, and no amount of source-reading will.
**Treat a writer that swallows its own error as raising the bar, not lowering it:** nothing
downstream will ever tell you it stopped working.

And when you make such a column nullable, **drop its DEFAULT in the same migration**. Left in place
it silently turns an omitted column back into a plausible `0` for the next writer that simply does
not mention it — the same lie by another route, and invisible.

Related: [[sos-import-coverage-metric-was-fake]] is this same table, where the coverage metric was
previously wrong in a different way (100% by construction, and not running at all).
