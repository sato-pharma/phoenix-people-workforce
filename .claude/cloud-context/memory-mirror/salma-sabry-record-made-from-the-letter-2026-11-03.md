---
name: salma-sabry-record-made-from-the-letter-2026-11-03
description: "Salma Sabry Nofal (AI-0032) was made from her letter on the owner's choice, 3 Nov 2026, so her identity and pay are blank on purpose and her joining form is closed."
metadata:
  node_type: memory
  type: project
  originSessionId: e50549d1-2c7d-48f2-9380-f5c0f14ffe8c
  modified: 2026-11-03T11:55:45.844Z
---

Her letter was marked accepted by hand on 1 Nov and she never submitted the joining form. On 3 Nov the owner was asked by multiple choice and chose "Make it now, from the letter" over waiting for her form.

**What was written:** the same steps as Add Employee from a letter, run locally under actor `offer-letter-hire`: record, letter pointer, login, CRM task, mailbox task. Name, title, seat `SEAT-AIF-REP-D12`, hire date 8 Nov 2026 and the letter's private email only.

**Blank on purpose:** national ID, birth date, mobile, address, all pay lines and the company email. Her form now answers "already completed", so HR collects her ID by hand; never fill it from her CV. Pay is decided on the Employee Master screen, never in chat.

**Email:** the local run skipped the CRM task's email to the SFE Manager (`email_disabled_globally`); both people got it in-app, so it was not re-sent. Her candidate row stays shortlisted because `ats_candidates.offer_id` is null, and a candidate is never matched by name.

Related: [[the-october-2026-intake-identity-block-is-hr-operations-to-fill]], [[local-run-against-prod-db-silently-skips-every-email]], [[seat-start-follows-the-job-offer-2026-11-03]].
