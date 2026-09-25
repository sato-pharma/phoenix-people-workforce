---
name: whatsapp-import-images-return-nothing-from-vision
description: "SOLVED 2026-08-21: the 23 'WhatsApp Import' JPEGs are NOT CVs — they are photographed certificates and experience letters. The model was right to return nothing. Do not spend more on them."
metadata: 
  node_type: memory
  type: project
  originSessionId: fde6f04c-f7cd-489c-9ac7-dee610682b79
  modified: 2026-08-27T14:29:26.234Z
---

**SOLVED 2026-08-21, ~12:00 Cairo — THE MODEL WAS RIGHT AND THE FILES ARE NOT CVs. Close this;
do not spend another cent on these 23.** Re-ran with a confirmed-valid key (fingerprint
`469EBD3D56`, `/v1/models` = 200) and got the same 23 EMPTY reads, so the dead key was never the
cause. Then downloaded every file and **looked at it**: all are valid JPEGs (`ffd8ff`, 27KB–558KB),
and every single one is a **photographed certificate, membership card, or experience letter** —
ICDL, Cambridge Training College HR diploma, British Foundation HR certificate + membership card,
Trust Academy HR diploma, HRDTNC English and German course certificates, Al-Gomhuria press training,
Cairo Chamber of Commerce, Suez Canal Container Terminal attendance, an E.T.G. promotion letter, and
a Thani Buti (Saudi) `شهادة خبرة`. **Not one is a CV.** Extraction returning every field null is the
CORRECT answer, not a failure.

**Only 13 distinct images sit behind the 23 rows — 10 were imported TWICE** (proved by md5, e.g.
`d50ec9a0…` = both `NUIxRQA` and `QjJDOQA`). Byte sizes match exactly across each pair. So the
duplicate-import defect and this one are the same batch.

**The control that proves the pipeline is healthy:** a 14th WhatsApp JPEG in the same import,
`RTYyOAA` (Nada Hussien Ramadan Hussien), IS a real CV — and it was read successfully and never
appeared in the failed set. Same route, same model, same day.

Named people recoverable BY EYE from the certificates, if the owner ever wants them as candidates:
**Mohamed Attia Mohammed Attia** (most of them), **Emad Abdo Sabet / عماد عبده ثابت تاوضروس**, and
**Eslam Moustafa Elazaby**. No phone numbers appear on any certificate.

**How to diagnose this class of thing next time, cheaply:** download the bytes through
`getFileForDownload` and open the image with the Read tool. It cost nothing and settled in two
minutes what three rounds of API spend could not. A fast vision reply (6–8s vs 14–17s for a genuine
read) is the tell that the model is answering "there is nothing here" rather than working.

**23 vision calls, zero data, reported as total success.** Run 2026-08-21 09:01–09:05 Cairo against
production, on the 23 `source = 'whatsapp'` candidates named `WhatsApp Import (<4 hex chars>)` whose
"Applying for" cell is empty. Every one came back `ai_model = 'gpt-5.4'` — so the model WAS reached
and did answer — with **every scalar field null** and five empty arrays (`skills`, `languages`,
`workHistory`, `educationHistory`, `certifications`). The 23 rows were deleted again the same hour
with a guarded `WHERE` (ai_model + a 11-minute `created_at` window + `created_by is not null` + a
`not exists` proving no field held a value); 23 deleted, 23 candidates freed, 0 left behind.

**THE REPORTING TRAP, and it is the dangerous half.** The script's counter treats an empty array as
a field with a value, so a completely empty read prints as:

```
23/23  WhatsApp Import (MkE2MwA=)  ->  READ   5 fields (5 high)  6.8s
Read   : 23      Failed : 0
```

"5 fields (5 high)" **means nothing was extracted at all.** The only honest lines in that summary are
`Names found 0/23`, `Phones found 0/23`, `Applied-for 0/23`. Never accept `Read: N, Failed: 0` from
`scripts/recruitment-reread-never-read-cvs.ts` as proof — read the three "found" counters, or query
`extracted_fields` for a value that is not null, `''` or `[]`.

