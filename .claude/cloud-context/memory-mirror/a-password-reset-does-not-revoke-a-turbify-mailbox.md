---
name: a-password-reset-does-not-revoke-a-turbify-mailbox
description: "Resetting a leaver's Turbify password does NOT cut their mail access — Yahoo app passwords survive a password change and must be deleted separately, so every phone and Outlook client they configured stays connected and the control panel shows nothing wrong. Both steps are required: reset AND delete the app passwords, or delete/suspend the mailbox. Phoenix can only TRACK this (Turbify has no provisioning API); the register rows are ATTESTATIONS, not observations — so never reopen a row to beat a guard (it destroys the attestation date), and a leaver with a blank work_email is invisible to the whole register."
metadata:
  node_type: memory
  type: project
  originSessionId: 40984f77-33d2-45f9-94fe-bf7b1b13be9d
  modified: 2026-09-26T00:39:27.143Z
---

**A password reset is not a revocation.** Yahoo's own docs say third-party app passwords stay active
after the account password changes — they must be deleted explicitly. Turbify Business Email runs on
Yahoo, so this applies to every company mailbox: a reset locks the *web* mailbox and nothing else, and
every phone/Outlook/mail client the leaver configured used an app password that keeps sending and
receiving. **The control panel shows nothing wrong** — no screen lists live app passwords, and Turbify
publishes no API to ask. **Both steps are required to actually shut a mailbox: reset the password AND
delete the app passwords, or delete/suspend the mailbox outright.** Forwarding and "retained" leave it
fully alive. **Never tell the owner, or write in a UI, that a password reset closes a leaver's mail
access** — the failure is silent and reassuring, worse than doing nothing because it produces a false
belief. Turbify publishes **no email/provisioning API** (only the Merchant Solutions store/order API), so
mailbox creation and closure cannot be automated, only tracked. See
[[turbify-cannot-issue-app-passwords-centrally-owner-stays]] and
[[mailbox-monitor-app-password-entry-is-three-underscores-never-phoenix]].

## The register is an ATTESTATION system

Phoenix records offboarding in `public.mailbox_offboarding_tasks`. Status is computed in plpgsql
(`phx_mailbox_offboarding_refresh_status`) precisely so **no page can call a reset-only mailbox
`revoked`** (pinned by `tests/mailbox-offboarding.test.ts`). A row is an **attestation** — a named admin
says they did a step at a recorded time — **never an observation, because Phoenix cannot see Turbify.**

- 🔴 **A leaver with a blank `work_email` is INVISIBLE to the whole register.**
  `phx_mailbox_offboarding_open` returns null (creating/raising/logging nothing) when `work_email` is
  blank, and `loadAwaitingLeavers` also filters `.not("work_email","is",null)` — invisible from both
  directions. **Audit by joining `employees` to `mailbox_offboarding_tasks` on `lower(hr_id)`, never by
  reading the register alone** — it cannot report the people it never admitted. `LEAVER_STATUSES =
  ["resigned","terminated"]`, no date window. Fixing the email is the whole fix — the daily
  `phoenix-mailbox-offboarding-sweep` cron (~08:15 Cairo) picks up anyone newly eligible; no hand-inserted
  row needed.
- **A blank `work_email` is not always missing data — sometimes no mailbox was ever issued** (owner
  confirmed **Yasmin Nasr, OF-0003**, never had one — do not "fix" it or open a task; short Head-office
  tenures are the case to ask about). Such a not-applicable verdict is recorded in `audit_logs`
  entity_type **`mailbox_offboarding_not_applicable`** — because the register physically can't hold the
  person (`work_email not null check position('@' in work_email) > 1`), so a gap analysis re-raises them
  as missing data every time. **Query that entity_type before asking the owner about any blank
  `work_email`.**
- **Sourcing a rep's work address:** the CRM agents grid holds it in `cells[7]` (unparsed by
  `parseAgentGrid`), and the HR-id prefix corroborates the line (`AI-` Anti-Infective, `PD-` Pedia).
  Office staff (`OF-`) are not in the CRM. **Never pattern-guess an address** — the house format is
  `firstname.lastname@satopharma.com` but both `yasmin` and `yasmine` spellings are live, and a wrong
  address means a failed revocation or resetting a *different* employee's mailbox.

## Don't re-raise a genuine bulk recording

A bulk-shaped timestamp cluster (dozens of mailboxes stamped `revoked` seconds apart) is **NOT** evidence
of an unbacked attestation — the register is an attestation system and `recordMailboxOffboardingStepsBulk`
exists precisely so the control-panel work and the recording can be separated in time (the owner does the
Turbify work first, then bulk-records). **Query `audit_logs` entity_type
`mailbox_offboarding_attestation_confirmed` before questioning a batch** — asking the owner to justify
recording speed reads as an accusation, and he has answered this one.

## Disposition ordering, and the NEVER-`reopen`-to-beat-a-guard rule

`phx_mailbox_offboarding_record` raises `P0001 already recorded as revoked` for any step except `reopen`
once `status='revoked'` — and recording steps 1 & 2 IS what makes a row revoked. So the "what happened to
the mailbox" disposition (`retained`/`forwarding`) can only be recorded on a row NOT revoked by its own
disposition. Since 2026-09-03 the freeze exempts a disposition on a row revoked by BOTH timestamps (it
can't change the status), so **step 3 is recordable through the normal path — do not hand-write a
disposition.** A row revoked BY its disposition (`deleted`/`suspended`, a step missing) is still refused;
that correction goes through `reopen`.

🔴 **When a guard blocks a legitimate record, do NOT `reopen` to get past it.** `reopen` NULLs
`password_reset_at/by` and `app_passwords_cleared_at/by`, so re-recording re-stamps them with today and
with you — destroying a genuine earlier reset attestation date. **Falsifying an attestation date to
satisfy a guard is worse than the guard.** Where the RPC can't yet take a value, write it with a **direct
single-row UPDATE mirroring the function's own branch, then call the domain's status function and let IT
return the verdict** (it stays `revoked` — revocation is earned by the two timestamps and `retained` is
neutral). And **when calling an RPC by hand, write the audit row only AFTER the change succeeds** —
`recordMailboxOffboardingStep` writes it first by design (it captures old values), but by hand that leaves
an orphan audit row describing a change the guard then refused.
