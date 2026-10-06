---
name: the-rep-training-deck-is-a-pptx-and-its-generator-is-gone
description: "The Medical Rep training deck is cut from the LIVE .pptx (its pptxgenjs generator is gone and .pptx is not an archived type), its caps are letter-spaced so a text sweep must strip ALL whitespace, and a New Joiners edition now exists with an evergreen cover"
metadata:
  node_type: memory
  type: project
  originSessionId: ba8de66c-128d-4a93-882e-b7eec8e411d8
  modified: 2026-10-05T18:54:33.530Z
---

**"The Phoenix implementation training" means the 17-slide MEDICAL REP TRAINING deck — not the 3-page Go-Live announcement sheet.** Both exist and look alike (same navy/orange Sato Pharma · Phoenix Workspace identity), and a session asked for "the training" built the Go-Live sheet first and was corrected (2026-10-05). The deck is 960×540 pt, 17 slides; the Go-Live sheet is 3 × A4 and only announces the day.

**The deck's ORIGINAL generator is GONE.** It was `build-deck.js` (pptxgenjs) in a session scratchpad under `%TEMP%`, which Storage Sense emptied — and **`.pptx` is NOT one of the protected types `scratchpad-archive.mjs` copies to `F:\Claude Scratchpad Archive`** (html, pdf, xlsx, docx, svg only). So a deck left in a scratchpad is one sweep from gone. Everything now lives in **`F:\Phoenix Workforce\_deliverables\phoenix-rep-training-deck\`** with a README: the Wave 2 (Cairo & Giza) base, the New Joiners edition, and `edit-newjoiners.py`.

**Cut a new edition by EDITING THE LIVE .pptx with python-pptx, then LibreOffice headless → PDF.** The edit script asserts the exact existing text of every shape it touches, so a drifted base aborts instead of editing the wrong box. Three traps it exists to encode: a line that mixes plain and bold (slide 1 subtitle, slide 2 lead) must be edited **one run at a time** — replacing the whole frame blanks the bold runs; **speaker notes are ONE paragraph in ONE run with embedded newlines**, not one paragraph per line; and the running footer sits on **12** chrome slides, not 11 (1, 3, 9, 15, 17 are full-bleed).

🔴 **A stale-text sweep of the rendered PDF must strip ALL whitespace first** — the deck letter-spaces its caps, so the extracted text is `W A V E  2`, and every check reads clean against `WAVE 2` while the old wording is still on the page.

**The New Joiners edition (2026-10-05)** is for reps hired straight onto Phoenix, who never had an old-CRM account. 20 edits: the WAVE eyebrow and all 12 footers → `NEW JOINERS · MEDICAL REPS`; slide 2's title → "Why you start on Phoenix", its lead → "You start straight on Phoenix.", its left panel `THE OLD CRM` → `A TYPICAL CRM` in present tense; and the notes on slides 1, 2, 13. Slides 3–17 are untouched. **The cover is EVERGREEN by the owner's own choice that day** — "Day one / Before your first field day / Head office, Cairo", no fixed date, because new hires arrive all year; the only dated mark left is the decorative `2026` badge in the cover's bottom-right corner, kept deliberately as part of the identity. Do not put a wave date on it without his word.

🔴 **ADDING a slide needs a PACKAGE-level clone — python-pptx cannot copy one, and a deepcopy of the shapes LOSES THE NAVY BACKGROUND**, which sits on the slide itself, not the layout (all slides share one layout named `DEFAULT`, white and navy slides alike). `dup.py` copies `slideN.xml` + its rels, gives the copy **its own notesSlide** (repoint the back-rel, or the two slides share one set of speaker notes), adds both `[Content_Types]` overrides and a presentation rId, and inserts `<p:sldId>` at the position wanted. Clone a **full-bleed** slide (1, 3/4, 9, 15, 17) and nothing renumbers — the chrome slides' top-right numbers are SECTION numbers, not slide numbers. 🔴 **And watch the inherited run properties: the "Coach, not ~~catch~~" title strikes that word through on purpose, so a clone carries a strikethrough into whatever word lands in that run** — it shipped once and had to be cleared (`unstrike.py`, 2026-10-05). Swap icons by lifting the deck's own image parts by sha1; `get_or_add_image_part` dedupes, so nothing new enters the file.

**Slide 2 of the New Joiners edition is "A word between us."** — his own framing (2026-10-05): we try to build a family-like culture and a comfortable place to work, but we are a business, a business runs on alignment, and what is said out loud can be measured and carries commitment. The round he runs on it — each rep's name, town and experience, what each wants from Sato, then the question back to him — lives in that slide's **speaker notes, with the Arabic wording he asked for**; the printed slide stays English like the other 17.

Related: [[never-put-his-physical-actions-in-the-next-step-box]], [[the-house-document-identity-standard]].
