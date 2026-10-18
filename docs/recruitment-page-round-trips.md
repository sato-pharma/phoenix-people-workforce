# The Recruitment page's database round trips

Sentry's page survey of 16 October 2026 put the Recruitment page at 11.9 s. The queries are not slow:
the page spends its time in **requests**, about 79 of them a load by static count, several of them in
sequence, and each one waits through the process's occasional event-loop freezes. Module memory carries
the one-line rule (`.claude/rules/recruitment.md`); this is the account.

## What changed

| Read | Before | After |
| --- | --- | --- |
| The dashboard's candidate tiles | six `head` counts on `ats_candidates` | counted from the pool rows the page already reads (`countCandidatePoolStatuses`) |
| Intake context ("Source" and "Applying for") | `.in("candidate_id", …)` in batches of 100 over the pool's ids, 15 requests, started after the pool arrived | one keyset walk of `ats_candidate_source_context` (1,412 rows, 4 ms whole), started before the pool |
| The "Not a CV" verdict | the same batched `.in()` over `ats_candidate_cv_extractions`, 15 requests, after the pool | one keyset walk of the table on `id`, selecting `id,candidate_id,created_at,is_cv` only (3,503 rows, about four requests), started before the pool |
| Vacancy report lookups | a name request and a code request for lines, and again for areas | one `id,name,code` request each (`loadNameAndCodeLookup` in `src/lib/reports/vacancies.ts`); the Organogram and the requisition autopilot read it too |

Estimated by counting the loaders, not measured on a live load: about 79 requests down to about 44,
and the longest sequential chain from about 7 waves to about 5.

## Why the rules are what they are

- **Counts from rows are exact.** `mapCandidate` keeps the raw status string (default `new`), so
  counting rows gives the five exact piles and everything else — a legacy free-text status, a different
  case, a missing one — falls into `new`, which is how `getCandidatePoolCounts` already took `new` (the
  remainder after the five piles). `candidatePoolCountsFromTotals` is the one remainder rule, shared by
  the head-count path and the row-count path.
- **Only a viewer who reads the pool may hand counts over.** A viewer without `canViewCandidates` holds an
  empty list, which would count as an empty pool. Both pages pass `candidatePoolCounts` only inside
  that guard. A failed pool resolves to `null` and the dashboard makes its own six counts, so a failed
  pool still leaves the tiles their figures.
- **The two whole-table reads start before the pool and both catch inside.** Started after the pool,
  they were a wait at the front of the longest chain. Because a failed pool read leaves them unawaited,
  a rejection with no handler would be a crashed process; both return an empty result on any failure,
  which flags nobody and shows no source — the direction that hides no applicant.
- **The verdict rule is the pure `notACvCandidateIds`.** The newest row per candidate decides, by
  instant (two spellings of one moment tie), the larger id breaking a tie, an unparseable stamp sorting
  oldest, and only an explicit `false` flags a row. The table is read in id order now, where the batched
  read arrived newest first, so the answer must not lean on arrival order.
- **Keyset, not offset.** The view is walked on `candidate_id` (unique in it) and the table on `id`, so
  a CV arriving mid-read can neither repeat nor skip a row.

## The lever left, and why it was not pulled

`attachUnconfirmedCvFacts` still reads the extractions in nine batches plus job titles. It pulls
`extracted_fields` paths, which means detoasting a large JSON column: a whole-table page with that
extraction cost about 405 ms on production against about 4 ms for the narrow verdict columns. Turning
it into whole-table pages would trade requests for slower requests. The real fix is a view or function
that returns the few confirmed facts per candidate — a migration, so it waits for its own change.

Raising the `.in()` batch size was rejected: PostgREST silently returns nothing for a long `in` list.

## When a read fails — the page settles each read

On 18 October 2026 the database timed out between 10:30 and 11:55 Cairo and the Talent Acquisition seat
met a blank page. Both page files used to run seven reads in one `Promise.all` inside one `try`: any
rejection blanked the page, wrote nothing to the log, and the workspace told the reader to "apply the
recruitment migrations on staging" — advice for a fresh environment, on a production page that was only
waiting on a slow database.

`settleRecruitmentPage` (`src/lib/recruitment/page-reads.ts`) now runs the eight reads (the seven plus the
CV-folder cabinet) and settles each one on its own. It never throws.

- **Required:** the dashboard (requisitions and pipeline) and the candidate pool. Neither has a deadline.
- **Optional:** the open vacancies, the position catalogue, the hiring managers, the employee directory,
  the area options and the cabinet. Each carries an 8 s deadline, so one slow extra list cannot hold the
  page for the full 15 s request timeout. A failed optional read leaves its slot empty and the rest of
  the page works.
- **Missing is not zero.** A failed pool shows "—" in the four candidate tiles and "unavailable" in the
  candidates tab, never 0. The empty arrays and the empty cabinet exist only because the client components
  need a value; the failed sources travel beside them as `unavailableSources`.
- **The reader is told which part is missing**, in plain words, with a Try again button
  (`RecruitmentUnavailableNotice` names every source that did not load, and a tab whose own data is
  missing says so instead of showing an empty table).
- **One log row per bad load:** `logRecruitmentReadFailures` writes ONE aggregated `app_error_events` row
  for the route, naming each source and what it said (`describeThrown`), fire-and-forget so the log can
  never hold the page up. Nothing was written before.
- **No stale pool copy.** A recruiter who has just edited something must never be shown older data after
  her own change, so a failed pool is reported as unavailable rather than served from memory.

The pinned literals the round-trip test reads (`const candidatePoolCounts = canViewCandidates ? poolLoad.then(...)`,
`getRecruitmentDashboard(access, candidatePoolCounts ? { candidatePoolCounts } : {})`,
`listCandidates({ withRepeatingCvBlocks: false })`) stay in both page files.

## Pinned by

`tests/recruitment-pool-round-trips.test.ts` (registered in `tests/run-tests.ts`) and the updated
`tests/recruitment-candidate-pool-table.test.ts`. Each fix was broken in turn and its own assertion
fired: the newest-row rule, the source-context walk started after the pool, the admin page handing
counts without the viewer guard, the dashboard fallback removed, vacancies back to a name-only select,
and a verdict loader without its catch.

`tests/recruitment-page-reads.test.ts` pins the settling: a throwing pool read is reported as a failure
rather than thrown, an optional read that misses its deadline is dropped while the dashboard and the pool
are never cut off, the log message names each failed source with what it said, and both page files keep
the settle call and never go back to one `Promise.all`. It was broken by making the pool read throw, and
its own assertion fired.
