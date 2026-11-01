---
name: a-returning-leaver-is-a-new-employee
description: "Owner 2026-11-01 - someone who resigned and comes back on a new offer is a NEW employee with a new record, never a reactivated one; Ahmed Helal (Pedia to CNS, Port said - Domiat) is the first case; the joining form lets such a person through once the fix branch codex/returning-leaver-joining-form is merged."
metadata:
  node_type: memory
  type: project
  originSessionId: 3888aa00-a273-4599-8af0-cb40443c06ba
  modified: 2026-11-01T16:58:17.925Z
---

Owner, 2026-11-01 about 18:45 Cairo, about Ahmed Helal: *"he was already on pedia but resign and we sent a new joib offer same area diff line so treate him as a new employee"*.

A returning leaver gets a NEW Employee Master record and HR ID. The old record stays resigned and keeps its own history. Never reactivate or merge it.

The case: old record B-3 (Pedia, resigned, last working day 2026-08-09). New record CN-0013 (CNS, Port said - Domiat, hired 2026-11-01, seat SEAT-CNS-REP-D26), made by the owner through Add Employee from the offer.

**Why:** the new line, seat, pay and hire date are a fresh employment, so nothing should carry over from the old one.

**How to apply:**
- `employees` has NO unique index on `national_id` or `mobile_number` (read live 2026-11-01), so two records CAN hold the same ID and mobile. Same-ID and same-mobile pairs are still zero (read live 2026-11-01): CN-0013 was created with both blank, so B-3 is the only holder today. A check that assumes one person per ID has never met this shape.
- `work_email` and `crm_username` ARE unique, and the old record keeps both, so the new record needs a new address and CRM account.
- `findExistingHire` in `src/lib/offers/joining-form-service.ts` blocks only on a record that passes `isActiveLifecycleStatus`, and a partly written hire is found by its minted HR ID (`findRecordJustWritten`). Until the branch above merges, production still refuses a returning leaver with "You are already registered with us". Add Employee does not hit this check.
- Never read one person's record with `limit(1)` on `national_id` or `mobile_number`: a leaver's row can come back instead of the current one.
- The WhatsApp inbox link picker (`src/lib/whatsapp-inbox/store.ts`) matches by phone tail and will list both records once a returner's record carries the same mobile. It only offers, a person chooses.
- Three earlier Senior Medical Representative offers also sit on the Master as "Medical Representative", so that difference is the pattern, not a defect of this hire.
