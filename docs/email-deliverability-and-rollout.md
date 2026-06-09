# Email Deliverability & Rollout Runbook

Companion to the `codex/email-perfection` work (audit → 10/10). The code changes are
complete and test-locked; the items below are the **manual / approval-gated** steps that
must be done to fully activate them in production. Do them in order.

## 1. Apply the two migrations (approval-gated, Supabase MCP)

| Migration | What it does | Why first |
|---|---|---|
| `20260609000000_notification_outbox_add_skipped_status.sql` | adds `'skipped'` to `notification_outbox.status` | the engine writes `'skipped'`; until applied it falls back to the failure path |
| `20260609000100_email_suppressions.sql` | durable `email_suppressions` table | send-time suppression + unsubscribe + bounce/complaint feed |

Procedure (per migration): `list_tables` / `get_advisors` → confirm the live status CHECK
name (`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid =
'public.notification_outbox'::regclass and contype='c';`) → `apply_migration` to **staging**
→ verify → **production** on explicit approval → `get_advisors` clean.

## 2. Production environment variables (Vercel)

| Var | Set to | Why |
|---|---|---|
| `PHOENIX_EMAIL_FORCE_TESTING` | `false` | **P0** — stop redirecting all mail to the test inboxes. Verify with `/api/health/email` (must read `forceTesting:false`, `status:healthy`). |
| `NOTIFICATION_DASHBOARD_URL` | `https://phoenix-workforce.vercel.app` | needed to mint the HTTPS one-click unsubscribe URL |
| `PHOENIX_AUTH_SECRET` | (already set for sessions) | also signs unsubscribe tokens — confirm present |

Before broad enablement, send one `POST /api/notifications/test {"to":["a-controlled-inbox"]}`
and confirm receipt + headers.

## 3. GitHub Actions scheduler secrets (sub-daily drain)

In the repo settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `CRON_SECRET` | the SAME value as Vercel's `CRON_SECRET` |
| `NOTIFICATION_DRAIN_URL` | `https://phoenix-workforce.vercel.app/api/notifications/process?limit=50` |

The workflow (`.github/workflows/notification-drain.yml`) then drains every ~5 min. The
daily Vercel cron remains the guaranteed backstop, so this is purely latency reduction.

## 4. DNS — SPF / DKIM / DMARC (the biggest inbox-vs-spam lever)

Sending domain is **`mail.satopharma.com`**; Reply-To apex is **`satopharma.com`**.

1. **Resend → Domains → `mail.satopharma.com`**: add the exact SPF (TXT) + DKIM (CNAME)
   records Resend shows, plus the return-path/MX record if Resend requires one (this is
   what powers bounce/complaint webhooks → the suppression list). All rows must read
   **Verified**.
2. **DMARC** (TXT on `_dmarc.satopharma.com`), ramp up:
   - Phase 1: `v=DMARC1; p=none; rua=mailto:dmarc@satopharma.com; fo=1; adkim=s; aspf=s`
   - Phase 2 (after 1–2 weeks of clean aggregate reports): `p=quarantine; pct=100; …`
   - Phase 3: `p=reject; …`
3. **Verify**: Resend dashboard = Verified; `Resolve-DnsName -Type TXT mail.satopharma.com`
   / `Resolve-DnsName -Type CNAME resend._domainkey.mail.satopharma.com`; send a real test
   and confirm received headers show `spf=pass dkim=pass dmarc=pass`.

## 5. Sentry monitor cleanup (one-time)

In the Sentry UI delete/disable the orphaned cron monitors **`birthday-notifications`** and
**`contract-renewals`** (the code no longer checks them in; the authoritative monitor is
`daily-notification-dispatcher`).

## 6. Post-rollout verification

- `/api/health/email` → `healthy`, `forceTesting:false`.
- Webhook replay a `email.bounced (Permanent)` and `email.complained` → rows appear in
  `email_suppressions`; re-send to that address → skipped.
- Click a List-Unsubscribe link → `email_suppressions` gets a `reason='unsubscribe'` row.
- Submit a vacation request → manager approves a non-final step → HR/employee get the
  hand-off email.

## Remaining optional P2 code items (not silent-loss; safe to defer)

- **Interview templates** (`interview_invitation` / `interview_feedback`): currently
  interview emails send via the GENERAL template; wiring the dedicated templates is a
  polish item.
- **Marketing SLA producers**: `due_date_reminder` / `overdue_reminder` / `escalation` /
  `request_completed` event types are declared but not yet fired by a daily SLA scan.

## Branch note

This work is on `codex/email-perfection` off `main`. The unmerged `codex/email-table-polish`
branch contains a separate "premium email template" rewrite of
`src/emails/phoenix-email-layout.tsx`; when it merges, re-apply the small bidi-isolation
hunks (or move them — they live in `src/emails/bidi.ts` + a few `escapeAndIsolate` call
sites) on top of the new layout.
