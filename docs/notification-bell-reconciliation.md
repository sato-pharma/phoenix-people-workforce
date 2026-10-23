# In-app notifications that no bell could open

Account for the rule in `.claude/rules/notifications.md`, "The in-app bell". Found and repaired
2026-10-23 from the nightly reconciliation run (04:40 Cairo), whose two notification checks had been
declared known-open since August with a note saying the damage was "stale history".

## What the ledger said and what the bell could do

The bell (`listInAppNotificationsForViewer`, `src/lib/notifications/in-app.ts`) lists **events**, not
deliveries: an event is shown to a viewer only when its category is on `PERSONAL_BELL_CATEGORIES` and
the viewer is the event's `employee_hr_id` or is in its `recipients`. It returns nothing for a viewer
with no HR ID. A delivery can therefore be recorded `sent` on the in-app channel and still be
unreachable, which is the worst shape a notification fault takes: monitoring reports 100% success.

| Class | Rows | What caused it |
| --- | --- | --- |
| Category not on the bell list | 215 | `weekly_plan`, `crm`, `security`, `system`, `market_awareness`, `outstation` were written as in-app deliveries but filtered out of every bell. Three were still being written on the day. |
| Recipient with no HR ID | 386 | Weekly-plan and support notices addressed to the `admin-HR` service login (377) and a login of 2026-06 (9). The bell is keyed on an HR ID, so these could never be shown. |
| Event no longer names the person | 236 (202 events) | Every approval rung of a direct order called `notifyDirectOrder` with ONE recipient and the same key `direct_orders:<request>:<event>`, so each rung upserted the same `notification_events` row and replaced `employee_hr_id` / `recipients`. The previous approver's delivery stayed `sent` against an event that now named someone else. |

The check's old notes counted 9 and 23 rows and said the writers had been clean since. Measured on
production, the real numbers were 622 and 215, still growing.

## What changed

- `PERSONAL_BELL_CATEGORIES` carries the six categories (`src/lib/notifications/recipients.ts`).
- `createSystemNotificationForRecipient` records an in-app delivery to a recipient with no HR ID as
  `skipped`, with the reason in `last_error`, never `sent` (`src/lib/notifications/system.ts`).
- `notifyDirectOrder` appends the recipient's HR ID to the event key when exactly one person is
  addressed, the same suffix `createSystemNotificationForRecipients` already puts on a group's keys
  (`src/lib/direct-orders/service.ts`). A group call is unchanged.
- The two checks `in-app-sent-must-be-bell-renderable` and `in-app-sent-recipient-must-be-able-to-see-it`
  are `holds`, so a regression pages the owner instead of reading as a documented finding.
- Migration `20261023082524_repair_stranded_in_app_notifications.sql` repaired the history, applied to
  staging and then production. It deletes nothing: the 386 deliveries became `skipped`, the 202
  events regained their missing recipients, and 236 read-and-archived `notification_user_states` rows
  were written so a decided approval rung did not reappear as unread. The exact before-image is in the
  schema `notification_backup_20261023` (`deliveries_no_hr_id`, `events_widened`, `user_states_added`),
  and the rollback statements are in the migration's header.

## How to re-verify

Both checks run in the 04:40 reconciliation. By hand, the second one is:

```sql
select count(*) from notification_deliveries d join notification_events e on e.id = d.notification_event_id
where d.channel = 'in_app' and d.status = 'sent'
  and not ((e.employee_hr_id is not null and upper(btrim(e.employee_hr_id)) = upper(btrim(d.recipient_hr_id)))
        or exists (select 1 from unnest(coalesce(e.recipients, array[]::text[])) r
                   where upper(btrim(r)) = upper(btrim(d.recipient_hr_id))));
```

It was 622 before the repair and 0 after, on production, the same day.

## The other five known-open checks, re-armed the same day

Run once, read-only, against production on 2026-10-23 (the reconciliation service writes nothing). Four
agreed: the payroll dashboard, the bank file and the command-center card across 9 approved batches
(989 rows, 20,911,980.16 EGP on the dashboard and its own records), and the SoS top customers (15 rows,
15 customers; the two-period cross-check had 0 customers it could verify independently, so only the
one-row-per-customer half is proven). The attendance check was the check's fault, not the summary's:
it compared all 52 ordinary absences in October with the one outage day, while the summary already
reported 2026-10-22 as no data. It now asks whether each outage day is reported as no data.
All five are `holds`.
