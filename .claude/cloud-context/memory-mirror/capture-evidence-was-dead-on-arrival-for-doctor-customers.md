---
name: capture-evidence-was-dead-on-arrival-for-doctor-customers
description: "#2237's Capture Evidence rejected every 'doctor' customer — 81% of active marketing customers — with a message about the type field; fixed in PR #2249, and 'zero captures since it shipped' was the only signal it was broken"
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-08-21T01:26:10.663Z
---

**A feature can ship green, deploy cleanly, and be reachable by nobody.** #2237 added "Capture
Evidence" so a rep could complete a marketing customer already on record instead of minting a
duplicate. It was **rejected for every `doctor` customer** with `"Customer type is required."`

`normalizeCustomerType` in `src/lib/marketing-requests/service.ts` checked a hand-written copy of the
type list that omitted `doctor`, while **everything else allowed it**: the declared
`MarketingCustomerType` union, the DB constraint `marketing_customers_type_check`, and
`classifyCustomerType` in `roi-sheet-writer.ts`, which **defaults to `"doctor"`**. The module minted
rows it then refused to accept back.

No workaround existed — `startCompletingCustomer` seeds the form with the stored type and the field
is `disabled` while completing an existing customer, so a doctor customer could only ever submit
`"doctor"`.

Production 2026-08-21, before the fix:

| Type | Active | Could reach Capture Evidence | Pending links behind them | Write path |
| --- | --- | --- | --- | --- |
| **doctor** | 130 | **59** | **115** | **REJECTED** |
| hospital | 12 | 4 | 7 | accepted |
| clinic | 17 | 2 | 4 | accepted |
| other | 1 | 0 | — | accepted |

**59 of the 65 customers the feature existed for, and 115 of the 126 pending links behind them.**

**Why:** the only observable symptom was **zero evidence files captured since #2237 went live**,
which reads exactly like slow adoption. Nothing errored in logs, CI was green, the deploy was
healthy. **When a just-shipped feature shows zero usage, test the path end to end before concluding
it is adoption** — a silent 100%-rejection rate and nobody-tried-it look identical from the outside.

**How to apply:**

- ✅ **FIXED AND LIVE ON PRODUCTION 2026-08-21 04:22 Cairo**, squash `ad1dcba3`, deploy `success`
  after 102s, `/api/healthz` confirms `revision=ad1dcba3…`. Re-ran the harness against staging on
  the merged code: **CASE 1 (`doctor`) now PASSES — the customer completes.** Beware the harness's
  own score line: CASE 2 then fails with `Customer "…" already has complete evidence`, which is the
  `customer_already_evidenced` guard firing correctly because CASE 1 had just evidenced the
  customer. It reads as "1/2 checks passed" and is actually two correct behaviours. **Its restore
  step does NOT undo CASE 1's artifacts** — it left a pharmacy, a link and a distributor code on
  staging, all named `PHX STAGING TEST %`; delete link → code → pharmacy to return to 155/287/4.
- Fixed in **PR #2249** (`codex/marketing-doctor-customer-type`): `MarketingCustomerType` is now
  DERIVED from an exported `MARKETING_CUSTOMER_TYPES` list and the guard reads that list, so the two
  cannot drift again. The create dropdown is unchanged and still offers only the other four —
  `doctor` is **legacy-only by design: creatable never, completable always.** Do not "fix" the
  dropdown to add Doctor.
- **`doctor` is not a stray value.** It is 130 of 160 active customers, all from the 2026-07-02 ROI
  backfill — see [[marketing-links-were-backfilled-from-a-sheet-not-the-database]].
- Once #2249 is live, the 59 customers and 115 pending links become capturable for the first time.
  The 39 owner-held links are a separate decision and are **not** released by this — the sweep skips
  anything carrying the manual-hold marker.
- Proved on staging (`cifwmndunmlxjhyjugxa`) against the deployed revision `e1141ab1`, not from
  reading the code: `doctor` rejected, the identical submission as `clinic` passed all seven
  guarantees (update-not-insert, identity preserved, evidence `missing → complete`, new link
  promoted to `system_validated`, carried links correctly left pending). Method is recorded in
  [[dev-auth-is-header-only-browser-pane-cannot-use-it]] — dev-auth headers can never reach a
  deployed environment, so drive the domain service in-process with a guard that aborts if the
  resolved Supabase URL is production.
