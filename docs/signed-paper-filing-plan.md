# Confirming a paper files it in the employee's hiring documents

> *"I want any paper an employee signs on to go to his hiring documents, to be saved there so I can
> access it and easily find it, and also print it. Once I confirm it, it goes two ways — to be
> printed, and to go to the employee's hiring documents."*

## What is true today

Confirming a signature records **a date and nothing else**. `POST /api/hiring-pack/[hrId]/sign`
writes `signed_date` onto the employee's hiring profile; the paper itself is never kept. Printing is
a separate act in a separate tab, and nothing connects the two.

The checklist already has the slots waiting for these papers, and **every one of them is empty**:

| Definition | display_order | Files today |
|---|---|---|
| Social insurance form | 80 | 0 |
| Signed employment contract | 85 | 0 |
| Signed social insurance Form 6 | 100 | 0 |
| Signed resignation request | 101 | 0 |
| Signed mutual termination agreement | 102 | 0 |
| Signed employee clearance | 103 | 0 |
| Signed company clearance | 104 | 0 |

They are empty because the only way to fill one is print → sign on paper → scan → upload by hand.
This closes that loop.

## What gets filed, said plainly

**The paper as Phoenix generated it, with that employee's values on it, at the moment it was
confirmed as signed.** It is not a photograph of the ink. Both are worth having and the checklist
holds many files per slot, so the scan can still be attached beside it.

So a filed paper is marked `source = 'issued'`, a third value beside the existing `'upload'` and
`'scan'`, and the screen says which a file is. Nobody should ever open "Signed employment contract"
and have to guess whether they are looking at a signature or a printout.

## The decisions taken up front, and why

**THE BROWSER RENDERS IT, because it is the only thing in this stack that lays Arabic out
correctly.** `hiring-pack-manager.tsx` already says so where it opens the print tab. A server-side
draw with `pdf-lib` would put the text at the right coordinates in the wrong shapes — Arabic needs
joining and bidi, `pdf-lib` does neither, and the failure is a document that looks almost right.

**NOTHING NEW IS INSTALLED.** `html-to-image` rasterises the rendered page (already a dependency,
already used by the organogram export), and `pdf-lib` assembles the pages into a PDF server-side —
which is exactly what `scanPagesToPdf` does for a photographed document today. The filed paper takes
the same route through the same code as a scan.

**A COMPANY TEMPLATE NEVER CREATES A CHECKLIST SLOT.** The hiring-documents dashboard is every
employee crossed with every active definition, so a definition invented per uploaded template would
appear as a missing document against all 186 employees at once. Instead a template carries an
optional "file it under" pointing at a slot that already exists. Unset means it prints and is not
filed — which is the honest default, and it is said on screen rather than left to be discovered.

**FILING CAN FAIL WITHOUT UNDOING THE SIGNATURE.** The date is the record of fact; the PDF is a
convenience built on top of it. A storage failure must never roll back a confirmed signature, so the
filing is reported on its own and can be retried.

---

## Phase 1 — a file can say it was issued, and a template can say where it goes

- Migration: widen `hiring_document_files_source_check` from `('upload','scan')` to add `'issued'`.
  Strict widening; no existing row changes meaning.
- Migration: `hiring_pack_custom_templates.files_under_document_id uuid null`, referencing
  `hiring_document_definitions(id)` with `on delete set null` — a retired slot must not take the
  template down with it.

## Phase 2 — which slot each paper belongs in

A pure registry mapping each built-in document to a definition **by name**, because the definition
ids differ between staging and production and a hard-coded id would file into the wrong slot on one
of them. Resolved to an id at call time; an unmatched or retired slot is an explicit refusal, never
a silent skip. Company templates read their own column. Registered tests pin the map.

## Phase 3 — the rendered paper becomes a PDF

- The manager loads the print view for one copy into an offscreen same-origin iframe at the exact
  page size, waits for the artwork images to decode, and rasterises each page element with
  `html-to-image`.
- The PNGs are POSTed to a new route, which assembles them with the existing `pdf-lib` path and
  writes the file through the hiring-documents store, so permissions, the private bucket and the
  size limits are the ones already in force.

## Phase 4 — one confirm, two outcomes

`recordSignature` keeps writing the date first. On success it files the paper and opens the print
tab. Three outcomes are reported distinctly: signed and filed; signed, filed, printing blocked by
the popup blocker; signed but not filed, with the reason and a retry.

## Phase 5 — finding it again

The file appears under that employee in Hiring Documents, named for the paper and the signed date,
marked as issued rather than scanned, downloadable and printable. Verified in the browser at desktop
and 375px against the fits-the-screen rule.

## Phase 6 — the guards

Registered tests for the slot map, the issued-source rule, the no-duplicate-on-reconfirm rule and
the missing-slot refusal. Each proved red before it is quoted as green.

---

## Where it stands — 2026-09-04

**All six phases are built, and the loop is closed.** Confirming a signature records the date,
files the paper, and opens the print tab, and each of the three outcomes is reported in words.

Verified on staging against **CN-0006**: three filed copies, each badged **Issued by Phoenix**, the
newest reading `835 KB · 2 pages`; the View link serves 854,583 bytes of `%PDF-1.4`. Measured at
1440px and 375px — `main` is 375/375 with no inner scroller, after the generated filename was made
to **wrap** rather than sit in its own 188px horizontal scroller.

Four suites are registered and each was proved red on its own headline assertion first:
`hiring-pack-paper-filing`, `hiring-pack-paper-artwork`, `hiring-document-file-source`, plus the
existing hiring-pack suites.

### What is deliberately not built yet

**A company template cannot be signed at all**, so it cannot be filed either. `POST /sign` accepts
only `SIGNABLE_DOCUMENTS` — the seven built-in papers — so `resolveCustomFilingSlot` and the
`files_under_document_id` column are in place and correct but unreachable. Making them reachable is
two separate pieces of work: a Studio control to choose the slot, and a decision about where a
company template's signed date is stored, since it has no `*_signed_at` column of its own and one
per template is not the answer. Production holds **zero** company templates today, so nothing is
waiting on it.

---

**Two protected actions sit in here and stop for the owner's word:** applying the three migrations
to production, and merging to `main`. Neither has been done. Merging first is safe — the code
recognises the unmigrated window and says so, signatures still record and papers still print.
