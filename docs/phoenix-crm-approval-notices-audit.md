# The 2026-10-02 Phoenix CRM approval-notice audit

The account behind four hooks in `.claude/rules/phoenix-crm.md`. Written the day before **Delta (1)**
went live — Saturday 3 October 2026 — because every visit by a rep whose week was not sent is
off-plan, so the SFE approval queue starts filling on the first morning.

**None of the six findings had misreported anything yet.** Measured on production (`ozucdzovmcqvepbozvqf`)
on 2026-10-02: 13 `phoenix_crm_plans` rows, 12 `phoenix_crm_day_activities` rows, **0 visits**, 0
waiting off-plan visits, 1 waiting plan-edit request (week of 3 October, not yet past its week), and
the one active SFE Manager (A-2) with `employment_status = 'active'`. Each would have misreported
within days. That is the whole reason they were fixed before the launch rather than after it.

Shipped in one PR with migration `20261002220047_phoenix_crm_activity_and_plan_edit_expiry.sql`.

## 1 · An approval nobody is told about is an approval nobody gives

### (a) Every sum of `waitingForYou` must take every count in it

`overview.waitingForYou` carried `plans`, `requests`, `planEdits`, `visitAsks` and
`hrAcknowledgements`, and **no off-plan count at all**. Three places summed it and so left out the
one item that counts in nothing until it is decided:

- the module chooser's Team card (`module-chooser.tsx`);
- the tab bar's number (`phoenix-crm-app.tsx`, `waitingCount`);
- the choice of which tab the page OPENS on (`openingTab`, `decisions`) — so a manager whose only
  waiting item was an off-plan visit landed on whichever tab he happened to be given first.

Meanwhile `teamWaitingLine`, INSIDE the Team tab, named off-plan visits correctly from
`summary.unplannedWaitingForYou`. So the module disagreed with itself: the badge said nothing waited
and the sentence one screen in said one did.

The durable rule is about the object, not this count: **a new count added to `waitingForYou` is added
to every sum of it.** `tests/phoenix-crm-approval-notices.test.ts` asserts the count appears in all
three, and that `phoenix-crm-app.tsx` reads it exactly twice (the two sums answer different
questions — which tab to open, and what number to draw).

The count is taken at the viewer's OWN step, which is exactly what `canDecideUnplannedVisit` allows:
`manager_pending` on the territories he reviews, `sfe_pending` across the SFE Manager's scope, the
Super Admin's test count holding both. Reading a wider set would badge a manager for a decision he
cannot take. There is deliberately **no week filter**, unlike `countPlanEdits`: a waiting off-plan
visit does not expire with its week — the visit happened, and it counts in nothing until somebody
decides it, however late that is.

### (b) The SFE step is a role read from the accounts, never "no hr id here to address"

`unplanned_visit_raised` carried this comment:

> A territory whose chain is vacant starts at the SFE stage, and the SFE Manager is a ROLE with no
> seat in the organogram — there is no hr id here to address, so it goes unpushed and the Team tab's
> counter carries it.

That went stale on 2026-10-01, the day the five plan-edit notices began resolving the same role
through `sfeManagerHrIds()` → `resolveHrIdsForRole("SFE Manager", …)`. It left **two** silences:

1. **A visit that STARTS at SFE**, because the territory's manager chain is vacant
   (`unplannedFirstStatus(reviewer !== null)` — the application resolves the first status and hands
   it to the database, so the branch can read the same `reviewer` to decide whom to tell). A vacant
   chain is precisely the territory nobody else is watching.
2. **A visit a district manager PASSED ON.** `unplanned_visit_decided` told only the rep, who read
   *"it counts once SFE approves it too"* — while SFE had never heard of the visit. The manager's own
   copy is withdrawn by the bell the moment the visit leaves his step, so after that nothing anywhere
   was asking anyone.

Both now send `unplanned_visit_waiting`. The idempotency key is **per visit per step**: the raised
branch writes `…:raised` where a reviewer exists and `…:sfe_pending` where none does, and the decided
branch writes that same `…:sfe_pending`. A visit therefore reaches the SFE step once in its life and
is announced once, whichever way it got there. The SFE copy is deliberately version-free, unlike the
rep's copy beside it (`…:v<n>:<status>`), so it cannot re-announce a visit he is already looking at.
It carries the rep's own written `clarification`, which is what SFE is being asked to judge — the
column was added to the decided notice's read for that reason alone.

