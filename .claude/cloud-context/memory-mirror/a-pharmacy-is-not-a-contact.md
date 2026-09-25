---
name: a-pharmacy-is-not-a-contact
description: "Owner rule 2026-09-01 — a CRM contact count is AM + PM only; pharmacies are counted and shown separately, never folded into \"contacts\". Applies to every board that prints a CRM list size."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 68c99353-0621-4944-bcd9-8d97b0e8c226
  modified: 2026-08-31T21:51:17.310Z
---

**Owner, 2026-09-01, in his own words: "You will not count the pharmacies as contacts. So everyone
should have contacts and pharmacies. The contacts is divided into AM and PM, and the pharmacies are
separate."**

So the CRM's three lists are **two things, not three**:

| The owner's word | The CRM's `list_type` |
| --- | --- |
| **contacts** | `PM` + `AM` |
| **pharmacies** | `Pharmacy` |

**Why:** a rep's doctor list and their pharmacy list are different work with different targets — the
90-120 rule he stated on 2026-08-28 is about the **PM list**, not about the row count. A board that
adds all three prints one number that matches no rule he has, and it inflates every rep: on the rep
measured while this was fixed, "157 contacts" was really **114 contacts and 43 pharmacies**, a 38%
overstatement of the thing being judged.

**How to apply:**

- **Never `rows.length` beside the word "contacts".** Route every printed size through one helper
  that splits the two, so they cannot be silently re-added by the next edit. Reps List does this
  with `describeMix` in `src/components/crm/reps-list-tables.tsx` — "114 contacts · 43 pharmacies".
- **A percentage of the list is a percentage of CONTACTS.** PM and AM are the two halves and must
  total 100%. Putting pharmacies in the denominator restates the total he just separated out.
- **Give a pharmacy count its own tile or column** — separate, not hidden. He said everyone *should
  have* both; a rep holding pharmacies and no doctors is a real finding, not an empty list.
- **A field named `contacts` that holds pharmacies is the trap.** `RepsListGroup.contacts` was
  renamed to `.rows` on the day of this rule for exactly that reason: the next session reads the
  field name, prints it under "contacts", and the bug is back. Name the row bag `rows`.
- The label for the third list is **"Pharmacist"** in the singular row context (the list-type label
  a row carries) and **"Pharmacies"** where a count is being named. See
  [[recruitment-cv-received-is-in-app-and-telegram-never-email]] for the same
  say-it-the-way-he-says-it discipline on names.

Related: [[never-horizontal-scroll-always-mobile-and-desktop-friendly]] (declared in the same
breath, on the same board) · [[crm-speciality-has-one-authority-dont-build-a-second]]
