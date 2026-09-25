---
name: marketing-reject-terminalises-applied-to-prod-2026-08-13
description: "The marketing reject-terminalises migration is LIVE in production since 2026-08-13 — do not redo or undo it; a reject now closes out later rungs and preserves returned_at."
metadata: 
  node_type: memory
  type: project
  originSessionId: 4d615aae-6dc5-4362-b4f4-d602d9620a11
  modified: 2026-08-13T04:08:13.133Z
---

`20260813190000_marketing_reject_terminalises_chain.sql` was applied to **production**
(`ozucdzovmcqvepbozvqf`) on 2026-08-13 with the owner's explicit approval. **Do not re-apply it and
do not revert it.**

What changed in `phx_decide_marketing_request_step`:

- a **reject** now marks every still-`pending`, non-CC rung `skipped` in the same transaction, and
  returns the count as `terminalised` in its jsonb result
- a reject no longer NULLs `returned_at` / `returned_step_sequence` (was `ELSE NULL`, now
  `ELSE <themselves>`), so a request that was returned, resubmitted and then refused keeps the
  evidence of the return
- a **return** is deliberately untouched — its later rungs must stay `pending` or
  `resubmitReturnedMarketingRequest` cannot walk them
- the self-approval guard from #2087 is carried forward in the same body

Backfill: exactly **4 rows** on `MKT-REQ-20260811-FF5B0719` (sequences 2–5: SFE Validation,
Marketing Review, CEO Approval, Finance Execution) went `pending → skipped`. Controls held — 5
decided rungs untouched, 9 total rows unchanged, 0 pending non-CC rows on any non-rejected request.

Verified from `pg_proc`, not the migration ledger. Production and staging bodies are byte-identical:
`md5 = f6926cb1be1f5c16d3ded3282306c4a1`, 5811 bytes.

**Side effect worth knowing:** the backfill's status change fired the
[[marketing-request-events-is-the-history-table]] trigger, so production gained **4 append-only
`step_decided` events with `to_status='skipped'` dated 2026-08-13**, not the 11 Aug refusal date
(the backfill sets `updated_at = now()` and the trigger derives `occurred_at` from it). They cannot
be edited or deleted. Their `actor_hr_id` falls back to the rung's **assignee**, because a
terminalised rung has no decider — so any timeline must NOT render them as "<assignee> skipped
this"; the Case File reads them as "Closed out without a decision".

`skipped` on an approval step now means **three** different things: a CC row, a rung the requester
was assigned to ([[marketing-approver-hrid-casing-fk]] era self-approval fix, #2087), and a rung a
refusal closed out. Tell them apart by `is_cc` and the presence of a `decision_note`.

The application code that reads `terminalised` and renders this ships in
[[railway-merge-is-the-production-deploy|PR #2089]], which is NOT merged — the database is ahead of
the app on purpose, and safely so: the extra jsonb key is ignored by the currently deployed service.
