# Needs You — the whole module

One question, asked once: **what is waiting on a decision only the owner can make?**

| Surface | When | What it carries |
| --- | --- | --- |
| `/admin/needs-you` | on demand, Super Admin only | the full board, five bands |
| `node scripts/needs-you.mjs` | on demand, terminal | PRs and the production revision — tier 1, no model, no credentials |
| Telegram + in-app digest | every morning, 06:36 Cairo | the board, fitted to 900 characters |
| Email | Sundays, 06:36 Cairo | the board, **complete** — every item and every source's verdict |
| Claude Code status bar | when a session opens | one line: the oldest thing waiting, and how old the reading is |

Tier 1 has its own page — [tier-1-needs-you.md](tier-1-needs-you.md) — because it is a different
thing: dev-ops facts, read from GitHub with no database and no session. This doc is the business
board and the four ways it reaches him.

## Why it exists

Merging, publishing and approving are actions this system never takes on his behalf (AGENTS.md §6).
So at any moment some number of things sit waiting on a click only B-10 makes, and before this the
only way to learn what they were was to open a session and ask, or to walk a dozen admin screens.

The app already had **three** half-overlapping "needs attention" aggregators and none was a superset:
`getCeoAdminSignals`, `getAwaitingMyActionItems`, and `GET /api/approvals/badge-counts`. Each was
blind to things the others saw. This module is one domain service with several front doors — and one
fewer aggregator at the end, not one more.

## 🔴 The rule that shapes every line of it

**A board that under-reports is worse than no board.** If it says nothing is waiting while something
is — or while a read simply failed — it costs the decision more surely than no board would, because
the looking has been delegated.

That is enforced structurally, not by discipline:

```ts
type NeedsYouSourceState =
  | { status: "ok";             items: readonly NeedsYouItem[] }
  | { status: "not-applicable"; because: string }   // no permission — a TRUE zero
  | { status: "unavailable";    because: string };  // it did not answer — NOT a zero
```

- A failed source produces **no item**, so there is no `number` field a failure can write to.
- `allClearProvable` is computed once, in `classify.ts`. Nothing else decides the empty state, and
  in particular never `yours.length === 0`.
- `board.sources` carries **one entry per source id, always** — pinned by a test, so a source lost to
  a dropped `await` fails CI instead of rendering as calm.
- `not-applicable` is a third state so that nine permission refusals do not become nine permanent
  amber rows, which is how a reader learns to ignore amber.
- **The could-not-be-read section renders FIRST in every channel.** Telegram is 900 characters of
  plain text sliced from the END, mid-word, with no marker, so a section rendered last is one that
  silently disappears.

## The sources

One adapter per source, one fan-out, an 8-second per-source timeout. A source that has not answered in
eight seconds is a source whose contents are unknown, and it renders amber rather than empty.

🔴 **THE FAN-OUT IS BOUNDED, AND THE LANE WIDTHS ARE THE FIX RATHER THAN A TUNING** (2026-10-09). It
was an unbounded `Promise.all` over all 22 sources, and on production the owner read the board three
times and got 9 items, then 8, then 7 — a different set of amber rows each read, nine of the 22
sources unread on the one he kept, and behind two of them **13 marketing requests at his own step,
overdue**, and a leaver with an uncollected deduction nine days old. **Nothing was slow.** Measured
alone against production the same evening: `closing-publication-drift` 5,516 ms, `action-inbox`
5,119 ms, `office-allocation-drift` 4,640 ms, every other source under 1,100 ms — **0 of 22 over the
budget**. Started together, the same three took 10,280 / 9,387 / 9,222 ms and even a 903 ms source
took 7,016 ms: the budget was being spent queueing behind the other 21 reads, so **which** sources
ambered was luck.

So an adapter declares `cost: "heavy"` and `service.ts` runs two lanes at once — **heavy one at a
time, light four at a time** — with each source's clock starting when THAT source starts, and a
45-second ceiling on the whole fan-out so bounding the width cannot unbound the total. Measured
after: three whole-board reads at 12.2 s, 14.9 s and 19.6 s, every one of them **0 amber of 22** and
the identical 14 / 9 / 1 lanes.

