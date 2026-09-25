---
name: employees-mobile-number-is-not-dialable-as-stored
description: "`employees.mobile_number` in production is NOT a dialable number — 71% lost their leading zero to a spreadsheet import, and 3% hold two numbers in one field"
metadata:
  type: project
---

`employees.mobile_number` in **production** is free text that has been through Excel. Measured
2026-08-22 across the **175 active employees**:

| Shape | Count | Looks like |
| --- | --- | --- |
| Leading zero eaten by a spreadsheet import | **124** (71%) | `1012345678` — ten digits, no `0` |
| Proper local form | 18 | `01012345678` |
| **Two numbers in one field** | 5 | `01012345678 / 01112345679` |
| Empty | 26 | |
| Unreadable | 2 | |

So **any code that treats this column as dialable as stored is wrong for 7 people in 10.** It is
fine as a label to read off a screen, which is all it has ever been used for (the organogram node
popup's Contact section). It is not fine as a `tel:` or `wa.me` target without normalizing first.

**Why:** the column was populated from an HR spreadsheet, and Excel silently types a
leading-zero mobile as a number. Nothing downstream ever needed to dial it, so nothing ever
caught it.

**How to apply:** use `toWhatsAppNumber` / `hasWhatsAppNumber` in
`src/lib/reports/organogram-whatsapp.ts` — don't write a second normalizer. Two rules it encodes
that are easy to get wrong, both learned the hard way:

- **Resolve cosmetic separators BEFORE treating a separator as a delimiter.** Separators mean two
  opposite things in this column: *inside* one number they are decoration (`+20 101 234 5678`),
  *between* two numbers they are the delimiter (`01012345678 / 01112345679`). Nothing in the
  string says which. Try the all-digits-joined reading first, then fall back to splitting. My
  first version split first and turned every spaced number into `null`.
- **Refuse an over-long digit run outright; never slice it to a plausible eleven digits.** Validate
  against the assigned Egyptian mobile prefixes (`010/011/012/015`) and return `null` otherwise.
  A wrong digit here does not render a broken page — **it opens a chat with a stranger and invites
  the user to message them.**

Result: 147 of 175 get a working WhatsApp button (142 direct + 5 rescued from dual-number fields),
and the 2 unreadable rows correctly get none.

**The number itself must never ride on an organogram row.** `OrganogramWorkFields` carries only a
`hasWhatsApp` boolean; the button links to `/api/reports/organogram/whatsapp/[hrId]`, which
resolves it server-side per press. A row ships to every viewer's browser AND into the XLSX, so
putting the number there would be a bulk personal-data disclosure even with no export column —
see [[a-matrix-grant-is-only-gate-one-of-two]] for the neighbouring organogram gate, and the
owner's standing rule that exports carry work fields only.

Related: [[organogram-chart-source-is-au-seat-model-not-directory]],
[[employees-line-name-column-is-null-in-production]] (the other production column that is not what
its name promises).
