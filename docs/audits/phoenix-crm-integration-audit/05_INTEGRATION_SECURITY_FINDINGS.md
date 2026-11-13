# 05 — Integration Security and Data-Protection Findings

The web app holds employee, payroll, recruitment and field-visit data for a real company. This report covers where that data goes, how each integration authenticates, and which findings carry security weight. Every finding here is also in the remediation register (report 11) with its evidence; nothing was fixed during the audit, no credential was rotated or copied, and no secret value appears anywhere in this folder.

## 1. Overall position

**What is strong**

- **Secrets stay on the server.** Every provider key except the public map key is read server-side only. The content-security policy uses a per-request nonce, HSTS is two years with preload, and framing is denied (verified on a live production response, T-RW-06).
- **Storage is private.** All 31 storage buckets are private; the browser gets short-lived signed URLs only.
- **Inbound webhooks are mostly signed.** Resend (HMAC with a 5-minute window), WhatsApp (SHA-256 HMAC) and Telegram (secret-token header, refused when unset in production) verify every call. All 50 scheduled routes check their secret with a timing-safe compare.
- **AI traffic has one door.** OpenAI and Anthropic are reached through one module with a host allow-list pinned by a test.
- **Mail authentication is strict.** DMARC is at `p=reject`, SPF ends in `-all`, and MTA-STS and TLS-RPT are published (T-DNS-01).
- **The repository's own controls are good.** Secret scanning and push protection are on, the default workflow token is read-only, fork pull requests need approval for external contributors, and all third-party actions are pinned to a commit.

**What needs attention** — nine HIGH and a group of MEDIUM findings, below. None is CRITICAL: no secret was found exposed in the tree, no data reachable without sign-in, and no unauthorised access observed.

## 2. Findings with security weight

| ID | Severity | Finding | Why it matters |
|---|---|---|---|
| ISS-023 | HIGH | One secret-scanning alert open since 7 Nov 2026 (a token pattern in a test file, validity unknown) | If real, it is published; if a fixture, it trains everyone to ignore the next alert |
| ISS-021 | HIGH | The repository is public while the self-hosted runner guide assumes it is private | Following the guide would let a fork's pull request run code on a company machine |
| ISS-056 | HIGH | The schema history, access model and operations notes of a live payroll system are publicly readable | An attacker starts with the blueprint |
| ISS-015 | HIGH | The server fetches applicant-supplied document links and follows redirects | A redirect that leaves the allow-list could reach private network hosts |
| ISS-022 | HIGH | 92 code-scanning alerts open, 72 rated high, nothing gates on them | Real defects are hidden among false positives |
| ISS-009 | HIGH | No point-in-time recovery and no rehearsed restore for the payroll database | Recovery is untested; up to a day of payroll data could be lost |
| ISS-004 | MEDIUM | Public sign-up is still enabled at the authentication provider | An account the company never issued could be created; row policies are the only barrier |
| — (T-SB-15) | MEDIUM | 0 of 229 users have a second factor | A stolen password alone opens payroll and approvals (INT-005) |
| ISS-013 | MEDIUM | The backup e-mail provider's webhook trusts a shared secret with no signature or replay window | A leaked secret lets anyone forge delivery events |
| ISS-025 | MEDIUM | Two workflows grant write scopes to every job, including pull-request runs | A compromised dependency in a PR build could publish an image |
| ISS-035 | MEDIUM | An attendance agent token is handed to the browser on one admin page | Any admin who opens the page can copy it |
| ISS-046 | MEDIUM | The production service key and database URL sit in a file on a laptop | Recorded owner decision (local development points at production); a lost laptop is a full breach unless the disk is encrypted |
| ISS-054 | MEDIUM | The whole production secret set is mirrored into CI secrets | CI becomes a second home for every production credential |
| ISS-024 | MEDIUM | Dependabot security updates are off; three medium alerts open | Fixes do not arrive as pull requests |
| ISS-005, 006, 051 | LOW | Database surface: 3 tables with row security off (no grants), a set of invoker-rights functions callable by the anonymous role (no table grants behind them), 283 tables with row security on and no policy | Not reachable today; the real access model is application code and the role sweep tests, so one stray grant is the risk |
| ISS-052, 053, 041 | LOW | A non-expiring DNS token with no user; provider keys in URLs on three integrations; two unused AI hops accept a configurable destination | Standing credentials and leak paths with no benefit |

Function and table names behind ISS-005 and ISS-006 are in the evidence of report 11 only, not repeated here.

## 3. The public-repository trade-off

