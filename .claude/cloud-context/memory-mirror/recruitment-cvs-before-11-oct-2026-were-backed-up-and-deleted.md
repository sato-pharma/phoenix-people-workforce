---
name: recruitment-cvs-before-11-oct-2026-were-backed-up-and-deleted
description: "2026-10-18 owner clean-up: every recruitment CV was zipped to F:\\Phoenix Workforce\\Recruitment CV Backup 2026-10-18 (Cabinet layout + CV Folders + restore JSON), then the 1,338 candidates received before 11 Oct 2026 Cairo were deleted — the 56 hired/offered/interviewed-since/newer-CV/with-a-manager KEPT; Drive copies MOVED to 'CV Backup before 11 Oct 2026', WhatsApp inbox left alone."
metadata:
  node_type: memory
  type: project
  originSessionId: a3d4c51a-88b6-429e-a48d-9ce3040cba29
  modified: 2026-10-18T22:16:04.368Z
---

On 2026-10-18 (~23:00 Cairo) the owner asked to back up every CV on the system in a zip "foldered as in
the system", then delete every CV received before Sunday 11 October 2026 (Cairo, = 2026-10-10 21:00 UTC)
"to clean the recruitment module".

His answers (in-chat MCQ):
- **Who goes:** skip the 56 still in play — hired (23), an offer letter (24), a newer CV after 11 Oct (13),
  an interview since 11 Oct (8), with a manager (9) — and delete the other **1,338** candidates. Set md5
  (sorted ids) `11623f22d5d759bf42a1ed1afe4a4353`.
- **Drive copies** (Phoenix CV Cabinet): MOVED, not trashed, into "CV Backup before 11 Oct 2026" at the
  Drive root, same sub-folders.
- **WhatsApp inbox:** leave it alone (the 363 unsaved CV documents in chats were not backed up or deleted).
  Side effect he accepted with the delete: chat messages whose CV had been saved to a deleted candidate
  now answer "no longer available" when opened (the file lived in recruitment-files).

The backup: `F:\Phoenix Workforce\Recruitment CV Backup 2026-10-18\Recruitment CVs backup 2026-10-18.zip`
holds ALL 2,029 objects of the `recruitment-files` bucket (kept and deleted), under `Phoenix CV Cabinet/…`
(each file's `drive_mirror_path`), `CV Folders/…` (copies for the hand-built folders), `Files not linked to
any candidate/`, an index workbook (also beside the zip), and `_Restore data/*.json` — full pre-image rows
of every deleted table plus the SET-NULL link pairs, for a restore. Scripts and run logs: the session
scratchpad `cvclean/` (backup, verify, delete-db, delete-storage, drive-archive, final-check).

Measured after (23:20 Cairo): candidates 1,505 → 167 (56 from before the cut-off), ats_files 1,940 → 214,
storage objects 2,029 → 217 (1,812 deleted: 1,726 CVs + 86 orphans; 3 post-cut orphans remain), 0 rows
missing their file, 0 dangling filings, WhatsApp media unchanged at 603; Drive 1,640 moved, 1 already
gone from Drive (404), 0 failed; zero recruitment errors in app_error_events afterwards.

**The Archive (his later answers the same night, ~23:30 Cairo):** "the WhatsApp CVs only available in the
WhatsApp candidates" — the old WhatsApp CVs "perfectly sitting in a folder in their place" that "answered
most of the questions" are kept in "a folder in each folder called archive", and asked where: "In Phoenix as
well". The filter: source whatsapp, filed in a cabinet folder (line / role [/ area]), at least 4 of the 5
main answers → **390 people, 447 CVs, 43 folders** (of the 1,089 deleted WhatsApp candidates).
- Drive: their 417 copies MOVED from "CV Backup before 11 Oct 2026" into "Phoenix CV Cabinet/<line>/<role>[/<area>]/Archive" — 417 moved, 0 failed.
- Phoenix: NOT candidates. Tables `ats_whatsapp_cv_archive` (+ `_files`), private bucket `recruitment-cv-archive`
  (migration `20261018204000`, applied staging + production by apply-sql-file.mjs), shown only by the Archive on
  WhatsApp Applicants (PR 6093, merged 2026-10-19 00:41 Cairo as 6c61f0963). Loaded 2026-10-19 ~00:00 Cairo: 390 rows,
  447 files, 447 bucket objects, 0 missing, 0 size mismatch, 0 also a candidate. The 56 kept candidates stay candidates.
- The WhatsApp inbox itself is still untouched; 705 pre-cut bot conversations now point at a removed candidate
  and are no longer counted as "could not be matched" on WhatsApp Applicants.

**The WhatsApp inbox documents (owner, 2026-10-19 ~01:00 Cairo: "back up and clear the 363 unsaved WhatsApp CV
documents"):** the set = inbound documents with a cached file, sent before 11 Oct 00:00 Cairo, never saved to a
candidate — exactly 363 files, 172 MB, 320 chats, ids md5 `ffcbc61d8d7df63271da18440692e8f1`. Backed up to
`F:\Phoenix Workforce\Recruitment CV Backup 2026-10-18\WhatsApp inbox CV documents backup 2026-10-19.zip`
(363 files verified by CRC, size and MD5; `_Index.json`; `_Restore data/whatsapp_inbox_messages.json` = full
pre-image rows). Then the 363 files were deleted from bucket `whatsapp-inbox-media` (603 → 240) and each message
marked cleared: `media_storage_path` and `media_fetched_at` null, `media_fetch_attempts` = 5 (the cache worker
stops), `media_fetch_error` = a "Cleared 2026-10-19" note. The 363 chat messages stay; the inbox shows the file
name and "This attachment could not be copied from WhatsApp." with no Open button. Images, videos and every
document since 11 Oct were left alone. Scripts: session scratchpad `wa/` (wa-backup, wa-clear). Copied to the company Drive 2026-10-19 ~01:15 Cairo
(folder "CV Backup before 11 Oct 2026", MD5 identical to the local file, `railway run` as the app's Drive
identity). The MAIN zip (804 MB, 2,029 objects + restore JSON) was NOT in Drive then — still laptop-only.

**Why:** production has no PITR; that zip and its restore JSON are the way back.
**How to apply:** a question about a missing pre-11-Oct candidate or CV is answered from the zip's index,
never by assuming a fault. The employee-cvs bucket (employees' own CVs, copies) was not touched.
[[cv-file-is-in-ats-files-not-cv-external-url]] [[ats-candidate-children-one-has-no-fk-and-one-is-a-view]]
