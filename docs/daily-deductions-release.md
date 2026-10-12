# Daily Deductions — releasing one deduction at a time

Owner request, 2026-10-12: *"in /admin/daily-deductions i want to be able to select per deduction per
employee and be able to release a single deduction separately not all together exactly as weekly
attendance digest full control"*.

## What it does

`/admin/daily-deductions` is the reporting-only surface beside the month-final Deductions module. It
writes no salary row. The Super Admin computes a tally per connector over a date range, then **releases**
the deductions he chooses into the one active snapshot:

- every tally line (an employee x a deduction type) has its own tick and its own **Release** button, and
  every line starts unticked — the weekly attendance review's model;
- every employee has **Release this employee**, and a tick that selects all of that employee's lines;
- the toolbar has **Select all**, **Clear**, **Release selected (N)** and **Release all (N)**;
- a line reads **Not released**, **Released**, or **Changed since release** (the tally now counts
  differently; the button becomes **Update release**);
- the **Released** panel lists what is in the snapshot, each line with its own **Withdraw**; **Withdraw
  all** supersedes the whole snapshot as before.

Only the Super Admin releases or withdraws. CEO and HR Operations read.

## How it is stored

A release **merges** into the single active snapshot and creates it when none is active — it never
replaces what was already released. `phx_release_daily_deduction_lines` upserts on
`(publication_id, employee_hr_id_compact, category)`, so re-releasing a line replaces only that line.
Each line carries `released_at`, `released_by`, and the `range_start` / `range_end` it was counted over;
the snapshot's own range is the hull of its lines' ranges, and its counts and `category_totals` are
re-derived from the rows after every release or withdraw.

`phx_withdraw_daily_deduction_line` removes one line, re-derives the same figures, and supersedes the
snapshot when its last line goes. All three functions (`phx_release_daily_deduction_lines`,
`phx_withdraw_daily_deduction_line`, and the re-created `phx_publish_daily_deductions`) are SECURITY
DEFINER with a pinned `search_path`, revoked from `public`, `anon` and `authenticated`, and granted to
`service_role` only; they share one advisory lock (`daily_deductions_snapshot`) so a release, a withdraw
and a publish can never interleave.

## What was kept

The replace-everything `POST /api/admin/daily-deductions/publish` route and
`phx_publish_daily_deductions` still exist but the page no longer calls them. They now also stamp the
per-line columns. Nothing deletes them; remove them in a later change if the owner confirms nothing else
uses them.

## What this did NOT add

Editing the number of days per line before releasing (the weekly review lets HR change the days to
deduct) was not asked for and was not built. A released line carries exactly the figures the tally
showed.

## Pinned by

`tests/daily-deductions-release.test.ts` — the line state against what is released, which lines a click
sends, the server-side validation every sent line passes, and the migration's merge-not-replace shape
and its revokes / grants. Break check: make the release function supersede the active snapshot and the
"never supersedes" assertion fires.

Files: `src/lib/daily-deductions/{lines,release,release-state}.ts`,
`app/api/admin/daily-deductions/{release,withdraw}/route.ts`,
`src/components/admin/daily-deductions-workspace.tsx`,
`supabase/migrations/20261012132430_daily_deductions_per_line_release.sql`.
