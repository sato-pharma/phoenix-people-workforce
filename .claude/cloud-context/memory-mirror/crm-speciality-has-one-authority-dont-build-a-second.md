---
name: crm-speciality-has-one-authority-dont-build-a-second
description: "A fifth of CRM 'doctors' are not doctors — src/lib/crm/contact-taxonomy.ts is the ONE authority that decides, and writing a second speciality list is the recurring mistake it exists to stop"
metadata:
  node_type: memory
  type: project
  originSessionId: ef45b053-0c83-4e60-94b7-2083401c5d8b
  modified: 2026-08-21T09:35:46.283Z
---

The iReports360 `speciality` column is **not only specialities**. The vendor puts three kinds of
thing in one free-text field: a doctor's discipline, a **place** (pharmacy, hospital, polyclinic)
and a **commercial account** (Contract, Health Insurance).

Measured on PRODUCTION 2026-08-21 over 14,451 contacts (excluding the `contact_crm_id = 0`
sentinel, which carries 30% of all visits and is already excluded by
`crm/checkin-match.ts` and `crm/customer-brick.ts`):

| Kind | Contacts | Share |
| --- | --- | --- |
| `sp` — a real doctor | 11,585 | 80.2% |
| `hcp` — a place or an account | 2,847 | **19.7%** |
| `unclassified` — blank | 15 | 0.1% |
| `unclassified` — value the list has not learned | 4 | 0.0% |

**`src/lib/crm/contact-taxonomy.ts` is the single authority.** It holds the owner's verbatim rule
(2026-08-08: *"all specialities SP, pharmacy and hospitals contract and insurance HCP"*), was
written after this exact defect hit Doctor Coverage — pharmacies were being scored against the
doctor visit norm — and is read by `sfe-doctor-coverage`, `rep-doctor-lists` and (since PR #2270)
`pharmacy-search/nearby`. `isHospitalSpeciality` there is **derived by filtering `HCP_VALUES`**, so
the hospital subset cannot drift from the HCP list.

**Why this is a memory and not just a code comment:** the module is easy to miss. In this session I
measured the phenomenon from scratch, wrote a private set of speciality strings, and only found the
existing module afterwards — the same duplication it was written to prevent. **Before classifying a
CRM speciality anywhere, grep `classifyCrmContactSpeciality` first.**

**Two rules that look like bugs and are not:**

- **An unclassified value is still SCORED as a doctor**, and flagged in the mix panel rather than
  dropped — *"dropping it would move the number silently"* when the vendor invents a label. Pinned
  in `tests/doctor-coverage-norms.test.ts`. Do not "fix" it into a drop.
- **`polyclinics` and `educational institute` are HCP by INFERENCE**, not by the owner naming them.
  The module says so, in one place, so one edit corrects them everywhere. 10 contacts.

Related: [[crm-door-resigned-exclusion-costs-a-contact-read-1100-doctors]] (the other CRM read
trap), [[crm-single-source-door-guardrail]] (all mirror reads go through `crm/reads.ts`),
[[campaign-visits-make-a-working-rep-look-like-a-zero]].