- **A heavy lane of two is not a cheaper version of this.** Its peak was 7,687 ms against an 8,000 ms
  budget — 313 ms, on a laptop measurement carrying none of production's traffic — and the 22-way
  shape provoked a real `57014 canceling statement due to statement timeout` out of
  `phx_closing_drift_status`.
- **A new source that costs seconds MUST declare it.** An undeclared heavy source joins the light
  lane and inflates the other three sources there, not only itself.
- **The page is slower on purpose, and the ceiling is not a latency target.** The way to make this
  page faster is to make a heavy source cheaper — which changes what it measures, and is the owner's
  call rather than a scheduling one. Pinned by `tests/needs-you-source-scheduling.test.ts`.

`action-inbox` · `plan-approvals` · `leave-approvals` · `excuse-approvals` ·
`direct-order-approvals` · `direct-order-unbooked` · `direct-order-validations` ·
`marketing-approvals` · `market-awareness-approvals` · `monthly-closings` · `payroll-publish` ·
`resignations` · `contract-renewals` · `probation-decisions` · `coaching-red-zone` · `salary-flags` ·
`phoenix-crm-decisions` · `orphaned-requests` ·
`uncollected-leaver-deductions` · `calendar-review-requests` · `closing-publication-drift` ·
`office-allocation-drift` · `organogram-seat-drift` · `vendor-github` · `vendor-whatsapp` · `vendor-telegram`

`vendor-github`, `vendor-whatsapp` and `vendor-telegram` joined on 2026-11-03, after GitHub suspended the account on
2 Nov and Supabase showed outstanding invoices, and neither reached any board. **Three sources, not one**, so one failed
read cannot hide another or print a false all-clear. All three are his alone (`ownerOnlyQueue`), link to System Audit,
and say a fixed sentence, never the vendor's text (`src/lib/needs-you/vendor-accounts-rules.ts`).

| Source | What it reads | Nothing on the board | A row in his lane | "Could not be read" |
| --- | --- | --- | --- | --- |
| `vendor-github` | the hourly dispatch's heartbeat, no network call | the last run dispatched | GitHub answered 4xx, or the key is missing | GitHub unreachable, 5xx or 429, or no report for 12 hours |
| `vendor-whatsapp` | one read of every configured line | every line answers | Meta answered 4xx, a line is not connected, or the key is missing | network failure, 5xx or 429 |
| `vendor-telegram` | the bot's webhook read | Telegram answered | 401 or 404, or the key is missing | network failure or any other status |

A missing key on staging is `not-applicable`; on production it is a row.

The third WhatsApp number, used only for approval reminders, is asked as well, but it is deliberately not in
`WHATSAPP_PHONE_NUMBER_IDS`, so a fault on it can never read as the recruitment intake being down.

🔴 **What this cannot see is printed on the board and the Sunday email, as a fixed line:** Supabase invoices, Railway
standing, GitHub billing, OneSignal, Google Maps, Sentry and cron-job.org. Production holds no key that can read the
first two, and putting an account-wide key in production is not proposed. **It would have caught GitHub on 2 Nov, and it
would not have caught the Supabase banner.** The line is a constant rather than an item, so it can never block the
all-clear for ever.

