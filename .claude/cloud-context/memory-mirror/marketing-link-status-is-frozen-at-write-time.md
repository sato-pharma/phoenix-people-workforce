---
name: marketing-link-status-is-frozen-at-write-time
description: "A marketing customer-pharmacy link's validation_status is computed ONCE when the row is written and never recomputed — so fixing a customer's evidence later changes nothing until the links are explicitly re-decided."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-20T23:12:31.908Z
---

**LIVE ON PRODUCTION** since 2026-08-21 01:11 Cairo — PR #2237, squash `56a01af3`, confirmed by
`/api/healthz`. No migration. Verified the same minute: 163 active customers / 101 usable / 311
active links / 39 owner-held links, all unchanged, zero rows touched, zero errors in
`app_error_events`. The sweep had released **nothing** — it only acts when a rep actually captures.

`marketing_customer_pharmacies.validation_status` is **stamped at insert time** from the customer's
and the pharmacy's evidence *as they were at that moment*, by
`resolveMarketingSystemValidationStatus`. Nothing in the app ever recomputed it afterwards.

**The link row is the gate** — both the marketing-request customer dropdown and the draft guard
filter `validation_status IN ('system_validated','sfe_validated')`. So a customer whose links were
written when it had no evidence stays unusable **even after the evidence is supplied**, and the
customer's own `evidence_status = 'complete'` is not enough on its own.

**Why:** until #2237 (2026-08-21) `createMarketingValidationRecord` could only INSERT, so a rep who
owned a customer with missing evidence had no way to supply it — capturing the shop minted a
*second* customer and left the first stuck. Production carried 39 such customers, 5 duplicate
pharmacies, and the same doctor under two spellings. Adding an update path alone would have been
**decorative**: the rep walks to the shop, photographs it, and the links stay `pending`.

**How to apply:**

- Any change that makes a customer's or pharmacy's evidence better must also **re-decide that
  customer's links**, or the improvement is invisible. `refreshLinksAfterCustomerCompletion` in
  `src/lib/marketing-requests/service.ts` is the one place that does it.
- Re-decide **upward only** — `active`, `validation_status = 'pending'` rows. `rejected` is a human
  verdict; the validated statuses are already better than anything recomputed.
- Re-run the **whole** rule, including a fresh `checkCapturedGovernorate` against the pharmacy's own
  capture. A customer's new photo is not evidence about a shop that was never photographed.
- **Never auto-release a link a person held.** `MARKETING_MANUAL_HOLD_MARKER` (`"by owner decision:"`,
  in `types.ts`) marks the 39 links the owner held on 2026-08-21; the sweep skips and annotates them.
  It is deliberately distinct from `MARKETING_GOVERNORATE_HOLD_PREFIX` (`"Held for review:"`), which
  the workspace renders as "Code location mismatch".
- Re-attaching a shop a customer already links to is an **update, not an insert** — the unique index
  is `(customer_id, distributor_code_id)`, see
  [[customer-pharmacy-link-grain-is-customer-plus-code]]. Do **not** solve it with a blind `upsert`:
  that revives an `active = false` link and overwrites a `rejected` verdict.
- Completing a customer updates **capture columns only**. Identity (code, name, type, owner, area,
  line) is never rewritten, or the ROI history stops pointing at the same record.

Background on how those rows got there: [[marketing-links-were-backfilled-from-a-sheet-not-the-database]].