**FIXED AND LIVE IN PRODUCTION — PR #2265, merged 2026-08-21 10:39 Cairo, squash `6c4718c2`, and
`/api/healthz` returned `revision: 6c4718c2c666146eccdf4ec852b3303f0a7841aa` three minutes later.**
The counter now uses one shared `isEmptyExtractedField` (moved to
`src/lib/recruitment/cv-extraction-fields.ts`; `cv-extraction-merge.ts` and the `hasValue` in
`cv-extraction-quality.ts` both delegate to it), and `describeCvRead` gives this a **third outcome**:
such a run now prints `EMPTY` per candidate and an `Empty : 23` line above `Failed : 0`.
`tests/recruitment-cv-read-honesty.test.ts` pins it. **Also note the sting in the advice above:** two
of the three "honest" counters were reading `full_name` / `applied_for_job_title` off a camelCase
record, so they could only *ever* print 0 — they were right here by luck, not by working. Those are
camelCase now too.

**Still open after the fix:** an EMPTY read still WRITES an extraction row, so a CV the model looked
at and got nothing from drops out of this script's "never read" truth set on the next run and is
never retried — the same trap the `RULES_ONLY_MODELS` hold-back closes one layer up. The new
`Empty : N` summary line is how you find them; their rows have to be deleted before a re-run reaches
them. Documented in the script header, deliberately NOT changed, because it alters what a
production-touching script targets.

**The historical backlog of those rows is now CLEARED — production, 2026-08-21.** A sweep of
`ats_candidate_cv_extractions` with the same predicate the shipped TypeScript uses found **9 empty
rows out of 408**, all `ai_model = 'gpt-5.4'`, all `applied_fields is null` (never reviewed), 4 of
them from the earlier `ops:cv-reread-20260816` run and 5 older `medical_rep`-schema ones from 24–27
July. Deleted with a guarded `WHERE` (explicit 9-id list AND `applied_fields is null` AND the
emptiness predicate re-asserted); **9 deleted, 0 left behind, 399 remain and all 399 hold a real
value.** No foreign key references this table, so nothing cascaded. Six candidates went back to zero
extractions and therefore back into the script's target set; *maisaa* and *Acheampong Augustine*
each kept their 2 good extractions. Full restore SQL was captured to a file first — deliberately NOT
a `zz_backup_*` table, see [[ad-hoc-backup-tables-are-anon-readable]].

**Then two of those six were deleted outright, same day, because they were never applicants.**
*Automated* (`automated@satopharma.com`) and *Daftra Sales* (`sales@daftra.com`) were an internal HR
insurance circular and a vendor price quote that the email intake had turned into candidates — their
"CVs" were a benefits-table PNG and a quotation PDF. Deleting the 2 candidate rows cascaded away
their 4 `ats_files` rows and nulled the pointers on 4 `ats_cv_intake_events` rows (which survive, so
the arrival record is intact); the Drive objects were untouched. **553 candidates remain.** Full
detail and the FK map are in [[ats-candidates-full-name-holds-the-whole-intake-envelope]].

