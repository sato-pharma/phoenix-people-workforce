---
name: general-email-policy-routes-to-hr-inbox
description: "The \"general\" email policy in prod is recipient_modes=[\"hr_notifications\"], so any failed recipient lookup silently becomes mail to the shared inbox"
metadata: 
  node_type: memory
  type: project
  originSessionId: d0007173-7b15-4def-a4c3-f0d0670c67f0
  modified: 2026-08-08T09:36:39.943Z
---

In production `email_notification_policies`, the **`general`** row is configured
`recipient_modes = ["hr_notifications"]` (verified 2026-08-08). `general` is the catch-all
`notificationTypeFor()` returns for most modules — `direct_orders`, `weekly_plans`, `excuse`,
`outstation`, `coaching`.

**Why this bites:** `hr_notifications` resolves to `HR_NOTIFICATION_EMAILS` → `phoenix@satopharma.com`.
So whenever a per-person recipient lookup returned nothing, `resolveNotificationDelivery` fell back
to the stored policy and mailed the shared inbox — the intended person in neither To, CC nor BCC —
and recorded the send as `sent`. 67 emails went out this way between 2026-07-25 and 2026-08-08.

`contract_renewal`, `resignation` and `offer` are also `["hr_notifications"]` despite their
`recipient_mode` column saying `manager_chain`/`candidate`. **`recipient_modes` (plural) wins** —
`recipient_mode` (singular) is only the fallback when the array is empty.

**Why:** the fallback is invisible. Nothing logs, nothing fails, the delivery row says `sent`.
**How to apply:** when someone reports "the email went to the wrong place" or "X never got it",
check `to_addresses[1]` in `notification_send_reviews` — if it is `phoenix@satopharma.com`, the
recipient lookup failed and the policy covered for it. Guards added in PR #1886 now block this;
see [[recipient-assurance-guard-blocks-unknown-addresses]].
