---
name: a-whatsapp-apply-link-cannot-be-attributed-yet
description: "A tracked WhatsApp apply link attributes nothing yet — a forward drops the applicant's own message where the code lives. Adverts still default to WHATSAPP: the owner overrode the email-first advice on 2026-08-25 (#2402)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0a4225a0-74c2-4b20-accd-501f8fcdc660
  modified: 2026-09-15T13:37:16.381Z
---

**Measured on production 2026-08-24, last 30 days:**

| channel | events | distinct senders |
| --- | --- | --- |
| `whatsapp` | 434 | **11** |
| `email` | 276 | **213** |

Eleven senders across 434 events are **HR staff forwarding batches** off the advertised handset
`01159888247` — not applicants. Email's ~1.3 events per sender is real applicants writing in. The
ratio is the whole diagnosis: read `count(distinct sender_identifier)` before believing a channel
carries direct traffic. (Column is `channel`, **not** `source`.)

**Why it decides the apply link.** The tracking code (`Ref: PX-XXX`) rides in the applicant's own
first message. A forward carries the **CV file** but not that message, so a WhatsApp apply link
produces CVs that arrive fine and attribute to **nothing** — the exact gap the feature exists to
close. Email's code travels in the **subject line** and survives the poller intact.

`job-advert-panel.tsx` shipped defaulting `applyKind` to `"email"` for this reason (#2401). **The
owner then overrode it on 2026-08-25** — he was shown the numbers above, asked to choose, and picked
the handset anyway, so the default is `"whatsapp"` (#2402) and the warning callout renders on load
instead of only on the toggle. **That is an informed trade, not a bug: do not "fix" it back.** It
becomes moot once Coexistence delivers applicant messages to the webhook directly — verify by
re-running the query above and seeing WhatsApp's distinct senders climb toward its event count. See
[[whatsapp-coexistence-verified-state-2026-08-24]]: Tech Provider access verification was still in
review that day, so it is not yet true.

**`RECRUITMENT_APPLY_WHATSAPP_NUMBER` = `01159888247`**, set on **production AND staging**
2026-08-25 at his explicit instruction; resolves to `https://wa.me/201159888247`. Setting a Railway
variable **does** trigger a redeploy by default (there is a `--skip-deploys` opt-out), so it does not
sit inert. **The Cloud API line `+20 10 98500699` must NEVER be advertised** — it is the internal
forward target, not the public handset. Do not confuse the two.

Related: [[the-email-import-allowlist-holds-an-inbox-not-a-sender]] ·
[[facebook-group-posting-cannot-be-automated-ever]]
