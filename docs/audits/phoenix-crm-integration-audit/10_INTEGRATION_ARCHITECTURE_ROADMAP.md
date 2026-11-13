# 10 — Integration Architecture Roadmap

The recommended future shape of how the web app talks to the outside world, against the ten architecture questions of §14. These are architecture recommendations only. No sidebar module was created; the one capability that would need a new screen is labelled `PROPOSED NEW MODULE — NOT PRESENT IN CURRENT SIDEBAR` and kept out of the canonical inventory (report 01).

## Where the architecture stands

Some of the right patterns already exist, but only in places:

| Pattern | Where it already exists | Where it is missing |
|---|---|---|
| One door per provider family, with failover | AI (OpenAI → Anthropic), e-mail (Resend → Brevo → Turbify) | Maps, push, messaging |
| Deadlines on outbound calls | Most clients | Seven call sites, Zoom entirely (ISS-011) |
| Signed inbound webhooks | Resend, WhatsApp, Telegram, scheduled routes | Brevo, Sentry replay window, machine endpoints (ISS-013, EX-47) |
| Heartbeats | 20 of 49 jobs outside-in; first-party heartbeat table for all | 29 jobs have no outside witness (ISS-001) |
| Health endpoints | `/api/healthz` (revision) and `/api/readyz` (release gate, database, config) | No outside-in probe (INT-066) |

The direction is to make each of these patterns universal rather than to add new platforms.

## A–J

### A. Centralized integration registry — RECOMMENDED

**Today:** the list of integrations lives in code, environment-variable names and operations notes; whether six optional integrations are live in production cannot be told from the repository (ISS-039).
**Proposal:** a registry table — one row per integration with owner, provider, sidebar modules, data categories sent, credential name (never its value), last success, last failure and free-tier ceiling — seeded from report 02 (INT-063).
**Module:** the registry needs a page. It is labelled `PROPOSED NEW MODULE — NOT PRESENT IN CURRENT SIDEBAR`; the natural home is the Platform group beside **Workflow Control**, **System Audit** and **Sentry Check**.

### B. Standard health-check framework — HIGHLY RECOMMENDED

**Today:** each integration proves health differently, or not at all.
**Proposal:** three layers. (1) Outside-in: a free uptime monitor on `/api/healthz` from a second network (INT-066), with an edge-cron probe as a second vantage point (INT-067). (2) Jobs: a database-side freshness alarm per job, with no check cap (INT-068), and a punch-feed alarm (INT-070). (3) Providers: a read-only "can I authenticate" probe per provider, run on demand from the registry, never sending a message.

### C. Integration status dashboard — RECOMMENDED

**Proposal:** the page behind A — status per integration, provider incident from its public status feed, quota used where the provider exposes it. Super Admin only; no secret value displayed. `PROPOSED NEW MODULE — NOT PRESENT IN CURRENT SIDEBAR`.

### D. Centralized error handling — HIGHLY RECOMMENDED

**Today:** 498 application errors in seven days with no view by cause (ISS-055); error types differ by client.
**Proposal:** one outbound client (INT-064) that classifies every failure the same way — timeout, refused, rate-limited, authentication, provider error, bad response — and writes it with the provider name to the existing error log and to Sentry.

### E. Integration observability — RECOMMENDED

**Proposal:** a span per outbound call with provider, route, status and duration into the existing error tracker (INT-056); Core Web Vitals into the existing page-timing table (INT-052); hosted dashboards over the database metrics endpoint only if the team will read them (INT-055, CONDITIONAL).

### F. Credential management — HIGHLY RECOMMENDED

**Today:** the production secret set is mirrored into CI (ISS-054), a service key sits on a laptop by owner decision (ISS-046), a DNS token never expires (ISS-052), keys travel in URLs on three integrations (ISS-053).
**Proposal:** the host is the one home for runtime secrets; CI keeps only what CI uses; encrypted secrets in the repository only through SOPS + age if they must live there (INT-074); database-side secrets in Supabase Vault (INT-076); tripwire tokens beside the real ones (INT-075); a key-redaction rule in the outbound client and the error reporter.

### G. Retry and fallback framework — RECOMMENDED

**Today:** good fallbacks for AI and e-mail; scheduled work that times out at 30 seconds (ISS-002); a drain lock held in process memory (ISS-014).
**Proposal:** bounded retries with jitter in the outbound client (INT-064); long work scheduled from the database (INT-061); a database queue for the notification drain and intake so overlap is impossible (INT-062).

### H. API usage monitoring — RECOMMENDED

**Proposal:** the outbound client counts calls per provider and SKU per day into one table; the registry shows them against each free-tier ceiling (Google Maps per-SKU caps, Healthchecks 20 checks, Brevo 300 a day, WhatsApp 1,000 free service replies). Cost per AI feature only if spend justifies it (INT-101, CONDITIONAL).

### I. Provider abstraction — RECOMMENDED, selectively

**Keep the abstractions that pay:** AI and e-mail already have one door with failover.
**Add one where a switch is planned:** maps (so pin-only boards can move to an open renderer, EX-18) and push (so standard web push can replace the vendor, INT-041).
**Do not abstract** single-provider integrations with no realistic alternative (Telegram, WhatsApp, Railway): an abstraction there is cost without benefit.

### J. Integration documentation — RECOMMENDED

**Proposal:** the registry (A) is the documentation of record; each row links to the provider's official pages and the free-tier page read with its date (as report 14 does). Generated schema documentation (INT-083) for the database side. Two documents that contradict the live configuration are corrected (ISS-057).

## Sequence

| Phase | Content | Recommendations |
|---|---|---|
| 1 — Stop silent failures | Outside-in monitor, freshness alarm for every job, punch alarm, long jobs off the 30-second cut | INT-066, INT-068, INT-070, INT-061 |
| 2 — Close exposures | Secret alert, repository visibility decision, sign-up off, second factor, redirect check on applicant links, security updates on | ISS-023, ISS-021/056, ISS-004, INT-005, ISS-015, INT-089 |
| 3 — Recovery | Nightly encrypted database dump off-site, quarterly restore drill, standby rehearsal | INT-096, INT-097, ISS-038 |
| 4 — One outbound client | Deadlines, retries, error classes, key redaction, usage counts | INT-064, INT-056 |
| 5 — Registry and status page | Registry table, status page (proposed module), provider status feeds | INT-063 |
| 6 — Provider changes | Business-safe tiles, standard web push, one inbound-webhook verifier, removals | INT-021, INT-041, INT-073, EX-10/24/41/45/48/49 |