`orphaned-requests` joined on 2026-10-04: a request in ANY chain (marketing, direct orders, vacation)
stranded because the one person who must act next has resigned — a `returned` request whose requester
has left and can never resubmit it, or an approval rung named to someone who has gone. Nothing else in
the product surfaces it (it is not in anyone's "waiting on me" queue and it is not terminal), so it
ages out of sight; five direct orders sat 48–52 days this way before a hand sweep found them. The rule
and the three-chain read live in `src/lib/approvals/orphaned-requests.ts`, which THROWS on a failed
read so an unread chain is amber, never calm. It sits in `worth-knowing`, each item links to the module
screen that owns the cleanup, and — like the payroll row — it never states the money a direct order
carries.

A returned VACATION is the employee's case too (fixed 2026-10-08). Until 2026-10-15 no control could
clear one, so that item said no screen could clear it yet instead of naming a verb. It now says to
close it on Stuck Approvals (`closeOrphanedVacationRequest`, Super Admin only, result `cancelled`).

`phoenix-crm-decisions` joined on 2026-10-03: Phoenix CRM's list requests and off-plan visits at the
viewer's own step, plus the carried-over customers still waiting to be validated. **The sent weekly
plans joined on 2026-10-08** — the module's own badge had always counted them while this board read 0,
so a district manager with a rep's whole week on his desk saw nothing here. 🔴 **It counts
nothing itself** — `src/lib/phoenix-crm/server/decision-queues.ts` is the ONE producer and the Phoenix
CRM page's own "waiting for you" badge reads the same functions, so the board and the module can never
disagree about whose turn it is. A medical rep is `not-applicable`, never a zero and never a row.

🔴 **A fourth row joined that source on 2026-10-05: the places the Google Maps check could not
settle.** The owner had put that queue on email, in-app and Telegram the same day, naming the page
("when an update here /admin/field-crm/validation-reviews I must be notified by email, in app and
telegram"), and the board is the fourth way the same hold reaches him — the only one that still shows
it tomorrow if a notice arrives at midnight and nothing is done about it. Two things about it look
like tidying and are not. **It carries its OWN `href`** to `/admin/field-crm/validation-reviews`,
because the source's Team tab cannot decide one of these; `orphaned-requests` does the same for the
same reason. And **the count is the Super Admin's alone** — `countValidationReviewsWaiting` is asked
only when `canDecideValidationReviews` is true, so every other viewer gets a true zero with no query
at all, rather than a figure about a queue nobody but him can clear. It is the one row in this source
that carries an `oldestAt` and an age, because the delay has a growing cost: the customer stays
unvalidated and a visit there scores nothing. It still carries no `overdue` verdict — the module
publishes no SLA for it. 🔴 **And the count filters NEITHER world**, because the page lists both and
marks each row, and the decider's own entries are test entries (owner, 2026-09-16) — a real-only count
would be a board permanently calm about the only queue that is his by name. The count lives in
`src/lib/phoenix-crm/server/validation-reviews.ts`, the file that owns that table and its gate, for
the same one-producer reason the other two live in `decision-queues.ts`.

Each adapter owns its own `assertPermission` call. Leaning on the page being Super-Admin-only would
be true today and the wrong shape: the module would then be correct only because of a caller, and
`not-applicable` could never be reached.

🔴 **Never source these from `GET /api/approvals/badge-counts`.** It is an HTTP hop from a server
component back into its own app: it needs the session cookie, doubles the latency, and — fatally —
inherits that route's deliberate `{count: 0}` fallback, which is correct for a badge and is the one
shape this module must never have. Call the functions underneath it instead. For marketing that
means `getMarketingApproverBadge`, which already drops the `assigned_hr_id` filter for a
`canViewMarketingOversightQueue` viewer and **throws** rather than returning 0 — never
`getApproverPendingRequests`.

🔴 **One call, never a deferred or streaming second phase.** Several of these reads take seconds, so
the tempting shape is a fast band plus a `<Suspense>` band that fills in later. That re-opens the
exact hole this module closes: a deferred band that fails renders *nothing*, and a missing source
becomes invisible again — the under-report, dressed as a performance win. The page is
`force-dynamic` and a reload is the refresh. There is no polling.

### `office-allocation-drift` — joined 2026-10-09

**The question nothing in the product could ask.** The Office channel carries no geography, so the
owner's golden rule spreads it: each area takes its share of the line's non-Office **value**. Those
shares are computed ONCE, when the Office file is committed, and written into the rows —
`app/api/sales/monthly-sales/office/commit` is the only code anywhere that computes them, and
nothing re-runs it. A distributor book that lands or is re-mapped AFTER that commit therefore moves
the value base underneath a spread already frozen into the rows.

🔴 **AND THE PUBLICATION DRIFT CHECK IS STRUCTURALLY BLIND TO IT.** Today's side of the comparison
is today's shares applied to the line's OWN stored Office total, so both sides hold identical units
per line by construction — and the published-closing check compares exactly that one scalar. So the
two rows are not duplicates and must never be "reconciled": measured on production 2026-10-09,
**August 2026 CNS has 3,698 of its 109,719 Office units (3.37%) sitting in a different area from the
one the rule gives them today, across 43 areas**, with seven distributor books (ramco,
EPDA-Pharmacies, EGD, sofico, Ibn Sina-Sato, overseas, Ibn sina) written after the Office commit —
and every screen in the product read clean through all of it. Until this row existed the only way to
ask was for a session to remember to run `scripts/check-office-allocation-drift.ts`.

**It reads two periods and no more.** The latest period with an Office batch — the live month, where
a re-commit still costs nothing — and the latest PUBLISHED month that has one, where the spread is
already serving and the fix is ruled out. Measured the same day: 656 ms to list the nine periods
with an Office batch, 1,851–2,182 ms per period, **3,225 ms for the whole adapter** against the
8-second budget; all nine would be about 18 s. Every other month is the script's question and the
row says so.

**The published month drops to `worth-knowing`, deliberately.** Re-committing the Office book of an
announced month restates a published figure, which his 2026-09-07 rule forbids outright — so a
published row is there to be known, never acted on, and his `yours` lane stays a list of decisions
that are actually open. The row links to `/sales/import`, the only screen where an Office book is
re-committed, and **never proposes the upload**. It carries units and no EGP (the report has no
value side at all), names its cause in distributor NAMES rather than codes, and ages from the FIRST
base move after the commit — the instant it actually went stale — not from the commit, which was
correct when it was written.

Pinned by `tests/needs-you-office-allocation-drift.test.ts`. The script it names is itself guarded
by `scripts/lib/tree-is-current.ts`, because it recomputes the rule from its own checkout.

### `organogram-seat-drift` — joined 2026-10-15

**A detector that already worked, read by nobody.** `public.au_v_employee_seat_drift` compares
`employees.area_id`, `region_code` and `manager_hr_id` against the seat each active person holds in
the EU organogram — the source of truth for every employee's distribution since the owner's
2026-10-12 ruling ([eu-organogram-is-the-distribution-truth.md](eu-organogram-is-the-distribution-truth.md)).
It has four callers and **all four use it as a lookup table**: `weekly-planning/planning-areas.ts`,
the two CRM coverage loaders and `employee-360/brick-coverage.ts` take its seat columns and never
touch `area_id_drifted`, `region_code_drifted` or `manager_drifted`.

🔴 **SO THE FLAG SAT LIT FOR TWO DAYS AND A HUMAN FOUND THE PROBLEM INSTEAD.** A medical rep hired
into the Behira 1 rep seat on 8 October had her `area_id` edited on the 13th to Behira 2, another
rep's area. The weekly and monthly plan has **no rep picker at all** — it auto-assigns the rep from
the picked area, matching by area NAME, and `medicalRepOptionsForEmployee` takes that area from the
EMPLOYEE record, letting the seat fill only a blank. She vanished from her own area, which then
showed no rep, and in the area she had been moved into she lost to the alphabetically earlier rep
already there. Nothing ambered: the "needs an assigned Medical Rep" warning only fires for an area
that already has one. Her district manager noticed a missing name on the 15th, and one row of
production data fixed it — no code was wrong.

**One item per PERSON, never one per disagreeing fact**, because a record edited to the wrong area
usually carries the region with it: one typing mistake, one correction. The row names the person,
the seat, which of the three facts disagree, and **both values side by side** — with an absent value
reading as "the record holds no area" rather than as a blank, because that state is the worse one
(four of the six rows corrected on 2026-10-12 had no area on file, and those reps were being shown
"We don't have your area on file yet" on every territory screen).

**It proposes no repair, and that is the ruling.** Which side is right is a human judgement: on
2026-10-15 the SEAT was right and the record had been mis-typed; after a real transfer it is the
other way round and the seat is what has to move. The row links to that person's own record —
`/employees?edit=<hr id>`, the same arrival the organogram tile uses — and stops there. It is the
**Super Admin's lane alone**: this is HR data integrity, not a manager's queue.

🔴 **A PERSON WITH NO SEAT IS NOT DRIFT, AND THE VIEW IS RIGHT TO OMIT THEM.** Sixteen people sit in
the directory with no seat in the EU organogram — Admins, Finance, Human Resources, Marketing,
QPPV, R&D and SFE, the owner among them — because the seat model is the field force. The view starts
from the seated and joins outward. Widening this source to "has no seat" would put all sixteen on
the board on every load, for ever. `stale_marker` is left out for a different reason: it reports an
uncleared `pending_manager_replacement_for_hr_id`, which is a leftover marker rather than a
disagreement between the record and the seat.

**`cost` is light, measured.** Against production on 2026-10-15 the whole view is 97 seated actives
in one pass — `Execution Time: 3.228 ms`, planning 6.134 ms, 0 drifted rows — three orders of
magnitude inside the 8-second budget, so it joins the light lane. The three name lookups behind it
(the employee's area, the region names, the two managers) run only when something has drifted.
Pinned by `tests/needs-you-seat-drift.test.ts`, which is also one of the offline contract gates.

## Who produces what

🔴 **The adapters are the single producer for the three signals the CEO command centre also shows** —
contracts expiring, probation decisions due, and coaching red-zone reps. `getCeoAdminSignals` reads
them through `adaptersFor` + `loadNeedsYouSources`, and holds no copy of any of those rules.

That collapse fixed a live divergence. Both files had their own copy, and they had drifted: the CEO's
probation count filtered to people still employed and read the window from
`lifecycleRiskWindows.probationCriticalDays`; the adapter did neither, so it billed **leavers** as
decisions he still owed — the same defect that reached production once before as PD-0003.

**Do not call `getNeedsYouBoard` from the command centre.** It runs every source, and that
screen needs three, on the owner's heaviest landing page. `adaptersFor` runs exactly the ones asked
for. A test refuses the "simplification".

## Delivery

**Each digest is its own morning job — once the split switch is on.** Both ride
`/api/notifications/daily`, at 06:36 Cairo, beside about thirty unrelated jobs, and the daily digest is
awaited alone before the rest start. On 13 Nov 2026 the owner gave every one of those jobs its own
schedule (enterprise audit F-HR-012 / REC-049), shipped behind `PHOENIX_DAILY_JOBS_SPLIT` and switched
on after the thirty cron-job.org entries are armed (docs/deployment.md, "Switching the morning jobs
over"). Then the daily digest is the job
`needs-you-daily-digest` at **06:36**, first of the morning, on `/api/cron/daily/needs-you-daily-digest`
with its own heartbeat `phoenix-daily-needs-you-daily-digest`; the Sunday email is `needs-you-weekly-email`
at 07:25, which does nothing on the other six days and still reports. The list, the order and the times
are `src/lib/scheduled-jobs/daily-jobs.ts`; what each job calls is
`app/api/cron/daily/_lib/daily-job-runners.ts`. A schedule carries the heartbeat-parity contract — a
declared job that stops reporting pages every Super Admin every 15 minutes — so each job's cron-job.org
entry (`scripts/cronjob-sync.mjs`) has to exist.

The fan-out's positional `Promise.all` destructure and its hand-kept `totalJobs` are gone either way: the
fan-out runs the same per-job runners in the list's order and counts the list, and each per-job request
runs one job and reports that job's result under that job's name.

### The digest runs on a request of its own

🔴 **The board is gathered on a request that runs nothing else, and it has to stay that way.** The lanes
under "The sources" stop the 22 sources starving each other. They could not stop the other 30 sub-jobs of
the old `/api/notifications/daily` starving them — every one of those started in the same instant — so as a
passenger the board's sources spent their 8-second budgets queueing rather than querying. That is the
*same* defect the lanes were built to remove, one level up, and the lanes made it likelier rather than
less: serialising the heavy sources stretched the board's own wall-clock from about 8 s to 12–20 s, which
was 12–20 s of overlap with the other 30 instead of 8.

**Measured on production from the digests actually delivered** (`notification_events`,
`event_key like 'needs-you-daily-digest:%'`, `metadata->>'message'`), 06:36 Cairo:

| | |
| --- | --- |
| Mornings affected | **15 of 15**, 2026-10-09 → 2026-10-23 |
| First timeout each day | 06:36:09 – 06:36:17, without exception |
| Sources lost per run | 1–5 |
| Lost on all 15 | `action-inbox`, `closing-publication-drift` — the two `heavy` ones |
| Worst run | 23 Oct: 5 lost, `payroll-publish` among them, so that morning carried **no payroll line at all** |

Reading `/admin/needs-you` by hand ambers **0 of 22** throughout. Only the 06:36 run ever failed, which is
exactly the one context with 30 siblings in it — and it is why the page's own measurements said the board
was healthy while his morning message was losing a fifth of it.

The first fix (24 Oct 2026) awaited the board on its own inside that route, before the fan-out. Since
13 Nov 2026 it is simply alone: the digest is the only job at 06:36, the next one starts at 06:38, and
`/api/cron/daily/[job]` runs exactly one job per request. **Never put another job on its request or its
minute, and never answer a returning amber row by widening a lane or raising the 8-second budget** — that
buys a green digest with the board's honesty, which is the one thing this module refuses to sell. Make a
heavy source cheaper instead; that changes what it measures and is the owner's call. Pinned by
`tests/needs-you-digest-runs-outside-the-fanout.test.ts` and `tests/daily-jobs-split.test.ts`.

**Daily is Telegram and in-app; weekly is email.** One email to him is already *two* deliveries —
`send-phoenix-email.ts` mirrors a preview of every email to his Telegram, with no opt-out (it also
BCC'd `ADMIN_STANDING_EMAIL` until the owner stopped the standing BCC on 2026-11-06). That is why email is weekly, and why the weekly never also requests the `telegram`
channel.

**The email reaches exactly one person, guarded twice.** The job resolves him by his own hr id and is
skipped and audited if it cannot; `enforceNeedsYouOwnerOnlyEmail` then strips `email` at the end of
`basePolicyChannels` unless the recipient is provably him — using `isSamePerson`, because he also
signs in as PHX-1 and admin-HR. It **fails closed**: an absent or unresolved recipient strips email
rather than allowing it. A sent email cannot be recalled.

## Tier 2 — the written summary

One `gpt-5.4` call a morning: roughly 1,200 in + 300 out, about **$2.75 a year**. Cheapness is bought
by the cadence, not the model, so there is no nano→premium ladder — it would save $2.52 a year for a
second prompt to keep in step.

Three structural facts make a falsely calm summary impossible, any one sufficient:

1. The delivered message is *always* the deterministic render. `lead` is a **prefix string**, and
   `attachableSummary`'s return type cannot express a board, an item or a count.
2. The model is never invoked when a source could not be read. That day spends no token.
3. When nothing is waiting the summary is `null` unconditionally — the model never sees that board.

Six refusals, each printed in the digest rather than swallowed: unparseable JSON · an `order` that is
not a permutation (how a model silently drops an item) · a lead claiming completeness · a digit the
board does not hold · an ellipsis · over 220 characters.

🔴 **The lead spends the body's budget.** It is prepended outside `buildNeedsYouTelegram`, so it is
declared as a `reserve` that the builder counts before it starts filling. Measured before that
existed: a 20-item board plus a 220-character summary rendered **1053** characters against Telegram's
900 — and the overflow is the *board*. The feature meant to help him read it faster would have been
the thing hiding it.

## The status bar

A **name and the age of the reading, never a bare count** — a count read 9 for hours and nobody acted,
because a number needs a second lookup and that lookup is the step nobody takes.

```
> Needs you: merge 4571 - green on every required check (+1 more) - read 07:12 Cairo
> Needs you: UNKNOWN - 1 thing on the board could not be read - read 06:31 Cairo (41m old)
```

It **prints nothing when nothing is waiting**: a row saying "nothing needs you" every session is one
he stops reading, and it is the sentence that becomes a lie the moment a source fails.

Laptop files, outside this repo: `~/.claude/hooks/needs-you-status.mjs` (SessionStart) writes a
pre-rendered line that `~/.claude/hooks/statusline.mjs` only reads. The statusline spawns nothing and
makes no network call — so the reading can be stale, which is why the age is printed rather than
hidden. The hook imports the repo's own `buildBoard` rather than re-deriving the bucket rule.

🔴 **Nothing refreshes that cache automatically.** It is written when `scripts/needs-you.mjs` runs, so
the row reflects a *known* state, not a live one.

## What it deliberately does not do

- **It links, it never acts.** Every row's only control is a `<Link>` to the screen that already owns
  the decision. No form, no button, no server action, no non-GET fetch under the route.
- **No sidebar badge.** `NavBadge` does `if (!count) return null;` and the badge route degrades to
  `{count: 0}` — the under-report rule broken in the most-seen pixel in the product.
- **The nav row is gated by `roles`, never `permissions`.** That list is OR-ed, so a `permissions`
  entry would *widen* the gate rather than narrow it. It is the first item of the existing
  `command-center` section, with no `hubPageItemGroups` entry.
- **No WhatsApp push** (owner chose a share button): a free-form send needs him to have messaged the
  bot within 24h and fails silently as `131047` otherwise, and a template cannot carry line breaks.
- **No new `PermissionResource`.** That would need 17 matrix rows and would make the board *lockable*.
- **Nothing built on `getOverviewDashboard`** — it is dead, has zero consumers, and its name will
  convince the next reader it is the aggregator.

## Where it is pinned

Each is registered in `tests/run-tests.ts` and therefore a step of the required `checks` job — a test
file that is not registered never runs.

| Test | What it refuses |
| --- | --- |
| `needs-you-never-under-reports` | a dead source rendering as calm; `not-applicable` collapsed into `unavailable`; a dropped source |
| `needs-you-board` | the tier-1 CLI's bucket rule and its COULD NOT READ section |
| `needs-you-source-health` | a `.catch(() => null)` inside the awaiting-action fan-out; a badge with no `available` |
| `needs-you-ceo-single-producer` | either file re-implementing a shared rule; the CEO borrowing a number on failure |
| `needs-you-daily-digest` | the route's three hand-kept lists disagreeing; a crashed job reporting a zero |
| `needs-you-weekly-email` | the body or the source roster truncated; email to anyone but him |
| `needs-you-tier2-summary` | a summary that pushes the board past Telegram's ceiling |
| `needs-you-summary-guard` | the six refusals |
| `needs-you-email-owner-only` | the guard chain and its fail-closed direction |
| `needs-you-telegram-budget` | the 900-character fit, by construction rather than truncation |
| `needs-you-fits-the-screen` · `needs-you-page-never-decides` | horizontal scroll, rounded corners, any write path |
| `orphaned-requests` | flagging an active rep's returned request, a role rung, or an unknown actor; and the source not wired into the board |
| `orphaned-requests-reader` | dropping a resigned employee's returned vacation; reporting a reversed, expired or draft direct order as stuck on a leftover rung; missing an actor whose HR_ID casing differs from the master; a calm empty board on a failed read |
| `phoenix-crm-needs-you-source` | a second copy of the Phoenix CRM counts; a rep handed a row; an integrity signal reaching the board; the held-place row linked to a screen that cannot decide it, gated past the Super Admin, or counted in one world only |
| `needs-you-seat-drift` | a drifted person producing no row; a row per fact instead of per person; an HR id printed where a name belongs; one side of the comparison dropped; a clean view answered with anything but a true zero; the gate, the light lane or the registry line lost; the read widened to people with no seat |

**A fixture has to be able to reach the limit it tests.** The budget assertion first used a 12-item
board, which renders 889 characters when broken — *under* the 900 ceiling — so it passed with and
without the fix and proved nothing. The board saturates at 20, where the same break gives 1053.
