---
name: a-line-move-then-a-backdated-resignation-erases-the-new-seat
description: "Ahmed Nabil (Alex East) moved Anti-Infective to Pedia on 1 Oct (owner, 2026-10-22) through the seat transfer, kept his Anti-Infective CRM account, then a resignation dated 30 Sep closed his Pedia seat at zero days although CRM shows him working 1-6 Oct with the Pedia DM."
metadata:
  node_type: memory
  type: project
  originSessionId: 2e7cea93-3c97-4e0d-a52b-d98ee4ae6a9e
  modified: 2026-10-21T23:35:57.879Z
---

**Owner's words, 2026-10-22:** "ahmed nabil was shifted to pedia line".

What the records say (read 2026-10-22, production):
- Seat history: the move went through the seat transfer correctly. It was written 23 Sep by the owner, source `org_move_ai0002_b177_pedia`. The Alex East Anti-Infective seat runs to 1 Oct ("moved to Pedia line effective 2026-10-01"), and the Alex East Pedia seat starts 1 Oct "under DM PD-0012" (Mohamed Eleiwa).
- A resignation was then filed on 10 Oct and approved 11 Oct by the owner, with last working day **30 Sep** (vacancy VAC-AI0002-B1N). Its resign row also starts 1 Oct, so his Pedia occupancy is `1 Oct to 1 Oct`: **zero days on the Pedia seat**.
- Employee Master: AI-0002, line already Pedia, status resigned, last day 30 Sep, `payroll_eligible` false. His September salary row (batch of 9 Oct) is labelled Pedia, although the move took effect on 1 Oct.
- CRM: he kept the **Anti-Infective** CRM account (1537, "Ahmed.Nabil ( Alex East / A )"); no Pedia account was opened. It shows **35 visits on 1 and 3 to 6 Oct**, stamped to him. Six of them on 6 Oct, and nine on 29 Sep, were made with the **Pedia** DM Mohamed Eleiwa. So he worked as a Pedia rep after the recorded last day.
- The CRM identity resolution maps account 1537 to him with no date. The Anti-Infective successor Basma Saiid (AI-0029, seat from 15 Oct) has no CRM account yet, so the undated mapping has caught nobody else's visits so far.

**Why:** a backdated last working day after a line move erases the new seat. The days he worked in October are unpaid, and the Pedia seat reads empty for them. A rep who changes line but keeps the old CRM account also files the new line's visits under the old line's label.

**How to apply:** after a line move, open the new line's CRM account, or rename the old one, the same day. Before approving a resignation, compare its last working day with CRM visits after that date. Correcting the date moves money: it is the owner's own click on Employee Master / Resignations, never a chat yes. Related: [[a-declined-offer-can-follow-real-working-days]], [[crm-resigned-slot-reused-for-new-hire]], [[au-hire-into-seat-vacancy-wiring]].
