---
name: verify-notification-deliveries-before-claiming-a-send
description: "Never claim a notification was or wasn't sent without querying notification_deliveries — I was confidently wrong twice in one session"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1e2a5a44-09c1-4b95-8b3b-ec6446552f83
  modified: 2026-08-09T09:43:01.950Z
---

On **2026-08-09** I twice told the owner something false about Early Birds notifications:

1. "their DMs were never emailed" — all nine had `channel = 'email'`, `status = 'sent'`
2. "nine reps get crowned by a manager who was never asked" — all nine managers had an
   **in-app AND an email** delivery, `sent`, at ~01:00 that morning

Both came from reasoning about *what the code would do* and from a partial earlier observation
("4 emails reached DMs" — that was a sample of a send still in progress, not the total). The owner
acted on the second claim and asked me to re-send. Re-sending would have duplicated a notification
into twelve real people's bells on a false premise.

**Why:** the delivery record is a table, not an inference. Events, channels, and per-recipient
outcomes are all first-class rows, so there is never a reason to guess.

**How to apply:** before saying anything was or was not delivered, query it. The join is
`notification_deliveries.notification_event_id = notification_events.id` (**not** `event_id` — that
column does not exist), and the module link is usually in `notification_events.metadata`:

```sql
select d.channel, d.status, count(*), count(distinct d.recipient_hr_id)
from public.notification_deliveries d
join public.notification_events e on e.id = d.notification_event_id
where e.category = '<category>'
group by d.channel, d.status;
```

Check `status` per channel, and check the **manager personally** (`lower(d.recipient_hr_id) =
lower(<manager>)`) rather than counting distinct recipients — a CC chain inflates the count and can
make an un-notified manager look notified. Category strings are easy to get wrong: Early Birds is
`early_bird_recommendation` (**singular** "bird"), while the module is `early_birds` (plural).

Related: [[telegram-reaches-only-two-accounts]], [[strict-recipients-silently-drops-whole-alert-families]].
