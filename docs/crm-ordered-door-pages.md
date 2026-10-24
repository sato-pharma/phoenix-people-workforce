# An ordered page of a unified door, and why it is paged by cursor

The account behind the `crm-unified-doors` module rule "AN ORDERED READ OF A DOOR CANNOT STOP EARLY".
The change is in `src/lib/crm/master.ts` (`walkMasterExportPages`), pinned by
`tests/crm-master-export-keyset.test.ts`. Sibling of
[the contact truth cache](crm-contact-truth-cache.md) and
[the entry-days cache](crm-rep-entry-days-cache.md), which this follows on from — those two took the
per-row cost out of the doors, and this one takes out the re-reading.

## What was measured, on production, 23 October 2026

All figures are `explain (analyze, buffers)` against `ozucdzovmcqvepbozvqf`, after the two caches
landed that morning.

| Ordered page of `crm_checkins_unified` | Rows produced | Buffers | Time |
| --- | --- | --- | --- |
| One export page (both branches), 2026-01-01 → 2026-10-23, `limit 5000` | 142,363 | 116,832 | 1,361 ms |
| Company-wide, 83-day window, `order by check_date, id limit 1000` | 43,926 | 29,640 | 3,176 ms |
| **Agent-scoped**, same 83 days, `agent_crm_id = 1505` | 2,091 | 5,910 | **33 ms** |
| **One calendar day**, dense, generic plan | 872 | 662 | **8 ms** |

The last two rows are the point: a page that names a person, or one day, is already fast. It is the
**unsliced ordered window** that is not, and the reason is that the page's `LIMIT` cannot stop the
scan:

- **No index gives the door its sort order.** Each union branch is scanned by `check_date` alone
  (`ireports360_checkins_check_date_idx`), so a sort key of `(check_date, id)` has no matching path
  and no `MergeAppend` is possible.
- **The contact-truth join is a hash join**, which carries no pathkeys, so even an ordered Append
  below it would be re-sorted above it.
- **The planner cannot estimate the cutover clause.** `check_date < COALESCE((select cutover_date …),
  'infinity')` compares against a subquery result, so it falls back to a default selectivity: the
  plan above estimated **1,207 rows and got 142,363**. With an estimate that small, sorting looks
  free and no early-stopping path could win even if one existed.

So every ordered page reads its whole window, and the only question is how many times.

## What OFFSET cost

The CRM Master export walked pages with `.range(from, from + PAGE - 1)` — `LIMIT 5000 OFFSET from`.
Postgres builds and throws away every row before the offset, so **each of the 29 pages repeated the
1,361 ms scan**: about 3.4 million buffer touches and 39 seconds of database work for one export,
with the whole window materialised 29 times. That is the shape behind the 2026-07-29 incident, where
the connection was cut mid-export and the workbook came out corrupted. The per-page check-ins
correlation query fixed then was the larger half; this was the rest of it.

`src/lib/crm/reps-list.ts` had already fixed the same defect for the rep's pin list, and
`src/lib/crm/reads.ts` had already fixed it for company-wide reads with `dayScanSlices`. The export
was the one walk left on OFFSET.

## The shape now

`walkMasterExportPages` is keyset, newest first, one calendar day at a time when the window is
bounded:

- **The cursor** is `date.lt."X" OR (date.eq."X" AND id.lt.Y)`, built by `masterExportCursorFilter`.
  A bare `date.lt` would drop the rest of a tie group; a `date.lte` would hand the same rows back for
  ever. Production has 1,797 check-in timestamps shared by two or more rows, up to 20 on one.
- **A bounded window** is cut into calendar days through the same `dayScanSlices` the read side uses,
  then reversed, so each page is bounded to one day's rows whatever plan Postgres picks. The days are
  disjoint and cover the window, so emitting them newest first **is** the single ordered scan's order.
- **An unbounded export** (no date filter, or a window past the 400-day slice cap) keeps one keyset
  walk. No window is derived from the data, because a derived bound could silently drop a row outside
  it — and a silently short export is the failure mode that matters here.

## The two facts it rests on, both verified rather than assumed

