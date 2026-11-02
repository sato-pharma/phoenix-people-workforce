# A button's answer never waits for the notices it raises

The account behind the rule of the same name in `.claude/rules/notifications.md` (owner report,
2026-10-23: *"in every approve or reject in any module … when I press it, it is stale, very long …
and not only approve and reject, mainly 90% of buttons"*).

## What was measured

Sentry's spans dataset on production, seven days, the POST routes behind the buttons (p50 unless
noted):

| Button | Before |
| --- | --- |
| Vacation decision | 6.1 s |
| Excuse decision | 8.0 s |
| Direct-order decision | 7.8 s (95th percentile 22.3 s) |
| Marketing-request decision | 10.7 s |
| Outstation submit | 14.8 s |
| Admin users setup link | 14.5 s |
| Telegram connect | 13.5 s |
| Business-card requests | 9.8 s |
| Milestones card | 8.2 s |
| Employees POST | 7.2 s |
| **Phoenix CRM `list/requests/decide`** (the contrast) | **0.375 s** |

The CRM decide is the same kind of button on the same database. The difference is one line: its
notices go through `afterResponse` (`src/lib/http/after-response.ts`), which runs them after the
reply has left.

## Where the seconds went

The one vacation decision read span by span: the decision itself — rate limit, request read, the
approval-step write, the status update, the timeline row — was finished at **0.8 s**. The other
**5.3 s (87%)** were the notices to HR and the next approver, awaited before the answer: profile and
preference reads, `notification_events` / `notification_deliveries` / audit rows, the Telegram
message, the phone push, the templated email, the employee-directory reload — each recipient one
wave after the last. The direct-order decision shows the same shape (core finished at 0.84 s).

It is **not** the database: `api_rate_limit_consume` averages 1.8 ms and an audit insert 2.5 ms in
`pg_stat_statements`, and the Railway container reaches Supabase in 20–40 ms a request when warm.
The approval LIST pages are fast (p50 about 100 ms) — the slow part is only the button's POST.

## The rule

In an interactive handler (a button's POST) **every call that raises a notice runs inside
`afterResponse(label, task)`**. The saved decision is what the person waited for; the notice is
what follows it.

- `afterResponse` uses Next's `after()` inside a request and **awaits inline outside one**, so the
  unit suite and scripts keep their old behaviour. It logs and swallows a failing task.
- A task that used to record `notification_failed` on the request's timeline keeps doing so **inside**
  the task (the vacation module's `deferVacationNotice`).
- Capture what the task needs in `const`s before it. A `let` that is reassigned after the call site
  would be read late.
- **Cron and loop notice code is NOT deferred** — `expireStaleHeldDirectOrders`, the reminder
  sweeps, `runMarketingSlaDaily` and the backfill loops have no reply to be late for, and
  `sendHeldDirectOrderNotices` IS the send. Deferring them would let a loop finish before its
  sends did.
- A caller that needs the notice's result (a returned delivery id, a `notified` flag, a stamp the
  return value reads) is not deferred.
- A batch (`bulkDecideEmployeePlans`) queues every plan's notices and sends them one after another
  after the reply, never all at once.

## What moved after the reply

| Module | Buttons |
| --- | --- |
| Vacations | decision (HR hand-off and the next approver), both the sequential and the legacy path |
| Excuses | submit (to the manager) and decision |
| Direct orders | submit, held submit, revise, reverse, decide, cancel held, conversation message, Held Desk release, close orphaned, repair rung |
| Marketing requests | submit, resubmit, decide (reject, return, assign, approve), advisory comment, conversation message |
| Weekly and monthly plans | submit, every decision, comment, HR acknowledgement, visit details, reassign, cancel, edit request and its decision, batch approve |
| Outstation and expenses | submit (with the departure-photo reminder), simple expense, admin-created, payroll override, admin reject |
| People | add employee (CRM account setup and mailbox tasks), resignation submit and workflow, probation create and workflow, contract renewal create and workflow |
| Recruitment | interview request create and schedule, interview create, reschedule, feedback |
| Other | business-card request, private-calendar dispute submit and decision, Telegram connection linked |

## Behaviour that changed on purpose

- A notice that fails used to reject the request AFTER the decision had already been saved, so the
  screen showed an error (a false 500) over a saved decision. It is now logged
  (`after_response_failed`) and the screen shows the decision.
- **Marketing submit:** a throw while building a notice used to fall into the `catch` that deletes
  the new request, so a saved, already-routed request could be deleted because an email failed. It
  can no longer.
- **Business-card request:** `notification.errored` is always `false` after the hand-off; zero
  recipients is still reported. Nothing in the UI reads `errored`.
- **Held Desk release:** a failed notice no longer marks a moved order as "could not be revived".
- **Outstation no-hold submit:** the payroll release now runs before the notice, not after it.

## How it is pinned

`tests/notices-after-the-reply.test.ts` parses each service file with the TypeScript compiler and
requires every notice call in each listed function to sit inside `afterResponse(...)` or
`deferVacationNotice(...)`. Each pin is handed a broken copy and must fire, and a pin that finds
no call to check fails instead of passing.

## Not changed, and why

- **Left awaited because the notice IS the answer or its result is used:** the admin users setup
  link (the email is the feature and feeds the audit row), recruitment ask-again, rejection message
  and send-to-manager, `createApplication` (the notice writes the `manager_notified` stamp its
  return value reads), `reopenRejectedMarketingRequest` (returns `notified`).
- **Slow, but not a notice:** Telegram connect (`getMe` plus a write), the milestones card
  (Chromium render), interview-calendar bookings (Zoom, CV and candidate resolve). Each needs its
  own fix.
- **Phoenix CRM decide** (4.8 s at the median) already defers every notice, and its database work
  is small (the transition RPC averages 18 ms). The remaining time is the deferred notice itself
  starting 0.6 to 5.3 s after the commit; whether Sentry counts `after()` work inside the request
  or something holds the reply is NOT established. Time one real decide with `curl`'s
  `time_total` against its Sentry trace before changing anything there.

- **Polling load.** `/api/approvals/badge-counts` (p50 1.06 s over 22 thousand calls),
  `/api/notifications/in-app` (p50 0.6 s over 43 thousand) and `/api/activity/track` (32 thousand
  calls) are the page's background traffic, not the button.
- **The Direct Orders sheet ping** (`pingDirectOrderSheet`) times out at 4,000 ms on every call. It
  is fire-and-forget, so it does not hold the answer. The sheet endpoint is not dead: measured on
  2 Nov 2026, every ping reached it, and it answers only after its redraw
  (`docs/share-link-management.md`, "A sheet ping that times out was delivered").
- **The client.** `decision-actions.tsx` calls `router.push(backHref); router.refresh()` on
  success and leaves the button on "Submitting…" until the navigation lands. Not changed: it cannot
  be judged without running the app against the new server timings.
