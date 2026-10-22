---
name: a-declined-offer-can-follow-real-working-days
description: "The declined-offer shortcut's \"Include in payroll\" defaults to NO and its last working day to the hire day — Shimaa Ibrahim (Sharkia 1 Anti-Infective) worked 7 days (owner, 2026-10-22) yet sits as declined_offer, last day 2 Sep, zero payroll; read CRM before choosing."
metadata:
  node_type: memory
  type: project
  originSessionId: 2e7cea93-3c97-4e0d-a52b-d98ee4ae6a9e
  modified: 2026-10-21T23:35:48.008Z
---

**Owner's words, 2026-10-22:** "shimaa worked 7 days then apologized and rejected the offer".

What the records say (read 2026-10-22, production):
- Employee Master: Shimaa Ibrahim (AI-0017), Medical Rep, Sharkia 1, Anti-Infective. Status `declined_offer`, hire 2 Sep 2026, last working day **2 Sep**, resignation date 11 Sep, exit reason "Declined offer after hire", `payroll_eligible` false. No salary row in any batch.
- Seat history: Sharkia 1 Anti-Infective rep seat held 1 Sep to 3 Sep only (resign row written 11 Sep by the owner).
- CRM: the Sharkia 1 / Anti-Infective account (CRM 1303) logged **37 visits from 5 to 10 Sep**, five of them on 5 Sep with her DM Samaa Shalaby. No HR number is stamped on them, because her record ends on 2 Sep. 45 plan rows for 5 to 9 Sep are unstamped too.

**The mechanism.** `declineOfferAndOpenVacancy` (`src/lib/resignations/service.ts`) takes `includeInPayroll`. YES gives status `terminated`, and Ready Payroll pays the days worked at base-only pay. NO gives `declined_offer` with zero payroll footprint. The form defaults to **"no"** (`employee-management.tsx`, `includeInPayroll: "no"`), and the last working day defaults to today. Nothing checks CRM or attendance before the choice.

**Why:** a person who did real fieldwork can be recorded as never having worked, and is then unpaid for those days. Every dated reader (seat history, the field absence calendar, CRM stamping) also loses the days.

**How to apply:** before the declined-offer shortcut, read CRM visits and fingerprint punches after the hire date. Any working day means "Include in payroll: yes", with the last working day set to the last day worked. Correcting Shimaa's record moves money: it is the owner's own click on Employee Master, never a chat yes. Related: [[crm-resigned-slot-reused-for-new-hire]], [[a-line-move-then-a-backdated-resignation-erases-the-new-seat]].