- **`(date, id)` is a total order on all three doors.** `crm_checkins_unified` 142,363 rows,
  `crm_visits_unified` 148,484, `crm_visits_checkin_flags` the same 148,484 — every id non-null and
  every one distinct. The iReports360 ids are positive (minimum 396,140) and the synthesised Phoenix
  ones negative (maximum −1,996,622,939,714), so the two halves cannot collide.
- **PostgREST ANDs repeated `or=` groups.** The cursor is a second `or=` on a query that may already
  carry the double-visits partner filter. Asked straight of production: the partner group alone
  matched **17,161** rows, and the same request with a second, deliberately false group matched **0**.
  So the cursor narrows the partner filter rather than replacing it.
- **A 5,000-row page is honoured.** `limit=5000` on the door returned exactly 5,000 rows, so no
  `db-max-rows` cap truncates a page. This matters more than round-trip count now: the walk ends a
  slice when a page comes back short, so a silent server cap would end the export early.

## What is still slow, and is NOT this

**Planning.** The door costs 11–18 ms and ~1,600 buffers to PLAN, which on a day-sliced read now
exceeds the 8 ms it costs to execute. Whether production pays that per request or once per connection
depends on PostgREST's prepared statements, and `pg_stat_statements.track_planning` is off on this
project, so it was not measurable from here and no claim is made about it. Reducing it would mean
simplifying the door itself — fewer union branches and fewer InitPlans — not changing how it is paged.

## Why the two iReports360 branches stay as they are

The follow-on from "What is still slow": the check-ins door's iReports360 half is two union branches
that differ only in the team-start bound, and merging them was the obvious way to cut the planning
cost. It was built and measured on production on 23 October 2026, and **it is a loss** — recorded
here so the next session does not pay for the same measurement.

### The merge is correct

Branch A is `check_date < team_start_bound`; branch B is `>= team_start_bound` plus two entry-day
anti-joins. Merging means dropping the bound and keeping the anti-joins, which is valid because
**no entry day can precede that bound**:

- both arms of `phoenix_crm_rep_entry_days_calc` join `phoenix_crm_started_team_seats()` and bound
  the day at `team.starts_on` — the activities arm at
  `least(team.starts_on, coalesce(run.day_activities_from, team.starts_on))`;
- that is the same expression the door takes the global `min` of, and `phoenix_crm_started_team_seats`
  reads `starts_on` and `stops_on` straight from `phoenix_crm_team_starts`;
- so every entry day is `>=` the bound, an A-row's day is strictly below it, and an A-row can never
  match one. Empirically the two are exactly equal today: earliest entry day **2026-10-03**, global
  team-start bound **2026-10-03**.

Proved rather than assumed: the merged body and the live view each returned **137,709 rows, with 0
only-in-live and 0 only-in-merged** (`except` both ways on `id, source, check_date, crm_checkin_id,
contact_name`).

### And it costs more

Warm against warm, same 2026-01-01 → 2026-10-23 export page, same 142,363 rows out of the Append:

| | Live view (two branches) | Merged (one branch) |
| --- | --- | --- |
| Execution | **1,361 ms** | 1,429 ms |
| Planning | **16.8 ms** | **39.3 ms** |
| Buffers, iReports half | ~83,300 | **10,964** |

The buffer column is the trap. One `NOT EXISTS` pair over the whole window lets Postgres switch to a
**Bitmap Heap Scan**, which visits each of the 10,112 heap blocks once instead of an index scan
revisiting pages in index order — 7.6× fewer page touches. But those touches were cache *hits*, so
they were nearly free, and the saving is spent probing the anti-joins **137,709** times instead of
6,962. Net: execution is a wash and **planning more than doubles**, which is the one thing the merge
was supposed to reduce.

Fewer page touches is not less time. The two branches stay.

### The one unsliced ordered read left is unreachable

`queryCheckins` in `src/lib/crm/reads.ts` has a second path for `options.limit != null` that orders by
`check_date` and never day-slices. **No caller passes `limit`** — `brick-coverage.ts`,
`call-rate-service.ts`, `phoenix-kpi-data.ts` and both `master.ts` call sites all go through the
keyset path — so that branch cannot be reached today and its missing day-slicing has never cost
anything. Worth knowing before anyone "fixes" it.
