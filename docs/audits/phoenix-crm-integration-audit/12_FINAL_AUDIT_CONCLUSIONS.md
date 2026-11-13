# 12 — Final Audit Conclusions

## Overall assessment

The web app's integrations are, on the whole, **sound and economical**. The core runs on a small number of well-chosen providers, secrets stay on the server, storage is private, most webhooks are signed, and AI and e-mail each have a single door with a working fallback. Nothing was found that is actively harming employees, money or data today.

The weaknesses are of one kind: **failures that would happen silently.** A fingerprint feed that stops, a scheduler that cuts long jobs at 30 seconds and will eventually disable one, 29 jobs with no outside witness, a recovery path never rehearsed, scanners whose findings nobody acts on. Each is cheap to close with what the company already runs.

## What the audit could and could not prove

| Proven by a read-only test | Not provable within the constraints |
|---|---|
| Production, staging, the database, storage, auth, both AI providers, Resend, Telegram, WhatsApp, Google Calendar, cron-job.org, Healthchecks, Cloudflare and GitHub answered and authenticated | Google Maps key restrictions, quotas and spend (console not readable) |
| Delivery outcomes per channel over seven days (counts only) | Error-tracking event flow (the local token is no longer valid) |
| Scheduler run times, job heartbeats, database advisors and grants | Whether six optional integrations are on in production |
| GitHub settings, caches, secret names, scanning alerts and workflow history | Any company spending figure |
| DNS mail-authentication records | Anything requiring a sent message, a triggered job or a billed call |

24 of 56 integrations remain NOT VERIFIED for those reasons. That number is recorded as it is, and was not made smaller by assumption.

## Recommended next steps, in order

Each is a separate correction session, so each change can be reviewed on its own.

1. **Close the open secret-scanning alert** — rotate first if the token is live (ISS-023).
2. **Decide repository visibility** knowing the trade-off in report 05, and correct the runner guide either way (ISS-021, ISS-056).
3. **Stop the silent failures:** the punch alarm (INT-070), long jobs moved off the 30-second cut (INT-061, ISS-002), a freshness alarm for every job (INT-068), an outside-in uptime monitor (INT-066).
4. **Make recovery real:** a nightly encrypted database dump off-site (INT-096), a quarterly restore drill into staging (INT-097), and a rehearsal of the standby host (ISS-038).
5. **Tighten sign-in:** sign-up off at the provider (ISS-004), a second factor for the roles that can pay people (INT-005), breached-password checks (INT-006).
6. **Harden the edges:** redirect checks on applicant links (ISS-015), security updates on (INT-089), triage of code-scanning alerts (ISS-022), one inbound-webhook verifier (INT-073), the attendance token off the browser (ISS-035).
7. **Build the one outbound client and the registry** (INT-064, INT-063) so the next audit can read live status instead of reconstructing it.
8. **Remove what nothing uses:** the unowned edge function, unused AI hops, the retired vendor's credentials, the legacy scheduler jobs and host residue, the stray font request (EX-10, EX-24, EX-41, EX-48, EX-49, EX-45).

## Before any new integration is added

- Prefer, in this order: what the app already runs (F4), a free feature of a provider already in use, a genuinely free service, an in-app open-source library, and only then self-hosted software — counted with its compute and upkeep.
- Read the provider's pricing and licence page on the day, and record the date. Free tiers changed during 2026 (WhatsApp service replies, Google Maps credit); some popular "free" tools are not free for this use (Nager.Date commercial use, MaxMind for employment use, the Gemini free tier, which trains on prompts).
- Any new processor of employee or candidate data gets a legal review under Egypt's Personal Data Protection Law (Law No. 151 of 2020) first, and is tested with synthetic data only.

## Constraint compliance

During the audit no production record was changed, no integration reconfigured, no credential rotated, copied or printed, no row-level security policy changed, no migration run, no deployment made, no message, e-mail or heartbeat sent, and no business workflow triggered. All database reads were catalogue and count queries. The provider probes are in `scripts/readonly-connectivity-check.mjs`, which prints no secret.
