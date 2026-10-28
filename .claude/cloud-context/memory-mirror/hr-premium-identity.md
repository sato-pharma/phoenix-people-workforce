---
name: hr-premium-identity
description: "The HR premium identity is the owner's template for the Sato Pharma documents he ticked CHANGE on 13 Oct 2026 (English salary letter and certificate - and since 28 Oct 2026 the Arabic certificate and the Arabic salary letter too, in the certificate of experience's design - exit interview, payslip, organogram record, interview calendar, CRM start guide, Field Activity, plus a new Premium job-offer design). Every paper he ticked KEEP prints as before, behind the PREMIUM_DRESS switch table. Government forms and the contract stay as they were."
metadata:
  node_type: memory
  type: project
  originSessionId: 0699131c-9b4a-4ab5-b5cd-5820bfbcb052
  modified: 2026-10-12T21:38:09.472Z
---

On 12 October 2026, around 22:20 Cairo time, the owner said: "Save this identity as the HR premium
identity … in a follow-up session I want you to make all the normal templates or forms in Sato
Pharma follow this perfect template. But not the governmental, the governmental as they are."
The same evening: "the contract keep corporate as it was".

On 13 October 2026, around 00:40 Cairo, he answered a review page, one box per paper. **Change:** the
English salary letter, the exit interview, the English certificate of experience, the payslip, the
organogram employee record, the interview calendar PDF, the Phoenix CRM start guide, the Field
Activity report, and "for job offers create new templete with the new identity". **Keep (prints as
before):** every other HR and hiring paper, both clearances, both custody receipts, the worker data
form, the Arabic salary letter, the contract set, the four older job-offer designs, Spotlight, the
business card, the workbooks and the rest. **Font:** keep as is. **Foot code:** keep SATO-DIS-2026-01.

- **The look** is the house identity SATO-DIS-2026-01 (logo blues, ink rule, band) with a premium
  layer: a microtext frame, an Arabic watermark, a centred masthead and a running foot.
- **The code:** `src/lib/hiring-pack/premium-identity.ts`; a kept paper's premium branch is switched
  off in its `PREMIUM_DRESS` table, never torn out. The skill is `hr-premium-identity` (machine-wide
  and in the repo).
- **Government forms are never touched:** social-insurance Form 1, Form 6 and the labour exit form.
- **The foot of a company paper says Sato Pharma, not Phoenix** (his choice "Sato Pharma alone", 13 Oct
  2026; one constant: `PREMIUM_COMPANY_DOCUMENT_BRAND`), because the payslip and organogram have pinned "no Phoenix on a
  company document" since 2026-09-05 and a job offer reaches a candidate.

**Why:** he wants the premium look on the documents he picked, and every other paper left as it is.

**How to apply:** a new or restyled normal Sato document asks whether it is a "change" paper; never
widen the premium dress past his ticks, and never use it on a government form.

Related: [[the-house-document-identity-standard]], [[government-form1-prints-exactly-as-issued]].