A related trap this exposed: `tests/phoenix-crm-missed-records.test.ts` pinned that key as the
literal source text `` `${phoenixCrmVisitNoticeKeyPrefix(notice.visitId)}raised` ``, while its stated
intent was that the key's VALUE must not move. The value did not move. Pinning the spelling would
have forced the ternary back out and told SFE twice about the same visit, so the assertion now pins
the ternary and the SFE step's own key.

### (c) A role-addressed recipient is checked against the employee record

`resolveHrIdsForRole` filtered on `app_auth_users.is_active` alone. That column lags
`employees.employment_status` — a CSV termination or a contract non-renewal flips the employee record
and leaves the login active — so a departed role-holder kept receiving role-addressed notices, the
Phoenix CRM plan-edit emails among them. `resolveNotificationPersonRecipients`, one function below
it, had carried the employment filter all along.

The same filter now runs in `resolveHrIdsForRole`, with its fail-open direction intact: an account
with no employee row (a system or service login) is KEPT, and an unreadable `employees` read drops
nobody and adds a warning. An EMPTY answer is logged (`role_recipients_empty`), because every caller
addresses an office — "nobody holds this role" means a notice reached no one, which reads exactly
like a notice nobody sent.

Note the direction for the one caller that uses this as an EXCLUSION (the retention-risk CEO
exclusion): dropping a terminal employee from an exclusion list makes the exclusion do less, which is
the same fail-open direction that resolver was written for.

## 2 · A Phoenix CRM read that grows with the field is paged, or it lies at 1,000 rows

PostgREST stops at `max_rows = 1000` (`supabase/config.toml`) with **no error and no marker** — the
array just stops. Two reads were sized for the pilot, and both failed toward SILENCE:

- **`seatsWithRealActivity`** (`server/daily-digest.ts`) selected `seat_id` from six tables
  (`phoenix_crm_visits`, `_places`, `_plans`, `_monthly_plans`, `_day_activities`, `_list_requests`)
  and collected the distinct values. It is the gate that decides whether a territory joins **both**
  the 06:55 digest and the "your coming week is not sent" reminder (`server/plan-reminder.ts` reads
  it too). Past the cap a territory would simply drop out of both — and a territory missing from the
  digest looks exactly like a quiet morning, which is the one failure nobody investigates.
- **`loadUnplannedRows`** (`server/unplanned.ts`) is one small team for a district manager and the
  queue across EVERY territory in the company for the SFE Manager, whose step is the second one, so
  every visit the district managers approve arrives in it.

