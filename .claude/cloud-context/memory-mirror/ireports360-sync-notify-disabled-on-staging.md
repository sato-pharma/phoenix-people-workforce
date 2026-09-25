---
name: ireports360-sync-notify-disabled-on-staging
description: "SETTLED 2026-08-29 - the owner ruled do not touch staging and keep production as it is, so the lost opt-out is NOT to be restored; staging notifications sit at their code defaults, and ireports360_sync_notify defaults ON."
metadata: 
  node_type: memory
  type: project
  originSessionId: 33b4fa46-0060-4b45-9908-c9dddf97f995
  modified: 2026-08-28T09:34:20.306Z
---

## OWNER RULING 2026-08-29 - do not touch staging; keep production as it is. CLOSED.

Asked directly whether to re-insert staging's `ireports360_sync_notify` row as `enabled: false`,
the owner answered: **"donot touch staging keep in production"**. So:

- **Do NOT restore the row, and do not restore any other lost staging override.** Staging's
  `notification_role_policies` stays empty and every key there sits at its code default.
- **Production is not to be changed either** - "keep in production" means leave it as it is, not
  move anything into it. Verified live the same day: **16 rows, 3 disabled**
  (`field_workforce_compliance_digest`, `outstation_sla_reminder`, `probation_weekly_dv_digest`),
  with `ireports360_sync_notify` **enabled = true**, which is its intended production state.
- **This question is CLOSED. Do not re-raise it** and do not offer to "fix" staging's table. The
  standing instruction to raise it "next time staging or CRM sync work comes up" is DISCHARGED -
  it was raised, and this is the answer.

What still matters is the consequence, which the ruling does not remove: **a staging iReports360
sync test will Telegram every active Super Admin with no "staging" label**, because the code
default is ON. That is now an accepted condition of staging, not a defect to repair - so treat it
as a reason to avoid firing a staging sync casually, never as a reason to edit the table.

## CORRECTION 2026-08-29 - the opt-out no longer exists, and the effect is INVERTED

(Kept as the dated record of what was measured before the ruling above closed it.)

Measured live against staging (`cifwmndunmlxjhyjugxa`): `public.notification_role_policies` holds
**0 rows**. The row described below is not merely re-enabled - it is **gone**, along with every
other policy override staging had. Production (`ozucdzovmcqvepbozvqf`) is untouched at **16 rows,
3 disabled** (`field_workforce_compliance_digest`, `outstation_sla_reminder`,
`probation_weekly_dv_digest`), so this is staging-only, consistent with the 2026-08-29 staging data
restore.

**An absent row is not a disabled one.** `getNotificationRolePolicies()`
(`src/lib/notifications/role-recipients.ts:189-215`) does `if (!row) return fallback;`, falling back
to `DEFAULT_NOTIFICATION_ROLE_POLICIES[key]` - and `ireports360_sync_notify` defaults to
`enabled: true`, roles `["Super Admin"]` (line 135-141). **13 of the 16 keys default enabled**; only
`probation_weekly_dv_digest`, `outstation_sla_reminder` and `marketing_sla_reminder` default off.

So the notifier is **ON** on staging again, and the instruction below - "re-enabling just needs
`enabled: true` again" - is now backwards: there is nothing to re-enable. Restoring the owner's
decision means INSERTING the row with `enabled: false`.

The consequence the original opt-out existed to prevent is live once more: triggering
`/api/cron/ireports360-visits-sync` on staging pings every active Super Admin over Telegram with no
"staging" label in the message. **Do not run a staging sync test before settling this with the
owner** - his instruction was to raise it next time staging or CRM sync work comes up, which this is.

Note this is not specific to one key: **every** deliberate staging override in that table was lost
the same way, so any other staging notification setting a past session tuned is also back to its
code default.

## Original note (2026-08-28) - kept as the dated record of what was decided

On 2026-08-28, staging's `notification_role_policies` row for `ireports360_sync_notify` was set to
`enabled: false` (roles left as `["Super Admin"]`, unchanged — re-enabling just needs `enabled: true`
again). Production's copy of the same policy was left untouched and is still `enabled: true`.

**Why:** earlier the same session had fixed staging's missing `IREPORTS360_BASE_URL`/`USERNAME`/
`PASSWORD` Railway variables (staging had none; production's were copied over), then triggered the
real `/api/cron/ireports360-visits-sync` route on staging via its `CRON_SECRET` to prove the fix
worked end-to-end. That route unconditionally pings every active Super Admin over Telegram on
completion (`src/lib/notifications/ireports360-sync-digest.ts`), with no "staging" label in the
message — so the verification run sent a real, indistinguishable-from-production Telegram push to
whoever's account is bound to staging's `phx-1` (Phoenix System Administrator) Telegram connection.
The owner's own `B-10` Super Admin account has no Telegram binding on staging, so it wasn't reached
that way. To stop further staging test syncs from doing this again, the owner asked to turn the
notifier off on staging specifically (not production).

**How to apply:** the owner does NOT want a scheduled reminder for this — he asked to just have it
brought up "next time we talk about staging" (CRM sync, iReports360, or staging verification work in
general). When that comes up in a future session, ask whether he wants
`ireports360_sync_notify` re-enabled on staging now that testing is done, and if so, either flip it
via `/admin/cron-control` or run the same update directly against the staging Supabase project
(`cifwmndunmlxjhyjugxa`, NOT `ozucdzovmcqvepbozvqf`):

```sql
update notification_role_policies set enabled = true, updated_at = now(), updated_by = '<actor>'
where notification_key = 'ireports360_sync_notify';
```

An `audit_logs` row was written for the original disable (entity_type `notification`, entity_id
`ireports360_sync_notify`) mirroring what the admin UI would have written, since the SQL path
doesn't do that automatically — do the same for the re-enable so the trail stays complete.
