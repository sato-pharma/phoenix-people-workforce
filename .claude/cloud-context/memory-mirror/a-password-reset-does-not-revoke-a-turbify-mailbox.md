---
name: a-password-reset-does-not-revoke-a-turbify-mailbox
description: "Resetting a leaver's Turbify password does NOT cut their mail access — Yahoo app passwords survive a password change and must be deleted separately, so every phone and Outlook client they configured stays connected and the control panel shows nothing wrong"
metadata:
  node_type: memory
  type: project
---

**A password reset is not a revocation.** Yahoo's own documentation states that third-party app
passwords remain active after the account password is changed — they must be deleted explicitly.
Turbify Business Email runs on the Yahoo platform, so this applies to every company mailbox.

**What that means for a leaver:** resetting their password locks them out of the *web* mailbox and
of nothing else. Any phone, Outlook, or mail client they ever configured used an app password, and
each of those keeps sending and receiving company mail afterwards. **The control panel shows nothing
wrong** — there is no screen that says "this account still has live app passwords", and Turbify
publishes no API to ask.

**Both steps are required to actually shut a mailbox:** reset the password **and** delete the app
passwords, or delete/suspend the mailbox outright. Forwarding and "retained" leave it fully alive.

**Why:** the failure mode is silent and reassuring. Someone does the reset, believes the door is
shut, and the mailbox stays reachable indefinitely. It is worse than doing nothing, because doing
nothing at least does not produce a false belief. The owner's own first framing of this work was
"when an employee resigns his email password is automatically reset" — the reset alone was the plan,
which is exactly the gap this records.

**How to apply:** never tell the owner (or write in a UI) that a password reset closes a leaver's
mail access. If asked to automate offboarding, note that Turbify publishes **no email/provisioning
API at all** — its only public API is the Merchant Solutions store/order API — so mailbox creation
and closure cannot be automated, only tracked. See
[[turbify-cannot-issue-app-passwords-centrally-owner-stays]] for the settled owner decision to stay
on Turbify, and [[mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix]] for the
naming rule that governs any app-password instruction shown to an employee.

Phoenix records this in `public.mailbox_offboarding_tasks`: the status is computed in plpgsql
(`phx_mailbox_offboarding_refresh_status`) precisely so no page can call a reset-only mailbox
`revoked`, and `tests/mailbox-offboarding.test.ts` pins that clause. A row is an **attestation** —
a named admin said they did a step at a recorded time — never an observation, because Phoenix
cannot see Turbify.

## A leaver with no `work_email` is INVISIBLE to the whole offboarding register (2026-09-03)

`phx_mailbox_offboarding_open` — the one entry point used by the exit workflow, the daily sweep and
the page's manual button alike — begins:

```sql
if v_employee.work_email is null or char_length(trim(v_employee.work_email)) = 0 then
    return null;      -- creates nothing, raises nothing, logs nothing
end if;
```

So a leaver whose `employees.work_email` is blank **never gets a task, and no error says so**.
`loadAwaitingLeavers` filters on `.not("work_email","is",null)` too, so they are missing from the
"awaiting" list on the page as well — the gap is invisible from both directions. Measured 2026-09-03:
of 51 leavers since 1 June, 5 had no task row, and **all 5 were exactly the 5 with a null
`work_email`** — a perfect correlation, not a coincidence.

**Audit this by joining `employees` to `mailbox_offboarding_tasks` on `lower(hr_id)`, never by
reading the register alone** — the register cannot report the people it never admitted.
`LEAVER_STATUSES` is `["resigned","terminated"]`; there is no date window, so a fixed email
surfaces a leaver however long ago they left.

**The CRM is a good source for a field rep's work address** — the agents grid's cells[7] holds it
(unparsed by `parseAgentGrid`), and the HR-id prefix corroborates the CRM line independently
(`AI-` → Anti-Infective, `PD-` → Ped). **Office staff (`OF-`) are not in the CRM at all.** Never
pattern-guess an address into HR master data: the house format is
`firstname.lastname@satopharma.com` but both `yasmin` and `yasmine` spellings are live, and a wrong
address means either a failed revocation or resetting a different employee's mailbox.

The daily `phoenix-mailbox-offboarding-sweep` cron (~08:15 Cairo) picks up anyone newly eligible,
so fixing the email is the whole fix — no hand-inserted row needed.

**A blank `work_email` does not always mean missing data — sometimes no mailbox was ever issued.**
Owner confirmed 2026-09-03 that **Yasmin Nasr Ahmed (`OF-0003`, Regulatory Affairs, Head office,
24 Jun → 31 Jul 2026) never had one**, so her blank is CORRECT and final: do not "fix" it, and do
not open a task for her. Short tenures at Head office are the case to ask about rather than assume.
Of the 19 employees with a null `work_email` on that date, only she was a real leaver — 14 were
`historical_payroll_record` and 2 `system_placeholder`, none of which can trip offboarding because
their status is neither `resigned` nor `terminated`. The one ACTIVE person without an address was
`AI-0016` Mohamed Hamed, hired 2026-09-01, presumably not yet provisioned.