The fixes are different because the questions are different. The activity gate asks "does this seat
have ANY row", so it became `phoenix_crm_seats_with_activity(p jsonb)`: one `exists` per seat per
table, which stops at the first matching row, in one round trip, with `is_test = false` on all six
(a Super Admin's try-out — or a test login's, which carries the mirrored rep's own HR id — must never
switch a real manager's 06:55 message on). The caller still chunks at 200 seats so the ANSWER cannot
approach the cap either. The queue needs the rows themselves, so it is keyset-paged on `visit_id`,
the primary key — never `.range()` on an offset, across which a decision landing mid-read could shift
a row — and a SHORT page is the end while a full one is read again from its last key.

Sizing: at the ~600 visits a working day the module is built for, `phoenix_crm_visits` crosses 1,000
rows inside two field days of Delta (1).

## 3 · A status only a human decision can write is a status that never gets written

`status = 'expired'` on a request to edit a sent week was written in exactly one place: inside
`phoenix_crm_decide_plan_edit_request`, which runs only when somebody DECIDES a request. Nobody ever
decides one whose week is over, because by then it has dropped out of every queue —
`loadPlanEditRows` keeps `week_start >= today - 5`. So the row sat on `manager_pending` for ever, and
all three symptoms pointed away from the cause:

- its reviewer could not see it anywhere;
- the rep's own week panel still read "Your district manager decides first, then SFE, then HR";
- `plan_edit_expired` never went.

`phoenix_crm_expire_plan_edit_requests(p jsonb)` closes them daily, from the plan-reminder cron route
— outside `runPhoenixCrmPlanReminder`, which returns early on every day that is not a reminder day,
so the expiry could not live inside it. The pass writes nothing itself: it hands each stale row to
the decide function, whose expiry branch stays the only writer of that status.

🔴 **The SELECTION is made in SQL, in the same transaction, and that is the safety property.** The
decide function APPLIES the stage's decision whenever the week has NOT passed. A caller that chose
the rows itself — against its own clock, a day out across midnight — would therefore APPROVE a live
request as the system, or at the HR step REOPEN a week nobody asked to reopen. Selecting with the same
`now() at time zone 'Africa/Cairo'` the function reads (one transaction, one transaction timestamp)
makes the expiry branch the only branch reachable. `actor_hr_id` is the marker `SYSTEM`, never a
person: it reaches only the event row, which no screen resolves to a name, and the expiry branch
writes no `*_decided_by_hr_id` column at all.

**Proved on staging (`cifwmndunmlxjhyjugxa`) inside a rolled-back transaction**, against a real
submitted plan for the week of 2026-09-26:

| | |
| --- | --- |
| request | `manager_pending` → `expired`, `decided_at` set, version 1 → 2 |
| event | `expired`, actor `SYSTEM`, role `System`, stage `manager`, `manager_pending` → `expired` |
| **the plan** | **still `submitted`, still version 3 — not reopened** |
| second run | `stale: 0` |

### The owner's ruling on its notice

Asked directly in chat on 2026-10-02 whether the pass should send `plan_edit_expired` — at that point
one of the five Phoenix CRM notices he had put on email the day before — he chose **"in-app and
Telegram only, no email"**.

So the pass tells the rep and his managers (it was built silent, waiting on exactly that answer), and
`plan_edit_expired` left the emailing list: **four event types, not five**. The line the email
exception is actually drawn on turns out to be **a step a PERSON took** — the four that remain are a
district manager, SFE or HR pressing a button, while an expiry is a week running out, closed in a
batch by a cron, which is the unprompted bulk mail he has ruled out standing.

His "only" is enforced on both axes, exactly as his 2026-09-28 digest ruling is:
`plan_edit_expired` is in `PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES`, `phoenixCrmChannels` asks for just
the two at the call site, the policy row in `policy.ts` names the same two, the Telegram-failure
re-send is skipped for it, and the pass itself names no channel at all.

## 4 · "In-app and Telegram only" is a guard, not a call-site choice

`daily-digest.ts` asked for `["in_app", "telegram"]` and still reached the phone. When Telegram fails
PERMANENTLY — the expected case for an unlinked manager, and 0 of 74 reps had Telegram linked —
`system.ts` re-sends the same notice as `["email", "in_app", "push"]`. The module's email guard took
the email; nothing took the push, so the 06:55 digest arrived on the phone by the back door.

`enforcePhoenixCrmPushBlock` is now the channel chain's last line, keyed on module and event type,
chained after the email block rather than folded into it — the two cover disjoint sets, and
collapsing them would silently restore whichever one lost.

And the re-send is **skipped outright** for an in-app-and-Telegram-only notice, at all three sites
(the permanent-failure branch, the retryable branch, and the retry worker's exhaustion fallback):
both channels it would add are banned, so the only thing it could still deliver is a second copy of
the in-app notice the first send already made — a duplicate bell row every time Telegram fails, which
for an unlinked recipient is every time. Stripping the channels without stopping the re-send would
have fixed the leak and left the noise.

## What the migration added, and how it was verified

Two functions, no table, column, grant or row touched.

| | staging `cifwmndunmlxjhyjugxa` | production `ozucdzovmcqvepbozvqf` |
| --- | --- | --- |
| `pg_proc` | both present, `prosecdef = true` | both present, `prosecdef = true` |
| ACL | `postgres=X \| service_role=X` | `postgres=X \| service_role=X` |

On production the activity function answered 13 of 13 real plan seats, and `[]` for a seat that does
not exist — the same answer the old six-table read gave that day.

🔴 **The module's own boundary guard (`tests/phoenix-crm-boundary.test.ts`) caught a seventh defect in
review:** the migration was missing `notify pgrst, 'reload schema'`. Without it PostgREST answers
PGRST202 for a function it has not seen, and this repo's error reader files that as "the mirror is not
provisioned" and degrades to empty — so the digest and the reminder would have read every territory as
not started. Added to the file and applied to both environments.

## The questions left open, not to be built without his word

Raised by the audit and deliberately not built: whether the digest should go to district managers only
(today it also reaches regional and national managers), whether weekly plans waiting for approval
should be nudged, whether SFE should approve plans when a territory's whole manager chain is vacant,
and whether the reminder should follow the Super Admin's Start button (`phoenix_crm_team_starts`)
instead of "any real row".
