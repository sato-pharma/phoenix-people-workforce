# 09 — Cost Optimization Report

A financial reading of the 56 existing integrations. **No company spending figure is stated anywhere in this report**: the audit had no access to any invoice or billing console, so every amount below is either a provider's published list price (read on 13 Nov 2026, report 14) or a count of requests, runs or bytes measured in report 13. The four kinds of figure are kept apart, as §15 requires.

## 1. Verified current spending

**None.** No bill, invoice or billing page was readable by the audit. What is known is which services are on a paid footing:

| Integration | Footing | Source of that fact |
|---|---|---|
| Railway (EX-01, EX-02, EX-38 compute) | Paid, usage-based | Project configuration; bill not readable |
| Supabase (EX-05 to EX-11) | Paid plan; exact tier not readable | Plan features in use (daily backups, compute) |
| OpenAI, Anthropic (EX-21, EX-22) | Paid per token; no free tier | Provider terms |
| Google Maps Platform (EX-17, EX-18) | Pay-as-you-go above per-SKU monthly free caps | Provider terms; console not readable |
| WhatsApp Business (EX-31) | Per delivered message | Provider terms; bill not readable |
| Turbify mail (EX-27) | Paid mailbox subscription | Company mail host |
| Resend, Sentry, Fly.io, Groq (EX-25, EX-32, EX-16, EX-23) | Plan not readable | — |

Everything else in report 02 is on a free plan, free API, open-source software or the company's own code.

## 2. Estimated spending

**Not estimated.** An estimate would need request volumes from the billing consoles that the audit could not open. The published list prices that would drive such an estimate are recorded so the owner can do it in one sitting:

| Provider | Published list price that matters (13 Nov 2026) |
|---|---|
| Supabase | Pro from 25 USD a month per organisation; point-in-time recovery add-on 100 USD a month per 7 days of retention |
| Railway | Pro 20 USD a month per workspace including 20 USD of usage; RAM about 10 USD per GB per month |
| Google Maps | Per-SKU free caps each month (Essentials 10,000, Pro 5,000, Enterprise 1,000); the old 200 USD monthly credit is gone. Dynamic map loads 7.00 USD, static maps 2.00 USD, geocoding 5.00 USD per 1,000 after the cap. Maps Embed is free with no limit |
| WhatsApp (Egypt) | Utility, authentication and service messages 0.0036 USD each; marketing 0.0644 USD. Since 1 Oct 2026 service replies are charged above 1,000 a month per number |
| Resend | Free 3,000 a month and 100 a day; Pro 20 USD a month for 50,000 |
| Sentry | Developer free (1 user, 5,000 errors); Team 26–29 USD a month |

## 3. Possible savings

Each item states what was measured, what would change, and the assumption behind calling it a saving. None is given a currency figure because the current bill is unknown.

| # | Where | Measured | Change | Assumption behind the saving | Risk to reliability or function |
|---:|---|---|---|---|---|
| 1 | Google Maps (EX-17) | One autocomplete path sends no session token; no in-process Places cache | Session tokens on every autocomplete; cache geocodes and place lookups | Volume on those paths is above the free caps; per-session pricing is cheaper than per-request | None if caches respect Google's caching terms |
| 2 | Google Maps (EX-17, EX-18) | Approval and review screens draw billed static or JavaScript maps for read-only views | Maps Embed for read-only views (INT-016) | Those screens exceed the 10,000 free static or dynamic loads a month | Embed is less customisable |
| 3 | Google Maps (EX-18) | Several boards only plot pins and lines | Open renderer with a business-safe tile source (INT-021, INT-022) | The boards' map loads are billable | Visual change; Arabic labels to check |
| 4 | Supabase recovery (ISS-009) | No point-in-time recovery; restore never rehearsed | Nightly encrypted dump off-site (INT-096) plus a quarterly restore drill (INT-097) **instead of** buying the add-on | The business accepts up to a day of data loss; PITR would cost at least 100 USD a month at list price | A day of loss remains possible; this is a decision for the owner, not a saving to bank silently |
| 5 | Duplicate scheduling (EX-02, ISS-014) | Two schedulers call the same five routes | One scheduler plus a database lock | The Railway loop's process uses a measurable share of compute | Needs the outside-in monitor first |
| 6 | Heartbeat monitoring (EX-04) | 20 of 49 jobs watched — the free plan's ceiling | Database-side freshness alarm for every job (INT-068) instead of a paid plan | Otherwise the next step would be a paid Healthchecks plan | None |
| 7 | Uptime monitoring | No outside-in monitor | UptimeRobot free plan (50 monitors at 5 minutes) instead of a paid status service (INT-066) | — | 5-minute granularity |
| 8 | Push (EX-30) | 303 of 400 device rows unsubscribed | Standard web push (INT-041) | No current spend; avoids the vendor's paid tier as use grows | Re-subscription needed |
| 9 | Notices (ISS-030) | 4,669 notices skipped in 7 days because only 54 of 229 users have Telegram | Get more users onto Telegram (free) before sending notices by WhatsApp (INT-001, 0.0036 USD each) | Each notice moved to WhatsApp has a cost; each moved to Telegram does not | — |
| 10 | Dead infrastructure (EX-48, EX-49, EX-10, EX-41) | Eight legacy scheduler jobs may still call production; residue of two hosts; an unowned edge function | Remove | Any residual Google Cloud charge — none was read | None |
| 11 | CI (EX-12) | 34 of 60 sampled runs were deploy-alert runs that were immediately skipped; cache 9.83 of 10 GB with 6.8 GB stale | Job-level filters, cache clean-up, concurrency groups | **No money today** — runners are not metered on a public repository. It becomes money the day the repository goes private | A wrong concurrency group can cancel a needed run |
| 12 | Database (ISS-050) | 922 indexes with zero scans (169 MB) | Review and drop the unused ones after a full business cycle | Disk is billed per GB above the plan's included amount; write cost falls | Dropping an index a monthly report needs |
| 13 | AI (EX-23, EX-24) | Voice transcription to a third party; two unused provider hops | Remove the unused hops; keep transcription until volume justifies local compute | Minimal | None |

