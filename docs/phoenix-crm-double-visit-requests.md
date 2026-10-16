# Phoenix CRM — the rep's request for a double visit

Owner, 2026-10-16: *"the last question while rep logging a visit to an am or pm account must be: do you
need a double visit with this dr/account? If yes show him manager and rsm if applicable and nsm and pm
and gpm if applicable, and then make him able to choose up to 3 timings, make him then able to edit the
timing but never cancel his request. After that a new sidebar report is generated for managers which
pumps notifications when they receive this request, and all managers must have access on this report as
per their scope up to the CEO."*

His answers to the three questions put to him the same day:

| Question | Answer |
| --- | --- |
| Who may be asked | Any number of the people offered, ticked by the rep |
| What a timing is | A day only — up to three field days, no clock time |
| What a person asked does | Accepts ONE of the days, or declines |

## What the rep sees

- **The question** is the last block of Add visit, after the comment, and unnumbered so no step number moved.
  It is asked of the rep's own visit to an AM or PM customer only (never a pharmacy, never a manager's entry).
  It starts on **No**, and a rep who leaves it there is asked nothing more and sends nothing.
- On **Yes** he ticks from the same list the older visit ask offers — his territory's managers up the chain and
  his own line's product managers — and picks up to three days (today and every field day of the next four
  weeks; never a Friday, never a confirmed public holiday).
- The saved visit says who was asked. The customer's page then lists every request with one line per person:
  *Waiting*, *Accepted, <day>* or *Declined*.
- He may **change the days** (still up to three). He may **never cancel**: there is no cancel route, no
  database function, no button and no notice step, and a test pins each absence.

## What an edit does

| Person's state when the days change | After the edit |
| --- | --- |
| Waiting | Waiting, and told again that the days changed |
| Accepted a day that is still offered | Stays accepted |
| Accepted a day that was dropped | Back to waiting, and told again |
| Declined | Stays declined |

## Who is told, and who reads

- Each person asked is told on his own when the request is raised and whenever the days change; the rep is
  told which person accepted or declined. In-app, Telegram and phone — **never email** (Phoenix CRM sends none).
  Keys: `<request>:<person>:raised`, `<request>:<person>:days:<version>`, and the answer is keyed on the person
  and what he answered, so a changed mind is a second notice.
- A person asked answers on the report; the Super Admin reads every territory and answers nothing real.
- **The report** is `/employee-portals/double-visit-requests` (every manager and product manager) and
  `/admin/phoenix-crm/double-visit-requests` (the Super Admin, the CEO and the SFE Manager, whose navigation is
  the admin shell). The one gate is `doubleVisitReportAudience` in `server/access.ts`: Super Admin, CEO and SFE
  read everything; a manager reads his scope downward; a Product Manager, Group Product Manager and the Marketing
  Manager read what is addressed to them; a rep reads his own on the customer's page and nothing else.

## Where it lives

| Piece | File |
| --- | --- |
| Rules, no I/O | `src/lib/phoenix-crm/double-visit-request-rules.ts` |
| Service | `src/lib/phoenix-crm/server/double-visit-requests.ts` |
| Tables and the three functions | `supabase/migrations/20261016133000_phoenix_crm_double_visit_requests.sql` |
| Notices | `server/notifications.ts` (`double_visit_request`), `src/lib/notifications/policy.ts` |
| Routes | `app/api/phoenix-crm/double-visit-requests/{,edit,answer,report}` |
| Last question | `src/components/phoenix-crm/double-visit-question.tsx`, `visit-log-form.tsx` |
| Customer page and report | `src/components/phoenix-crm/double-visit-requests.tsx` |
| Sidebar | `employee-portal-layout.tsx`, `employee-portal-nav-registry.ts`, `navigation.ts`, `server/page.ts` |
| Test | `tests/phoenix-crm-double-visit-requests.test.ts` |

The migration was applied to staging and production through `scripts/apply-sql-file.mjs` (the standing route when
the MCP refuses), so it writes no ledger row and has an evidenced `ACKNOWLEDGED_EXCEPTIONS` entry.

This is a separate subsystem from `visit-asks` (one person, can be taken back) and from the district manager's
own double-visit plan; neither was touched.
