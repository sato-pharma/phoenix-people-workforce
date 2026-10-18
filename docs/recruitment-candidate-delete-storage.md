# Deleting a candidate also removes their files from storage

The account behind the rule in `.claude/rules/recruitment.md`, "Deleting a candidate". Code:
`deleteCandidate` in `src/lib/recruitment/candidates.ts` and
`src/lib/recruitment/candidate-storage-cleanup.ts`. Pinned by
`tests/recruitment-candidate-delete-storage.test.ts`.

## What was wrong

`deleteCandidate` removed the candidate row and its folder filings. `ats_files` rows cascade away with
the candidate, but each row only POINTS at an object in the private `recruitment-files` bucket: the
column is named `drive_file_id` and holds the Supabase Storage path (`cv/<uuid>/<name>`, see
`20260903213000_cv_google_drive_mirror.sql`). Nothing removed the object, and once the row was gone
nothing could ever name it again.

Measured on production, 18 October 2026: 89 objects in the bucket had no `ats_files` row, among them job
offers and the CVs of people whose records had been deleted. `ats_candidate_comments` and
`ats_candidate_manager_folders` carry no foreign key either (by design, so a filing never blocks a
delete), so they orphaned beside `ats_cv_folder_items`.

## What happens now

In `deleteCandidate`, in this order:

1. **Read the candidate's `ats_files.drive_file_id` paths.** Before anything is deleted, because the
   cascade destroys the only record of them. A failed read is logged and yields no paths; it never stops
   the delete.
2. Delete the candidate's `ats_cv_folder_items`, `ats_candidate_manager_folders` and
   `ats_candidate_comments` rows. The comments go last of the three: a filing or a shelf comes back with
   one press, a comment is the one thing a person wrote that a re-send cannot remake.
3. Delete the `ats_candidates` row (the files cascade). This still throws on failure.
4. **Only then**, remove the objects through the Storage API
   (`supabase.storage.from('recruitment-files').remove(paths)`). `delete from storage.objects` is refused
   by `storage.protect_delete()` (42501) and would take its transaction with it.

Step 4 never throws and never undoes step 3. It logs one `logError` per failure, with the candidate id and
a count and never a path (a path names the person: `cv/<uuid>/Ahmed-Hassan.pdf`):
`candidate_delete_storage_list_failed`, `candidate_delete_storage_check_failed`,
`candidate_delete_storage_remove_failed`.

Before removing, it asks `ats_files` whether any SURVIVING row still names each path, and keeps those. If
that check cannot be completed, nothing is removed: a leaked object is recoverable and a deleted one is
not. Nothing writes two rows onto one path today (every upload mints a fresh `cv/<uuid>/…`; production
had 214 files, 0 shared paths, 0 on an application, 0 with a null candidate), so this guards two ordinary
events instead: a merge re-pointing a file to its survivor between the read and the delete, and any
future copy-by-reference.

Both lists are chunked at 50. PostgREST answers an over-long `.in()` with zero rows and no error, which
would read as "nothing references these".

## What deliberately does not happen

- **`ats_candidate_status_events` is untouched.** It is the append-only audit trail, kept on purpose.
- **Nothing sweeps "objects with no `ats_files` row".** On 18 October the three that were left were
  interview-calendar CVs that an `ats_interview_bookings` or `ats_interview_request_items` row still
  points at through `external_cv_file_id`. They are real and in use. Only a deleted candidate's own
  paths are ever removed.
- **A merge does not need this.** `mergeCandidates` re-points `ats_files` to the survivor (it is in
  `childTables`) and never deletes one, so no object loses its row. The test pins both halves: the file
  stays in `childTables`, and the merge service never deletes from `ats_files`. If a merge ever starts
  dropping a file it must call `removeCandidateStorageObjects` for it.
- **Existing orphans are not backfilled by this change.** Re-measured later on 18 October: 0 orphaned
  comments, manager shelves or folder filings, and 3 bucket objects without a row, all three live
  interview CVs as above.

## Related gaps left alone

- An interview-calendar CV (`external_cv_file_id`) is a separate upload kept on the booking or request
  item. Cancelling the interview, replacing the CV or withdrawing the request leaves the old object in
  the bucket (the comment at `interview-calendar.ts`, "the storage adapter has no delete"). Different
  owner, different table, not part of a candidate delete.
- `applications.ts` deletes an application row, which cascades any `ats_files` row hanging off it
  (`application_id`). Production holds none.
