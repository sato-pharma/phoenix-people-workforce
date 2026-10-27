---
name: the-email-import-allowlist-holds-an-inbox-not-a-sender
description: 'RECRUITMENT_EMAIL_IMPORT_SENDERS held careers@satopharma.com, a DESTINATION mailbox that never sent a message — the email forward-import gate matched 0 of 634 until FIXED 2026-08-24 (#2388 added @domain matching; the var is now @satopharma.com)'
metadata:
  node_type: memory
  type: project
  originSessionId: bebc6e30-f573-438d-aa57-d72a715f973d
  modified: 2026-08-24T10:40:00.000Z
---

Read live from Railway `production` 2026-08-24:

```
RECRUITMENT_EMAIL_IMPORT_SENDERS    = careers@satopharma.com
RECRUITMENT_WHATSAPP_IMPORT_SENDERS = 01159888247,201280955558
RECRUITMENT_EMAIL_INBOXES_JSON      = hr@satopharma.com, careers@satopharma.com
```

**`careers@` is one of the two polled INBOXES. It is a destination, not a sender.** Across 634 email
intake events it appears as the `From` address **zero** times, so `isEmailImportSender` — an exact
lowercase string equality, no domain or wildcard support — has matched **0 of 634**. The email
forward-import path has never once executed in production.

`ats_cv_intake_events` proves it by channel:

| channel | messages | treated as import | treated as applicant |
| --- | --- | --- | --- |
| email | 634 | **0** | 634 |
| whatsapp | 436 | 417 | 19 |

The WhatsApp list is correct — `201280955558` is the "Omar Anwar" line that carried the 18 August
bulk forward, and the 19 non-import messages are 9 one-off numbers in late July, each a genuine
applicant. **Only the email side is inert.**

The real senders are **47 distinct `@satopharma.com` staff addresses**, ~113 messages: omar.anwar
(31), omargawish (11), anwar.gaweesh (5), sara.jacoub (5), hr@ (4, most recent **2026-08-24 03:16**),
then a long tail. None is on the list, so each is read as the applicant and the address becomes a
dedupe key — the exact collapse `cv-import-shared.ts` documents. Damage stayed small because most of
those events never produced a candidate (`candidate_id` NULL); only 4 records were ever created that
way and a parallel session deleted all 5 staff records the same day
(`public.zz_backup_ats_candidates_20260824`, 7 rows). Verified no applicant was lost — e.g. the
`hr@satopharma.com` record named "Malak Yasser" has a real twin at `malakyasser235@icloud.com`,
same phone.

**Why:** the gate looks configured, and a `railway variables` glance reads as healthy, so nobody
questions it. `treated_as_import = 0` is the only reading that exposes it.

**RESOLVED 2026-08-24.** [#2388](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2388)
(squash `2d317a58`) taught `isEmailImportSender` that an entry beginning `@` matches the whole
domain; the variable is now `@satopharma.com`, verified read-back as 15 chars, one entry, no BOM.
**CORRECTED 2026-08-28 — a variable change DOES trigger a deploy. This read a LATENCY as an
absence.** Measured on Railway staging that day: environment left settled (`96fa5e19` SUCCESS),
`railway variable set` at **08:57:42Z** with no `--skip-deploys`, and deployment `6c805087` appeared
**3 seconds later on the SAME commit** `fdc63919` — no push behind it. Production's own history
shows the identical shape underneath the 2026-08-24 observation: `e84f0c05` at 07:57:56Z on commit
`8f27b62b`, with no commit to explain it, three minutes after the variable was set and **nine
minutes BEFORE** the manual redeploy.

**The dated observation itself stands and is left as written:** the value did sit beside a container
still holding the old one for 8 minutes until an explicit `railway redeploy` (deployment
`72252d91`, same commit `8f27b62b`, healthz 200 throughout). What was wrong was the conclusion drawn
from it. A deploy fires within seconds; the change is inert until that deploy reaches **SUCCESS**,
and a Next build here takes minutes — which is exactly what "nothing happened" looks like. Setting a
Railway variable is still only half the act, because a Node process reads `process.env` once at
startup; the missing half is *waiting*, not *redeploying*. See `AGENTS.md` §2.3.

**How to apply:** an entry on this list must be an address that **sends**, never one the app polls.
Do not "fix" it by pasting 47 staff addresses — `isEmailImportSender` needs domain support first
(an entry beginning `@` matching the whole domain), then one entry `@satopharma.com` covers every
current and future employee. Import mode reads identity from the CV, which is strictly better than
the envelope, so matching the whole internal domain is safe even for a genuine internal applicant.
Check any allowlist by counting what it actually matched in `ats_cv_intake_events`, not by reading
the variable. See [[a-cv-import-overwrote-a-candidates-whole-identity]] for the incident this gate
was supposed to prevent.
