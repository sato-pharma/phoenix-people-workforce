# The employee portal's deductions ledger

The account behind the module rule in `.claude/rules/payroll.md` ("THE EMPLOYEE PORTAL'S DEDUCTIONS
PAGE SHOWS EVERY DEDUCTION RAISED AGAINST HIM FROM THE SEPTEMBER 2026 SALARY ON"). The rule is the
cue; this file is the evidence.

## What the owner asked for, 2026-10-09

In his own words: *"in deductions in emp portal starting from september salary show all deductions
should be applied on him and howa hr responded to every single row and emoployee can filter by
another month or period or type or status"*.

Two business facts were put to him as multiple choice the same day, because guessing either would
have changed what an employee sees about his own money:

| Question | His answer |
| --- | --- |
| Rows HR has not decided yet | **Show them, marked "Under review"** |
| Should the page also carry dispute threads for rows not on a payslip | **No — payslip rows only** |

## What changed, and why it is not the old read

Before this change the page listed **released publication lines** — `getPortalDeductions`. That read
answers "what was released to you", which is a strictly smaller set than "what was raised against
you": a candidate HR has not decided, or has decided and not published, appears nowhere in it.

`getPortalDeductionLedger` (`src/lib/deductions/portal.ts`) starts from `deductions_candidates`
instead — live rows only (`superseded_at IS NULL`), `month_key >= PORTAL_DEDUCTIONS_FIRST_MONTH`
(`'2026-09'`) — and treats the publication line as one more fact on the row rather than as the
gate. The September floor is applied **twice**: in the PostgREST query and again in JS, so a widened
query cannot surface an earlier month.

`getPortalDeductions` is deliberately kept. It is still the released-lines read and is still pinned
by its own tests; deleting it would have been unrequested churn on money-adjacent code.

## The outcome is derived from the DECISION, never the publication

`derivePortalDeductionOutcome` maps the decision status, because **Automated Payroll charges the
decision** — the push/publish gate was retired on 2026-10-07, so a publication no longer tells you
whether money moved.

| Decision status | Outcome | What the employee reads |
| --- | --- | --- |
| `Approved for Payroll` | `on_payslip` | Deducted from salary |
| `Do Not Take Action` | `cleared` | Cleared — nothing deducted |
| `Needs Follow-up` | `needs_follow_up` | HR needs more information |
| `Disputed` | `disputed` | Disputed |
| anything else, including `Pending` and an unknown string | `under_review` | Under review |

🔴 **An unknown status falls back to `under_review`, never to `cleared`.** Falling back to cleared
would tell an employee nothing was taken on a row that may yet be charged. One of the four
regression assertions broken to prove the test works was exactly this: an unknown status read as
`cleared` (`actual: 'cleared', expected: 'under_review'`).

Only an `on_payslip` row carries a charged value or amount; every other outcome charges zero, so the
page can never show a cleared row as money taken. (Second broken assertion: a cleared row still
charging — `actual: 900, expected: 0`.)

**67 undecided `crm_half_day` rows across 26 people** were in the September data when this shipped.
That measurement is why the question about undecided rows was worth asking rather than assuming:
hiding them would have hidden the majority of what the module had raised that month.

## Replies stay limited to a released row

`canComment` is `Boolean(releasedLine)`. That is `addDeductionsComment`'s own server-side gate, not a
second rule invented for the screen, and it follows his ruling that a dispute is for money actually
taken. An open row says so in words ("You can reply to HR on this one once it is released…"); a
manager reading someone else's row sees "Manager view is read-only."

## Filters

Month, type and status. They are **pure functions** in `src/lib/deductions/portal-ledger-filters.ts`
and run in the browser, so the client component never imports `portal.ts` — which pulls in the
Supabase admin client and must not reach a client bundle. The page therefore takes no `searchParams`
any more; both the portal page and `WorkspaceDeductionsPage` read the ledger and narrow in the
browser.

## Visibility

Self-only for every non-system role, through the one resolver `collectPortalDeductionScope`, and
re-asserted in JS per row (`scope.all || scope.compactHrIds.has(…)`). `employee_hr_id_compact` is
lowercase.

## Proof

`tests/deductions-portal-ledger.test.ts`, registered in `tests/run-tests.ts`. Four assertions were
broken one at a time and each fired before the files were restored:

1. an unknown status reading as `cleared`;
2. a cleared row still charging a value;
3. the JS September floor removed;
4. the HR-response block dropped from the screen.
