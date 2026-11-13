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

## The employee is told — added 2026-10-12, after the release went out in silence

Owner, 2026-10-12: *"i released a deduction the employee not recieve an email"*.

He had released one line on production at **14:13 Cairo** that day — Nahed Tarek, 11 October,
`no_records_activity`, **1,032.26 EGP**, the only row in `daily_deductions_publications`. Read back
the same hour, `notification_outbox` held nothing for her and `notification_events` held no
`deductions` row after 9 October: **nothing was ever enqueued.** Not a delivery failure, not a
suppression, not a bounce — the release path wrote the snapshot and the audit log and notified nobody
at all. The monthly Deductions module has notified the employee since 2026-09-22
(`src/lib/deductions/notify-deduction.ts`, 145 `deductions` events on production); the daily page's
own Release button was never wired to it.

`releaseDailyLines` now calls `notifyDailyDeductionsReleased`
(`src/lib/daily-deductions/notify-release.ts`), which reads the rows the RPC just wrote and hands each
to the **same** `notifyDeductionPushed` the monthly push uses. One wording, one CC rule, one
idempotency scheme however a deduction reaches the employee:

- the employee gets *"Payroll deduction recorded"* in-app and on Telegram, with **no amount and no
  category**, pointing at their own self-only Deductions page;
- the employee ALSO gets an **email that names the amount, the reason and the days** (below);
- their manager chain gets the bare heads-up with the employee's name, in-app and Telegram only;
- the per-line outcome is written into the release's audit entry and returned by the API, so a report
  can never imply a notice that did not go out.

### The email — his 2026-10-12 decision, taken on this report

The silence was the defect; the missing email was his own 2026-09-22 rule (*a deduction notice never
goes by email*). Both were put to him together, and he chose **"add email, with the amount and the
reason"**. So the channels now SPLIT, and the split is the rule:

| Channel | What it carries |
| --- | --- |
| Email, to the employee | The amount in EGP, the reason in words, the number of days, and the exact days charged |
| In-app and Telegram, to the employee | Unchanged: that a deduction was recorded for a month, and a link to their own page |
| In-app and Telegram, to the manager chain | The employee's **name** only — no amount, no category, no destination |

A manager's inbox is deliberately **not** in that table: the `sendToRecipients` call has no email
channel and no `email` block at all, so it cannot carry a colleague's figure even if a template were
added later. His decision widened what the EMPLOYEE's own copy says, not who sees the figure.

What the email states comes off the **stored row**, never off the candidate the screen showed —
`loadReleasedLinesForNotice` reads `amount` and `days_count` back after the RPC wrote them, and
`pushOneCandidate` takes `applied_amount` / `applied_value` off the returned line. An employee is
being paid short by this figure; it has to be the figure that was frozen. Where a caller genuinely
cannot resolve one, that row is **omitted** rather than mailed as a confident `0.00`, and the day
count is omitted entirely for a `loan` or `other` line, which is an amount and has no days.

The wording is in `src/lib/deductions/notify-deduction.ts` — `buildDeductionEmailSummary` and
`buildDeductionEmailMetrics`, both pure and both pinned. A category's human name comes from
`deductionsCategoryNames` in `src/lib/deductions/types.ts`, typed as a full `Record` so a new
category cannot be added without naming it: the alternative is mailing `crm_half_day` to the person
it charges. `crm_half_day`'s 0.5 reads as *half a day*; `templateKey: "general"` is pinned so the
module's own template cannot frame the mail and bury the amount it exists to state.

Idempotency rides on the line id, which `phx_release_daily_deduction_lines` keeps stable per
(publication, employee, category) through its `on conflict … do update` — so re-releasing a line
already in the snapshot re-sends nothing, and an **Update release** after the tally changes does not
re-notify.

## Release by day — added 2026-11-13

Owner, 2026-11-13: *"I want you to separate each separate deduction day alone ... if you have 9 and 10
and 11 days, November ... I want to select day 9 and day 11 in November and release only their
deductions."* Until then the smallest thing he could release was one employee × one type, which carried
EVERY day of the range at once.

The running tally now opens with a **Release by day** panel: one row per day in the tally, with its own
tick, its deductions and people, its total, its state (**Not released**, **N of M released**,
**Released**) and its own **Release day** button. **Select all days**, **Clear** and **Release N days
(X EGP)** release the ticked days together; every other day stays exactly as it is. On every tally line a
day already out is drawn green with a tick, and a line holding some of its days reads **Some days
released** with **Release the other days**.

How the money is right:

- **Every day is priced by the server, by the connector's own rule.** `clipDraftToRange` prices each kept
  day alone with the same `scaleDeductionAmountToKeptDates` the line uses, so a CRM Thursday is half a
  day here too, and `aggregateClippedLines` sums the days across findings into `line.days`. A line with
  any unpriceable day carries no `days` and can only be released whole — never split on a guess.
- **All of a line's days = the line's own figure to the piaster** (`figuresForDates`), so releasing a
  line day by day ends exactly where the whole-line release would.
- **The snapshot still keeps ONE row per employee × type** — no migration. Releasing the 11th after the
  9th sends that row with BOTH days and their summed price; the RPC replaces the row. The confirmation
  shows what the ticked days **add**, not the row's running total.
- **A row with days already out beyond the counted window is held back and named**
  (`released_outside_range`): the tally cannot price those days, and re-sending only the in-range ones
  would silently take them back out of the employee's deductions. Count a range that covers them.
- **The release is filed under the days it carries** (the hull of the sent days), not the whole window
  counted — releasing 9 and 11 November never reads as "1 — 12 November released".
- **A later day tells the employee again.** The notice key is now the line id PLUS its days
  (`releasedLineNoticeKey`, passed as `noticeKey` to `notifyDeductionPushed`), so the 11th released after
  the 9th is a new email naming the row's amount and days now charged; the same days never twice. The
  monthly Deductions module still keys on the line id alone.

Pinned by `tests/daily-deductions-release-by-day.test.ts`. Break check: send the whole line instead of
the ticked days and "only the ticked days are sent" fires; key the notice on the id alone and "releasing
the 11th after the 9th is a new notice" fires.

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

`tests/daily-deductions-release-notice.test.ts` — that the release path CALLS the notifier, the month
label taken from the day charged rather than the clock, one notice per line under its own stable id
carrying that line's own stored amount and day count, a pair whose row cannot be read reported as
`not_found` rather than counted as sent, the employee's email naming the amount / reason / days and
omitting what it was not given, and the manager CC carrying no email channel at all.

Break checks, each run on its own and restored from a copy, 2026-10-12: renaming the notifier call to
`notifyDailyDeductionsReleasedXX` and deleting the call outright each fired *"releaseDailyLines must
CALL the notifier"*; dropping `"email"` from the employee's channels fired *"the employee's notice
carries all three channels"*; adding `"email"` to the manager CC fired *"the manager CC is never
emailed"*. A plain substring check does **not** catch the rename — the assertion is a word-boundary
regex for exactly that reason. One more trap worth knowing: `Intl.NumberFormat` puts a **non-breaking
space** between `EGP` and the figure, so an expectation typed with an ordinary space fails on a value
that is perfectly correct; the test normalises U+00A0 rather than loosening to a substring that would
also pass on a missing amount.

Files: `src/lib/daily-deductions/{lines,release,release-state}.ts`,
`app/api/admin/daily-deductions/{release,withdraw}/route.ts`,
`src/components/admin/daily-deductions-workspace.tsx`,
`supabase/migrations/20261012132430_daily_deductions_per_line_release.sql`.