The repository being public is not a simple defect. It is what makes the CI runners unmetered and keeps secret scanning, push protection and code scanning free; on a private repository those last three are paid products (verified on GitHub's own pages, report 14). The decision is the owner's:

| Option | Gains | Costs |
|---|---|---|
| Stay public | Free CI minutes and free security scanning | Every document in the tree is published; runbooks must say so; a self-hosted runner must never be attached |
| Go private | The blueprint is no longer public | Secret scanning and code scanning stop unless paid for; CI minutes are capped on the free plan |

Either way, the runner guide must be corrected now (ISS-021).

## 4. Where data leaves the app (§16)

"Leaves" means data sent to a provider's servers. Retention and processing terms are those the provider publishes; where they were not read in this audit the cell says NOT VERIFIED.

| Provider (integration) | What leaves | Personal data? | Credential exposed to the browser? | Retention configurable? | Access restriction | Provider audit log | Fit for business use | Legal review needed |
|---|---|---|---|---|---|---|---|---|
| Supabase (EX-05/06/07/08) | Everything — it is the database, sign-in and file store | Yes, all categories, payroll included | No — service key server-only | Backups 7 days (plan); data under company control | Project roles; service key on the server | Platform logs | Yes (EU region) | Yes — processor of all employee data |
| Railway (EX-01) | Application runtime and logs | Yes, in memory and in logs | No | Log retention per plan — NOT VERIFIED | Project membership | NOT VERIFIED | Yes (EU region, pinned) | Yes |
| OpenAI (EX-21) | Prompts: thread summaries, drafted e-mails, CV screening text, sales text | Yes — names and CV content can appear | No | Provider API policy — NOT VERIFIED in this audit | One server key | Usage dashboard | Yes (API terms) | Yes — CV content and employee names |
| Anthropic (EX-22) | The same prompts, as failover | Yes | No | Provider API policy — NOT VERIFIED | One server key | Console | Yes | Yes |
| Groq (EX-23) | Dictated voice clips (one browser path) | Possibly — doctor or employee names spoken | No | NOT VERIFIED | One server key | NOT VERIFIED | NOT VERIFIED | Yes (ISS-040) |
| Resend, Brevo, Turbify (EX-25/26/27) | E-mail recipients, subjects and bodies | Yes | No | Provider logs — NOT VERIFIED | Send-only key (Resend); mailbox passwords (Turbify) | Delivery events stored in the app | Yes | Yes |
| Telegram (EX-29) | Notice text to 54 linked users | Yes — names and request details in notices | No | Messages stay in users' chats | Bot token server-only | None beyond the app's own log | Yes for notices | Yes |
| Meta WhatsApp (EX-31) | Candidate messages and templates | Yes — candidates' phone numbers and names | No | Meta policy — NOT VERIFIED | Signed webhook | Meta business manager | Yes | Yes |
| OneSignal (EX-30) | Device push identifiers and notice text | Limited | No (public app id only) | Vendor — NOT VERIFIED | REST key server-only | Vendor dashboard | Yes, with a vendor script in the worker scope | Yes |
| Google Maps (EX-17/18) | Addresses, coordinates of pharmacies and visits | Location of field staff can be inferred | The browser map key is public by design; its referrer restriction is NOT VERIFIED | Google terms | Key restrictions — NOT VERIFIED (console not read) | Cloud console | Yes | Yes — field location data |
| Google Drive, Sheets (EX-33/34) | CV files; report rows to managers' sheets | Yes | No | Under company Google account | OAuth / service account | Google Workspace audit | Yes | Yes |
| Sentry (EX-32) | Error reports, traces, replays on error (text and inputs masked) | Limited — URLs, user ids | DSN only (public by design) | Per plan — NOT VERIFIED | Org membership | Sentry audit log — NOT VERIFIED | Yes (EU region) | Yes |
| GitHub (EX-12/14) | Source code and CI secrets — no employee data found in the tree | No employee data | n/a | Under company control | Repository roles | Organisation audit log | Yes | No for code; yes for the secret mirror (ISS-054) |
| Google Drive backup (EX-53) | Encrypted code archive | No — encrypted before it leaves | No | Company-controlled | Restore key kept off the host | Google | Yes | No |
| OpenStreetMap tiles, Google Fonts (EX-20/45) | Reader's IP address and referrer | IP only | No | Provider | n/a | n/a | Tile policy does not cover business use (ISS-012) | Low |
| Cloudflare (EX-46), Healthchecks.io (EX-04), cron-job.org (EX-03) | DNS queries; job pings; scheduled calls carrying a secret | No | No | Provider | Account | Provider | Yes | No |

**Not sent anywhere:** first-party telemetry (EX-56), the document libraries (EX-52), headless Chromium (EX-50) and the exchange-rate lookup (EX-44) send no personal data.

## 5. Rules for every new integration in this audit

- **No real employee records to a public service for testing.** Every recommendation that needs test data says synthetic data.
- **Personal data to an AI provider goes through the one AI door**, and a redaction step (INT-095) is listed as CONDITIONAL until volume justifies it.
- **Free tiers that train on submitted content are excluded** — the Gemini free tier is NOT RECOMMENDED CURRENTLY for that reason (INT-107).
- **Recommendations that would add a processor of personal data** carry the legal-review flag in report 07's security line.

## 6. Egyptian data protection — legal review

Egypt's Personal Data Protection Law (Law No. 151 of 2020) governs the processing of personal data, including transfers outside Egypt. Most of the providers above process employee and candidate data outside Egypt (EU and US regions). This audit does not give a legal opinion: whether the current transfers, the AI processing of CVs, the field location data and the WhatsApp candidate messages need registration, consent wording, a licence or contract clauses is a question for legal counsel. **Legal review is recommended before any new processor of personal data is added.**