## 4. Unverified costs

| Item | Why it is unverified |
|---|---|
| Railway, Supabase, Turbify, Resend, Sentry, Fly.io bills | No billing access |
| Google Maps monthly spend, key quotas and restrictions | Cloud console not readable (ISS-010) |
| WhatsApp message spend | Meta business manager not readable |
| OpenAI and Anthropic token spend | Usage dashboards not read; the price note page could not be verified |
| Groq, Zoom, Action1, LocationIQ, Android Management plans | Production configuration or plan not readable |
| Residual Google Cloud charges from the closed project | No access to that project |
| GitHub Actions minutes if the repository goes private | Depends on a decision not yet taken; the free plan then includes 12 USD of compute a month |

## 5. Hidden-cost risks found along the way

- **The scheduler may switch off the daily notification run by itself.** cron-job.org's own page says a job is disabled automatically after more than 25 failures in a row. Three jobs, the daily notification run among them, end in a timeout every day (ISS-002). The day that rule triggers, notices stop with no bill and no alarm.
- **Free plans at their ceiling.** Healthchecks is at its 20-check limit. Brevo's free plan sends 300 e-mails a day and holds at most 1,000 in its retry queue — enough as a backup sender, not as the main one.
- **Free tiers that change.** WhatsApp service replies became chargeable on 1 Oct 2026; the Google Maps 200 USD credit was replaced by per-SKU caps. Report 14 holds the date each price was read.

---

## PHOENIX CRM — FREE-FIRST TECHNOLOGY OPTIMIZATION PLAN

The order in which to spend effort so that recurring cost does not rise while reliability does. Every step uses a free plan, open-source software or infrastructure already paid for.

**Step 1 — use what is already paid for (F4, no new provider)**

- Long jobs scheduled from the database with pg_cron and pg_net (INT-061); a freshness alarm for every job (INT-068); an alarm when punches stop (INT-070).
- Second factor for privileged roles in the existing auth provider (INT-005).
- A quarterly restore drill into the existing staging project (INT-097).
- One outbound client with deadlines and retries (INT-064); an integration registry (INT-063).

**Step 2 — switch on free features of providers already in use**

- Maps Embed for read-only views (INT-016), DMARC reports (INT-045), Dependabot security updates (INT-089), Access in front of staging (INT-059), one-tap approvals in Telegram (INT-037).

**Step 3 — add genuinely free services where nothing in-house can do the job**

- Outside-in uptime monitor (INT-066), breached-password check (INT-006), business-safe map tiles (INT-021), job posts in Google's job search (INT-033), tripwire tokens (INT-075).

**Step 4 — open-source libraries that run inside the app (no hosting)**

- IBAN validation (INT-012), phone-number normalisation (INT-013), standard web push (INT-041), workflow lint (INT-081), Core Web Vitals (INT-052).

**Step 5 — self-hosted open source only where it pays for its upkeep**

- Nightly encrypted database dump off-site (INT-096) is the one self-hosted item recommended now; it reuses the pattern of the working code backup (EX-53). Metabase, OSRM, Photon, whisper.cpp and similar stay CONDITIONAL until volume justifies their compute and maintenance.

**What the plan deliberately does not do**

- It does not replace Google Maps for addresses, Railway for hosting, or the paid AI providers: no free option matches them for this use.
- It does not adopt any free tier that trains on submitted data, limits use to individuals, or forbids commercial or employment use (the Gemini free tier INT-107 and the Better Stack free plan INT-112 are NOT RECOMMENDED CURRENTLY; Nager.Date INT-113 is EXCLUDED; MaxMind's free database was passed over for DB-IP Lite in INT-060 because its licence bars employment use).
- It does not count self-hosting as free.
