---
name: a-training-day-row-is-judged-by-when-its-customer-was-created
description: "\"Drop the training rows\" is TWO sets: a customer created during the session is invented and goes whole, one created earlier is a REAL doctor whose place alone is fake — delete that place and send him back to pending, never his list history."
metadata:
  node_type: memory
  type: project
  originSessionId: d599b183-92d8-4906-8474-b8c852e03285
  modified: 2026-10-15T17:02:31.786Z
---

The owner, 2026-10-15, on the 18 Pedia captures in ش مكرم عبيد: *"those in Pedia line, we were in
training ... that is what I want to drop. But Farah is real work. You have a mind and you can
determine real work from testing. So check before you do anything."*

**The discriminator is `phoenix_crm_customers.created_at`, and it splits the set cleanly:**

- **Created ON the training day** → invented in the room (placeholder names, the reps' own first
  names, `origin = 'new'`, no `reference_contact_crm_id`). The whole row goes, and so does the
  `crm_contacts` row it minted in the doctor master — 9 of 14 had one, and a leftover there keeps
  "ppppppp" in the contact master after the customer is gone.
- **Created EARLIER** → a real doctor (loaded from a manager's sheet, or carried over from the
  vendor list) whose PLACE was captured in the training room, often hundreds of km from his own area
  — one was a Behira doctor, one from Assiut. **Delete only the place, its validation review, the
  visit taken at it and the list events that carry its `place_id`.** Keep the customer, keep his
  plan items (cut `place_id` to null rather than deleting one), keep every request his managers
  decided, and null `validated_at` / `validated_by_hr_id` so he returns to waiting to be validated.
  A sheet-loaded doctor who has not been validated reads `status = 'pending'` (277 of them did), so
  an `active` one goes back there; one his district manager and SFE dropped **stays dropped** —
  reversing their decision is not the session's to make.

**The line, not the brick, is what separates two teams working one street on one day:** `line_code`
told the training (`pedia`, 18 places + 20 venues) from real field work (`anti_infective`, Farah
Mossad's five) far more reliably than the rep, the seat or the address. See
[[a-scoped-crm-drop-must-guard-every-table-it-deletes-from]].
