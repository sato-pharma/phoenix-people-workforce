---
name: whatsapp-import-images-return-nothing-from-vision
description: "SOLVED 2026-08-21: the 23 'WhatsApp Import' JPEGs are NOT CVs — they are photographed certificates and experience letters, all carry is_cv=false, and the empty extraction was CORRECT. Deleted; do not re-open or spend on them. The reusable lessons: the re-read script's counter prints an all-empty read as 'READ 5 fields (5 high) / Failed: 0' (fixed #2265 to an EMPTY outcome, but an empty read still WRITES a row and drops out of the 'never read' set); diagnose by downloading the bytes and opening the image (costs nothing, a 6-8s vision reply is the 'nothing here' tell); and a stored CV's declared type can lie — scan the corpus (1 bad file in 641) before rewriting the importer."
metadata:
  node_type: memory
  type: project
  originSessionId: fde6f04c-f7cd-489c-9ac7-dee610682b79
  modified: 2026-09-25T23:33:01.664Z
---

**SOLVED 2026-08-21 — the model was right and the files are NOT CVs. Closed; do not re-open, do not
spend another cent.** The 23 `source='whatsapp'` candidates named `WhatsApp Import (<hex>)` are
photographed **certificates, membership cards and experience letters** (ICDL, HR diplomas, course
certificates, a Saudi `شهادة خبرة` …), not resumes — confirmed by downloading each JPEG and looking,
and independently by all 23 carrying **`is_cv = false`** (`ai_model='gpt-5.4'`). Extraction returning
every field null is the CORRECT answer. Only 13 distinct images sat behind the 23 rows (10 imported
twice — same batch as the duplicate-import defect); the rows were deleted with a guarded `WHERE`,
0 left behind. Tesseract also read nothing on 2026-08-20, so **two independent engines agreeing on
"nothing" points at the pictures, not the code.**

## The reporting trap — the dangerous half

The re-read script's counter treats an empty array as a field-with-value, so a completely empty read
prints as success:

```
23/23  WhatsApp Import (…)  ->  READ   5 fields (5 high)  6.8s
Read : 23      Failed : 0
```

**"5 fields (5 high)" means NOTHING was extracted.** Never accept `Read: N, Failed: 0` from
`scripts/recruitment-reread-never-read-cvs.ts` as proof — read the `Names found`, `Phones found`,
`Applied-for` counters, or query `extracted_fields` for a value that is not null, `''` or `[]`.
(Sting: two of those three "honest" counters were reading `full_name`/`applied_for_job_title` off a
camelCase record, so they could only ever print 0 — right by luck, not by working; camelCase now.)

**Fixed #2265 (2026-08-21):** the counter uses one shared `isEmptyExtractedField`
(`src/lib/recruitment/cv-extraction-fields.ts`), `describeCvRead` gives an empty read a **third
outcome** — it prints `EMPTY` per candidate and an `Empty : N` line above `Failed : 0`, pinned by
`tests/recruitment-cv-read-honesty.test.ts`.

🔴 **Still open by design:** an EMPTY read still WRITES an extraction row, so a CV the model looked at
and got nothing from **drops out of this script's "never read" set on the next run and is never
retried** (the `RULES_ONLY_MODELS` hold-back closes the same trap one layer up). The `Empty : N` line
is how you find them; their rows must be deleted before a re-run reaches them.

## Diagnose this class cheaply — read the bytes

Download the file through `getFileForDownload` and open the image with the Read tool. It costs nothing
and settles in two minutes what rounds of API spend cannot. **A fast vision reply (6–8s vs 14–17s for
a genuine read) is the tell** that the model is answering "there is nothing here" rather than working.
Filter on **`is_cv is false`** precisely — never `not is_cv`, because rows written before that column
existed are NULL and inventing a verdict for them is worse than recording none. The auto-mode
classifier blocks the download scripts, so opening one candidate in the Candidate pool needs a human.

## A "never read" target may have nothing worth reading — and intake mislabels non-CVs

The email/WhatsApp intake files whatever arrived as `kind='cv'`, so a "never read" candidate can be:
an **outbound offer/confirmation thread** the intake ingested (signed job offers, an Outlook signature
image — real people already *past* application; nothing on the page to extract), or a **non-applicant
entirely** (an internal HR insurance circular `automated@satopharma.com`, a vendor price quote
`sales@daftra.com` — their "CVs" were a benefits-table PNG and a quotation PDF). Deleting such a
candidate cascades its `ats_files` rows and nulls the `ats_cv_intake_events` pointers (the arrival
record survives). So before spending a key on the "never read" set, confirm each actually holds a CV.
Detail: [[ats-candidates-full-name-holds-the-whole-intake-envelope]] ·
[[an-empty-cv-extraction-is-the-designed-answer-to-a-non-cv]].

## 2026-08-27 — a stored CV's DECLARED TYPE can lie, so read the bytes at corpus scale

Scanning the first 12 bytes of **every stored CV (all 641)** with a `Range: bytes=0-11` request against
`recruitment-files` takes ~1 minute and costs nothing. 639 were exactly what they claimed; two were
not, and **the lesson is the ratio, 1 in 641** — a systemic decode fault would show dozens of bad
headers, so scan the corpus before rewriting the email importer on the strength of one bad file.

**The one real bad file (`upd c.v.(4-24).pdf`, wallid tawfik) — a base64-text-as-PDF, truncated.**
Its bytes begin `JVBERi0x` (ASCII for `%PDF-1.7`): the attachment was **double base64-encoded** (the
MIME part declares `base64`; decoding once yields more base64 text) — the sender's fault, not intake's,
which decoded exactly once correctly. It was also **truncated before delivery** (Yahoo's marker is
inside the inner payload; the inner base64 is `≡ 1 mod 4`, impossible for a complete stream), so it
fails `pdf-parse` with `Invalid PDF structure`, naming neither real fault. Only page 1 was salvageable
(pages 2–8 gone); page 1's contact block was recovered. 🔴 **OWNER DECISION 2026-08-27: do NOT chase
him for a resend — he said "neglect." Settled, contact block only, do not re-raise.**

Reusable traps from that repair:

- **The `[remainder of message body omitted; too large]` marker is ambiguous.** Fetching the message
  *part* (`BODY[2]`) makes Yahoo truncate at ~25KB and append that string itself; a full `RFC822`
  fetch returns all bytes clean. Don't conclude from the marker alone which truncation you are seeing.
- **Read the mailbox READ-ONLY:** `getMailboxLock(path, { readOnly: true })` sets no `\Seen` and moves
  no cursor, so the poller is unaffected. Search by **Message-ID**, not the stored UID.
- **`recruitment-files` rejects `application/octet-stream`** — a backup must be uploaded under a `.pdf`
  path with `Content-Type: application/pdf`.
- **An immediate read-back after a storage overwrite can serve a STALE cached copy** — it reported
  "matches: false" while `storage.objects` already showed the new size. Confirm against
  `storage.objects` metadata or re-read with a cache-buster before believing a write failed.
- **A 0-byte object answers a Range request with HTTP 416, not an error** — in a header scan, `416`
  means "smaller than the range," i.e. empty, worth checking rather than skipping. (`CV Sherif
  2026.docx` was 0 bytes but harmless — a second attachment; the real PDF was already read.)

Related: [[openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules]] ·
[[a-cv-import-overwrote-a-candidates-whole-identity]] · [[ad-hoc-backup-tables-are-anon-readable]] ·
[[never-silent-drop-count-and-flag-instead]]