**THEN THE WHOLE PREMISE COLLAPSED — the remaining four "never read" targets have no CV to read.**
Checked one file at a time on 2026-08-21, each has exactly ONE attachment and none of them is a CV:
*Abdelrahman Nour* → `Abdelrahman Nour JO ٍSigned.pdf` (his **signed job offer**, 158 KB);
*dr.hany saad* → `Dr Hany Saad RM JO.pdf` (212 KB); *Khaled Abdelfatah* → `MRs JO.pdf` (203 KB);
*Marina Gamal* → `Outlook-Image.png` (**11 KB Outlook signature image**, from a "Re: Interview
Confirmation" reply). All four are real people who had already progressed *past* application — the
intake ingested the outbound offer/confirmation thread and filed it as `kind = 'cv'`. **So do NOT
spend an OpenAI key on re-reading them: there is nothing on those pages to extract, and a perfect
model returns the same nothing.** The "never read" target set is empty of anything worth reading.

**Do not re-run the re-read script expecting a better answer yet.** The OpenAI key is deleted for
cost ([[openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules]]), so extraction now
degrades to the free rules engine — and a photo CV needs the model or nothing. Re-running today just
re-writes empty/rules-only rows over the six candidates that were just freed.

**Ruled out — do not re-investigate these.** The files are real: 23 `image/jpeg`, 27 KB to 557 KB,
15 of them over 150 KB, so not thumbnails. `buildVisionInput` is correct — a `data:<mime>;base64,…`
`input_image` at `detail: "high"`. Calls took 5–50s, consistent with a real image being uploaded.
The narrowing lever (#2257) is text-route only and never touched this path.

**SETTLED 2026-08-21 — THE MODEL JUDGED THEM NOT CVs. It was not a refusal to read an identity
document.** This was recorded as unrecoverable and it is not: the 23 rows were written by
`ops:cv-reread-20260816` at **08:50–08:53 UTC on 2026-08-21**, which is *after* the `is_cv` column
was applied to prod, so the verdict was captured. All 23 carry **`is_cv = false`** (`ai_model =
'gpt-5.4'`). Combined with the certificates being visually confirmed, the two independent answers
agree completely. **Do not re-open this and do not re-read them to find out.**

Query that shows it, and the way to spot any future batch of the same kind:

```sql
select to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI'), ai_model, created_by, count(*)
from public.ats_candidate_cv_extractions where is_cv is false group by 1,2,3 order by 1;
```

The 394 rows written *before* that column existed are still NULL, and inventing a verdict for them
would be worse than admitting none was recorded — so `is_cv is false` is a **precise** filter, never
`not is_cv`. Tesseract also read nothing
from them on 2026-08-20, and **two independent engines agreeing on "nothing" points at the pictures,
not the code.** Looking at one is the cheapest way to settle it; the auto-mode classifier blocks the
download scripts, so this needs a human to open one candidate in the Candidate pool.

Related: [[openai-key-is-401-and-cv-extraction-silently-falls-back-to-rules]] ·
[[whatsapp-forwarder-omar-collapses-cvs-onto-one-candidate]] ·
[[applying-for-is-derived-and-the-residue-is-genuinely-silent]] ·
[[never-silent-drop-count-and-flag-instead]]

---

## 2026-08-27 — the same move again: a stored CV's DECLARED TYPE can lie, so read the bytes

Same investigative step as above (download it and look), run across the whole corpus this time.
Scanned the first 12 bytes of **every stored CV file — all 641** with a `Range: bytes=0-11` request
per object against `recruitment-files`. Takes about a minute and costs nothing.

**639 are exactly what they claim**: 562 `%PDF`, 40 `PK` docx, 31 JPEG, 4 legacy `.doc`, 2 PNG.
Two are not, and they are DIFFERENT faults:

**1. `upd c.v.(4-24).pdf` (wallid tawfik) is BASE64 TEXT stored as a PDF, and truncated.** It begins
`JVBERi0xLjcK`, which is the ASCII for `%PDF-1.7` — the email attachment's base64 payload was written
to storage verbatim, never decoded, then stamped `mime_type: application/pdf`. Its last line is
literally `[remainder of message body omitted; too large]`. **That string is NOT anywhere in this
codebase** (checked `src` and `scripts`) — it came from the mail server. 25,331 bytes
of base64 decode to 18,474 bytes of genuine `%PDF-1.7` with **no xref and no `%%EOF`**, so it fails
`pdf-parse` even after decoding correctly. The extraction error is `Invalid PDF structure` at 0.6s,
which names neither real fault and reads like an ordinary corrupt file.

**CORRECTED 2026-08-27 by actually re-fetching the message — intake was NEVER at fault, and
re-fetching recovers NOTHING.** The clause above blaming intake for "fetching a raw message BODY
rather than a decoded attachment" was a guess, and it was wrong. The `hr` mailbox copy is
**byte-identical to what we stored** (both 25,331 bytes, `sha256 12738e68ef8f6b8e`). Two separate
things were stacked:

- **The attachment is DOUBLE base64-encoded.** The MIME part declares
  `Content-Transfer-Encoding: base64`; decoding it once yields bytes that are *still* base64 text
  (`JVBERi0x`). Our importer decoded exactly once, correctly. The mime/bytes mismatch is the
  sender's.
- **The truncation predates delivery.** Yahoo's marker is *inside* the inner payload, so it was
  baked in before the file was ever attached — someone attached an already-truncated saved message
  body. The inner base64 is 24,633 chars, **≡ 1 mod 4**, impossible for a complete stream.

**A separate red herring that produces the IDENTICAL marker:** fetching the *part* (`BODY[2]`) makes
Yahoo truncate at ~25KB and append that string itself. The full `RFC822` fetch returns all 42,515
bytes clean. Do not conclude from the marker alone which truncation you are looking at.

**RESOLVED — page 1 was salvaged; pages 2–8 are gone for good.** The PDF is 8 pages
(`/Type /Pages /Count 8`); objects 1–9 survive, object 9 dies mid-JPEG, and page 1's Flate content
stream is **complete**. Rebuilt it into a valid 1-page PDF (base-14 font substitutes + a 1×1
placeholder image so nothing dangles), 3,551 bytes, parses, 360 chars. Applied to prod
2026-08-27 17:18 Cairo: original backed up hash-verified to
`cv/1b09d2c9-…/upd-c.v.-4-24-.original-truncated.pdf`, main object replaced, `ats_files.size_bytes`
25,331 → 3,551, re-read wrote a real `gpt-5.4-nano+rules` row (6 fields). Recovered: name, DOB
15/1/1971, phone `01001520132`, both addresses, `wallidtawfik@yahoo.com`. **`fullName` came back
LOW confidence** ("Abd El Fat tah" — pdf-parse splits on kerning) and `governorate` guessed
`Sharqia` from the second address while the first is New Cairo — both are human calls, and
`applied_fields` is still null. He is an NSM applicant and only his contact block survives.
**OWNER DECISION 2026-08-27: do NOT chase him for a resend — he said "neglect" when it was proposed.
This is settled; do not re-raise it as an outstanding action.** The record stays as it is, contact
block only. Yahoo message-id
`<516310348.1019816.1746389629401@mail.yahoo.com>`, mailbox `hr`, `provider_uid` 33, subject
**"National Sales Manager"**; msg-id timestamp is **May 2025** vs `created_at` **2026-07-24** — a
mailbox backfill.

**Read the mailbox READ-ONLY when you do this**: `getMailboxLock(path, { readOnly: true })` sets no
`\Seen` flag and moves no cursor, so the poller is unaffected. Search by **Message-ID**, not the
stored UID. The bucket `recruitment-files` rejects `application/octet-stream` — a backup must be
uploaded under a `.pdf` path with `Content-Type: application/pdf`. And **an immediate read-back
after a storage overwrite can serve a STALE cached copy**: the verify said "matches repaired:
false" while `storage.objects` already showed the new size. Confirm against `storage.objects`
metadata or re-read with a cache-buster before believing a write failed.

**2. `CV Sherif 2026.docx` is 0 bytes — and is HARMLESS.** Sherif Boutros sent TWO attachments in one
email (`attachmentIndex: 1` on the second); the good one is a 132,933-byte PDF that already has 2
successful extractions. A 0-byte object answers a Range request with **HTTP 416**, not an error —
so in a header scan `416` means "smaller than the range", i.e. empty, and is worth checking rather
than skipping. Do NOT chase the empty docx; the candidate is fully read.

**The lesson is the ratio, not the bug: 1 in 641.** Before rewriting the email importer on the
strength of one bad file, scan the corpus — a systemic decode fault would show dozens of `JVBERi0`
headers, and it showed one. See [[an-empty-cv-extraction-is-the-designed-answer-to-a-non-cv]] for
the other reason a CV can read as nothing, and [[a-cv-import-overwrote-a-candidates-whole-identity]]
for what else the email path has done wrong.