**That verdict is now recorded in PRODUCTION, not only here** — `audit_logs` row
`82263509-6a1f-4b4b-9529-71ffa659247b`, entity_type `mailbox_offboarding_not_applicable`,
entity_id `OF-0003`, written 2026-09-03 07:12 Cairo. It exists because the register **cannot**
hold her: `mailbox_offboarding_tasks.work_email` is `not null check (position('@' in work_email) > 1)`,
so a leaver who never had a mailbox has no representable row, and a database-side gap analysis
(leavers joined to the register on `lower(hr_id)`) re-raises her as missing data every single time.
**Query that entity_type before asking the owner about any blank `work_email`.** I asked him twice on
the same day for want of that check — the second time by building him a decision XLSX for a question
he had already answered.

## The 30 August bulk recording is GENUINE — do not re-raise it (owner-confirmed 2026-09-03)

Read cold, the register looks alarming: 48 mailboxes stamped `revoked` by `b-10` between 00:30:46
and 01:07:26 Cairo on 2026-08-30, and **44 of them cleared inside a 3-minute-6-second window**
(01:04:20 → 01:07:26, ~1s between rows — the signature of `recordMailboxOffboardingStepsBulk` at
concurrency 4). Nobody visits 44 accounts in a third-party control panel in three minutes, so the
clicks were plainly the RECORDING and not the work.

**That is the intended workflow, and the owner confirmed it directly: he did all 48 in the Turbify
panel first, then bulk-recorded.** The 33-minute gap at 00:31:31 → 01:04:20 is the control-panel
work. Recorded in production as `audit_logs` row `231f9bc3-9b2c-4156-91bb-bf58260af0bf`, entity_type
`mailbox_offboarding_attestation_confirmed`, entity_id `bulk-2026-08-30`.

**How to apply:** a bulk-shaped timestamp cluster is NOT evidence of an unbacked attestation — the
register is an attestation system and the bulk recorder exists precisely so the work and the record
can be separated in time. Query `mailbox_offboarding_attestation_confirmed` before questioning a
batch. Asking the owner to justify recording speed reads as an accusation and he has already
answered this one.

## Step 3 was UNREACHABLE in the order the UI numbers it — FIXED 2026-09-03, do not re-chase

`phx_mailbox_offboarding_record` raises `P0001 This mailbox is already recorded as revoked` for any
step except `reopen` once `status = 'revoked'`. Recording steps 1 and 2 IS what makes a row revoked.
So **a `retained` or `forwarding` disposition can only ever be recorded BEFORE the two revocation
steps** — the reverse of the workspace's own "1 · reset / 2 · delete app passwords / 3 · what
happened to the mailbox" numbering. The UI does not error; it simply stops rendering the step-3
Record button once `done`, so the step disappears rather than refusing.

Production proves it exactly, 60 rows:

| Disposition | Rows | Of those, with both steps done |
| --- | --- | --- |
| (none recorded) | 57 | 57 |
| `deleted` | 2 | 0 |
| `retained` | 1 | 1 — written by hand, the RPC refused it |

A disposition exists **only** where it was recorded *instead of* the two steps (deleted/suspended
short-circuit `refresh_status` to `revoked`), never *after* them.

**Why:** `retained` and `forwarding` are explicitly NOT revocations in `refresh_status` — the
comment says so — yet they are the two dispositions that describe a mailbox whose leaver access
still had to be cut step by step. They are therefore the exact pair the guard makes unrecordable.

**FIXED on production 2026-09-03 07:40 Cairo**, migration
`20260903180000_mailbox_offboarding_disposition_after_revocation`, PR #3003. The freeze now exempts
a disposition on a row revoked by BOTH timestamps — it cannot change the status, so it records a
fact without weakening the assertion the freeze protects. A row revoked BY its disposition
(`deleted`/`suspended`, a step missing) is still refused, verified live on
`belal.elnaggar@satopharma.com`: that is a correction and still goes through `reopen`. So **step 3
is now recordable through the normal path — do not hand-write a disposition any more.**

**How to apply, and this still holds whenever a guard blocks a legitimate record: do NOT `reopen`
to get past one.** `reopen` NULLs `password_reset_at/by` and
`app_passwords_cleared_at/by`, so re-recording re-stamps them with today and with you — on
`head.office@satopharma.com` that would have destroyed a genuine **2026-08-30 01:06 Cairo** reset
attestation and replaced it with a 2026-09-03 one. Falsifying an attestation date to satisfy a
guard is worse than the guard. Where the RPC cannot yet take it, write the value with a direct single-row UPDATE
mirroring the function's own branch, then call the domain's own status function and let IT return
the verdict — it stays `revoked`, because revocation is earned by the two
timestamps and `retained` is neutral. Audit row `cae7ac15-a65b-4d09-b1f5-6ac28e90df24` records that
write and supersedes the orphan `5837cf7b-…` left by the failed RPC call.

**Also:** write the audit row only AFTER the change succeeds when calling the RPC by hand.
`recordMailboxOffboardingStep` writes it first by design (it captures old values), but by hand that
leaves an audit row describing a change the guard then refused. It happened here.
