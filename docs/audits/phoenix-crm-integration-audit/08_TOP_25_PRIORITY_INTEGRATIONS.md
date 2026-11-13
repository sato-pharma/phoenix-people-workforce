# 08 — Top 25 Priority Integrations

Generated from the scored catalogue (07). Ranked by score; ties broken by business value. Recommendations marked EXPERIMENTAL or NOT RECOMMENDED CURRENTLY are not eligible.

**Quick wins** are LOW complexity and two days or less of work. Everything else is an engineering project and is marked so.

| Rank | ID | Integration | Score | Class | Kind | Effort |
|---:|---|---|---:|---|---|---|
| 1 | INT-070 | Alarm when fingerprint punches stop arriving | 89 | F4 | Quick win | 1 day |
| 2 | INT-037 | One-tap approve or reject from Telegram | 87 | F1 | Engineering project | 4 days |
| 3 | INT-003 | Leave and calendar subscription feed (iCalendar) | 87 | F1 | Quick win | 2 days |
| 4 | INT-006 | Breached-password check when a password is set | 86 | F1 | Quick win | 1 day |
| 5 | INT-012 | IBAN validation for employee bank details | 86 | F3 | Quick win | 1 day |
| 6 | INT-033 | Job posts in Google's job search | 85 | F1 | Quick win | 2 days |
| 7 | INT-096 | Nightly encrypted database dump off-site | 84 | F3 | Quick win | 2 days |
| 8 | INT-061 | Long jobs scheduled from the database | 84 | F4 | Quick win | 2 days |
| 9 | INT-066 | Outside-in uptime monitor | 84 | F2 | Quick win | 0.5 day |
| 10 | INT-005 | Authenticator-app second factor (TOTP) for privileged roles | 83 | F4 | Engineering project | 4–5 days |
| 11 | INT-013 | Phone number normalisation and validation | 83 | F3 | Quick win | 2 days |
| 12 | INT-064 | One outbound client: deadlines, retries, key redaction, provider metrics | 82 | F4 | Engineering project | 3 days |
| 13 | INT-002 | vCard contact cards from the employee directory | 82 | F1 | Quick win | 1 day |
| 14 | INT-068 | Database-side freshness alarm for every job | 80 | F4 | Quick win | 2 days |
| 15 | INT-075 | Tripwire tokens beside real credentials | 80 | F1 | Quick win | 0.5 day |
| 16 | INT-089 | Automatic security-fix pull requests | 80 | F2 | Quick win | 0.1 day |
| 17 | INT-042 | Persistent storage for offline drafts | 80 | F1 | Quick win | 0.5 day |
| 18 | INT-043 | Resumable uploads for evidence photos and videos | 79 | F4 | Quick win | 2 days |
| 19 | INT-081 | Workflow lint and security audit | 79 | F3 | Quick win | 0.5 day |
| 20 | INT-097 | Quarterly restore drill into staging | 78 | F4 | Engineering project | 1 day a quarter |
| 21 | INT-016 | Maps Embed for read-only location views | 78 | F1 | Quick win | 2 days |
| 22 | INT-045 | DMARC report reading | 78 | F5 | Quick win | 0.5 day |
| 23 | INT-052 | Core Web Vitals into the existing page-timing table | 78 | F3 | Quick win | 1 day |
| 24 | INT-001 | WhatsApp utility templates for employees with no Telegram | 77 | F5 | Engineering project | 3–4 days |
| 25 | INT-063 | Integration registry fed by provider status feeds | 77 | F4 | Engineering project | 5 days |

## Suggested implementation order

1. **Recovery and silent-failure fixes first** (no user-visible change, highest risk removed): INT-070, INT-096, INT-061, INT-066, INT-005, INT-064, INT-068.
2. **Then the P1 quick wins**: INT-003, INT-006, INT-012, INT-033, INT-013, INT-075, INT-089, INT-081, INT-016.
3. **Then the P1 projects**: INT-037, INT-097, INT-001, INT-063.
4. **Then P2 and P3 in score order**: INT-002, INT-042, INT-043, INT-045, INT-052.

## 1. INT-070 — Alarm when fingerprint punches stop arriving (89/100, P0, quick win)

- **Why it deserves priority:** No one is docked pay for a machine fault. Score 89/100; business value 10/10.
- **Exact affected sidebar modules:** Time & Leave › Fingerprint Report; Payroll › Daily Deductions; Time & Leave › Attendance Exceptions
- **Current problem or limitation:** Nothing watches the age of the newest punch (ISS-034).
- **How the integration solves it:** During working hours, alert HR if the newest punch is older than 45 minutes and hold deduction generation for that day.
- **Without a paid subscription?** F4 — Existing infrastructure. none; Supabase recommends no more than 8 jobs running concurrently and each job under 10 minutes
- **Expected operational benefits:** Removes a wrong-pay path.
- **Implementation difficulty:** LOW, 1 day.
- **Principal risks:** Counts only in the alert. Simple query.
- **Dependencies:** Deduction job reads the hold flag.
- **Suggested implementation order:** Phase 1 (rank 1).

## 2. INT-037 — One-tap approve or reject from Telegram (87/100, P1, engineering project)

- **Why it deserves priority:** Approval turnaround drops from hours to minutes. Score 87/100; business value 9/10.
- **Exact affected sidebar modules:** Approvals Hub › Leave Approvals; Approvals Hub › Excuse Approvals; Approvals Hub › Expense Approvals; Approvals Hub › Plan Approvals
- **Current problem or limitation:** Notices carry inline buttons, but the bot does not handle button presses (no callback handling in code); the manager must open the app.
- **How the integration solves it:** Handle callback queries: match the chat to the linked user, re-check the permission server-side, apply the decision, edit the message to show the result.
- **Without a paid subscription?** F1 — Genuinely free. No fee for normal use. Documented limits: avoid more than one message per second in a single chat (short bursts tolerated, then HTTP 429); in a group, not more than 20 messages per minute; bulk notifications not more than about 30 messages per second overall. Optional Paid Broadcasts raise this to up to 1,000 messages per second at 0.1 Telegram Stars per message above the free 30 per second.
- **Expected operational benefits:** Fewer stalled requests.
- **Implementation difficulty:** MEDIUM, 4 days.
- **Principal risks:** Every press re-checks the user's permission; money-moving decisions stay in the app. Same bot, same webhook route.
- **Dependencies:** Telegram link of the approver.
- **Suggested implementation order:** Phase 3 (rank 2).

## 3. INT-003 — Leave and calendar subscription feed (iCalendar) (87/100, P1, quick win)

- **Why it deserves priority:** Managers plan field coverage around leave they can see beside their meetings. Score 87/100; business value 7/10.
- **Exact affected sidebar modules:** Time & Leave › Leave Management; Time & Leave › Company Calendar; Employee Portal › Private Calendar; Sales › Field Absence Calendar
- **Current problem or limitation:** An ICS feed already exists for interviews; leave and company events are visible only inside the app.
- **How the integration solves it:** A signed per-user feed URL of approved leave (own and team), company events and holidays, refreshed by the calendar app.
- **Without a paid subscription?** F1 — Genuinely free. none
- **Expected operational benefits:** Fewer double-booked visits and coaching days.
- **Implementation difficulty:** LOW, 2 days.
- **Principal risks:** Feed token revocable; event titles carry names and leave type only, never the reason. Same code path as the existing interview feed.
- **Dependencies:** Interview feed module.
- **Suggested implementation order:** Phase 2 (rank 3).

## 4. INT-006 — Breached-password check when a password is set (86/100, P1, quick win)

- **Why it deserves priority:** Removes the easiest credential-stuffing route. Score 86/100; business value 7/10.
- **Exact affected sidebar modules:** Platform › Users & Access; Platform › Test Accounts
- **Current problem or limitation:** No strength or breach check exists (code search).
- **How the integration solves it:** k-anonymity range query: only the first five characters of the SHA-1 hash leave the server.
- **Without a paid subscription?** F1 — Genuinely free. Free: 'The Pwned Passwords API is freely accessible without the need for a subscription and API key.' 'There is no rate limit on the Pwned Passwords API.' k-anonymity range search sends only the first 5 characters of the SHA-1 (or NTLM) hash.
- **Expected operational benefits:** Fewer weak passwords on payroll accounts.
- **Implementation difficulty:** LOW, 1 day.
- **Principal risks:** The password never leaves the server; only a 5-character hash prefix does. One server call in the set-password route.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 2 (rank 4).

## 5. INT-012 — IBAN validation for employee bank details (86/100, P1, quick win)

- **Why it deserves priority:** Fewer returned salary transfers. Score 86/100; business value 7/10.
- **Exact affected sidebar modules:** People › Employees; Payroll › Automated Payroll; Payroll › Payroll — Finance
- **Current problem or limitation:** Bank details are free text (code search found no check).
- **How the integration solves it:** Check country format and check digits on entry and in the payroll export.
- **Without a paid subscription?** F3 — Free open source. none (self-hosted); it validates the IBAN format and check digits only, it does not confirm the account exists
- **Expected operational benefits:** Each bounced transfer avoided saves a pay delay.
- **Implementation difficulty:** LOW, 1 day.
- **Principal risks:** Runs locally; nothing leaves. Plain TypeScript.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 2 (rank 5).

## 6. INT-033 — Job posts in Google's job search (85/100, P1, quick win)

- **Why it deserves priority:** More applicants without paid boards. Score 85/100; business value 8/10.
- **Exact affected sidebar modules:** Hiring › Job Posts; Hiring › Recruitment
- **Current problem or limitation:** Job posts are published to the company site and shared by hand; no structured data (code search).
- **How the integration solves it:** JobPosting markup on each public post; Indexing API ping on publish and close.
- **Without a paid subscription?** F1 — Genuinely free. none for the vocabulary. Whether a search engine actually shows a posting depends on that engine's own structured-data rules - not checked here.
- **Expected operational benefits:** Free applicant flow.
- **Implementation difficulty:** LOW, 2 days.
- **Principal risks:** Public job data only. Server-rendered page already exists.
- **Dependencies:** A service account with Indexing API access.
- **Suggested implementation order:** Phase 2 (rank 6).

## 7. INT-096 — Nightly encrypted database dump off-site (84/100, P0, quick win)

- **Why it deserves priority:** Recovery that does not depend on one provider. Score 84/100; business value 10/10.
- **Exact affected sidebar modules:** Platform › Data Backup
- **Current problem or limitation:** 7 provider-held daily backups, no point-in-time recovery, no own copy (ISS-009).
- **How the integration solves it:** Nightly logical dump on the existing backup job, encrypted, to the existing Drive target or R2.
- **Without a paid subscription?** F3 — Free open source. none (the storage provider it copies to has its own costs)
- **Expected operational benefits:** Real disaster recovery.
- **Implementation difficulty:** LOW, 2 days.
- **Principal risks:** Encrypted before leaving; key held offline. 3.8 GB database; dump fits the nightly window.
- **Dependencies:** Storage space.
- **Suggested implementation order:** Phase 1 (rank 7).

## 8. INT-061 — Long jobs scheduled from the database (84/100, P0, quick win)

- **Why it deserves priority:** Daily notification run stops being recorded as failed; the 'disable after 25 failures' risk disappears. Score 84/100; business value 9/10.
- **Exact affected sidebar modules:** Platform › Workflow Control; People › Mailbox Revocation; Platform › Email Control Center
- **Current problem or limitation:** Three daily jobs time out at the external scheduler's 30-second cap; nine more run within 13 s of it (ISS-002).
- **How the integration solves it:** pg_cron fires an asynchronous pg_net request to the job route; the response is logged in the database, so no caller waits.
- **Without a paid subscription?** F4 — Existing infrastructure. none; the docs mark the pg_net API as beta (function signatures may change); requests are asynchronous
- **Expected operational benefits:** 3 failing jobs fixed; 9 protected.
- **Implementation difficulty:** LOW, 2 days.
- **Principal risks:** Cron secret stored in the database vault, not in SQL text. pg_cron already runs 8 jobs with 0 failures (T-SB-09); pg_net is beta per its docs.
- **Dependencies:** INT-076.
- **Suggested implementation order:** Phase 1 (rank 8).

## 9. INT-066 — Outside-in uptime monitor (84/100, P0, quick win)

- **Why it deserves priority:** Outages measured, not guessed. Score 84/100; business value 8/10.
- **Exact affected sidebar modules:** Overview › Command Center
- **Current problem or limitation:** No outside monitor; 4 of 10 connections failed from one network (ISS-003).
- **How the integration solves it:** Five-minute checks of healthz and readyz with Telegram alerts.
- **Without a paid subscription?** F2 — Free tier. Free: 50 monitors, 5-minute monitoring interval, 1 status page on an UptimeRobot URL. Cheapest paid plan (Solo): about $9/month billed annually ($10 monthly shown), 10 monitors, 60-second interval.
- **Expected operational benefits:** Availability history and alerts.
- **Implementation difficulty:** LOW, 0.5 day.
- **Principal risks:** Probes public health endpoints only. Public endpoints already exist.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 1 (rank 9).

## 10. INT-005 — Authenticator-app second factor (TOTP) for privileged roles (83/100, P0, engineering project)

- **Why it deserves priority:** A stolen password alone no longer opens payroll. Score 83/100; business value 9/10.
- **Exact affected sidebar modules:** Platform › Users & Access; Payroll › Payroll Report; Payroll › CEO Payroll View
- **Current problem or limitation:** 0 of 229 users have a second factor (T-SB-15); passkeys exist but are optional.
- **How the integration solves it:** Enrol a TOTP factor in the existing auth provider and require assurance level 2 on payroll and admin routes.
- **Without a paid subscription?** F4 — Existing infrastructure. No new charge; consumes existing database or host capacity.
- **Expected operational benefits:** Closes the largest account-takeover path to salary data.
- **Implementation difficulty:** MEDIUM, 4–5 days.
- **Principal risks:** Recovery codes and a reset path owned by the Super Admin. Same auth provider; server checks the session's assurance level.
- **Dependencies:** A recovery procedure.
- **Suggested implementation order:** Phase 1 (rank 10).

## 11. INT-013 — Phone number normalisation and validation (83/100, P1, quick win)

- **Why it deserves priority:** Fewer failed WhatsApp sends and duplicate candidates. Score 83/100; business value 7/10.
- **Exact affected sidebar modules:** Hiring › Missing Contact Details; Hiring › WhatsApp Applicants; People › Employees; Master Data › Customer Directory
- **Current problem or limitation:** Numbers arrive as typed; WhatsApp matching depends on hand-written clean-up (code search: no library).
- **How the integration solves it:** Parse and format to E.164 on every form and import; mark mobile vs landline.
- **Without a paid subscription?** F3 — Free open source. none (self-hosted)
- **Expected operational benefits:** Higher candidate match rate.
- **Implementation difficulty:** LOW, 2 days.
- **Principal risks:** Local only. Plain TypeScript; small metadata build available.
- **Dependencies:** A one-off clean-up of stored numbers.
- **Suggested implementation order:** Phase 2 (rank 11).

## 12. INT-064 — One outbound client: deadlines, retries, key redaction, provider metrics (82/100, P0, engineering project)

- **Why it deserves priority:** A slow provider no longer hangs a page. Score 82/100; business value 7/10.
- **Exact affected sidebar modules:** INTERNAL COMPONENT — NO SIDEBAR ENTRY
- **Current problem or limitation:** Seven call sites have no timeout (ISS-011); keys travel in URLs on three integrations (ISS-053).
- **How the integration solves it:** A wrapper used by every integration: default 10 s deadline, retry on 429/5xx with backoff, redaction of keys in logs, counters per provider.
- **Without a paid subscription?** F4 — Existing infrastructure. No new charge; consumes existing database or host capacity.
- **Expected operational benefits:** Closes ISS-011 and ISS-053.
- **Implementation difficulty:** LOW, 3 days.
- **Principal risks:** Positive. Plain TypeScript.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 1 (rank 12).

## 13. INT-002 — vCard contact cards from the employee directory (82/100, P2, quick win)

- **Why it deserves priority:** Fewer wrong numbers between reps, managers and HR. Score 82/100; business value 5/10.
- **Exact affected sidebar modules:** HR sidebar › Employee Directory; Hiring › Business Cards; Overview › Organogram
- **Current problem or limitation:** Directory rows are read on screen; numbers are copied by hand. No vCard output exists (code search).
- **How the integration solves it:** A server route that returns text/vcard for one employee or a team, honouring the viewer's scope.
- **Without a paid subscription?** F1 — Genuinely free. none (phone address books vary in which vCard version they import best - not read today)
- **Expected operational benefits:** Saves minutes per new hire; fewer contact errors.
- **Implementation difficulty:** LOW, 1 day.
- **Principal risks:** Same permission check as the directory; personal mobile numbers only where the directory already shows them. Plain route handler; no library needed.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 4 (rank 13).

## 14. INT-068 — Database-side freshness alarm for every job (80/100, P0, quick win)

- **Why it deserves priority:** Every job watched, independently of the app. Score 80/100; business value 8/10.
- **Exact affected sidebar modules:** Platform › Workflow Control; Platform › System Audit
- **Current problem or limitation:** 20 of 49 enabled jobs are watched from outside (ISS-001); the in-app sweep cannot alarm if the app is down.
- **How the integration solves it:** A pg_cron job compares each heartbeat with its expected period and sends a Telegram alert through pg_net.
- **Without a paid subscription?** F4 — Existing infrastructure. none; Supabase recommends no more than 8 jobs running concurrently and each job under 10 minutes
- **Expected operational benefits:** 29 silent-failure paths closed.
- **Implementation difficulty:** LOW, 2 days.
- **Principal risks:** Bot token in the database vault. Needs each job's period in the registry.
- **Dependencies:** INT-061, INT-076.
- **Suggested implementation order:** Phase 1 (rank 14).

## 15. INT-075 — Tripwire tokens beside real credentials (80/100, P1, quick win)

- **Why it deserves priority:** Early warning of the worst breach. Score 80/100; business value 7/10.
- **Exact affected sidebar modules:** BACKGROUND SERVICE — NO SIDEBAR ENTRY
- **Current problem or limitation:** The production service key sits in a laptop file (ISS-046); nothing would reveal a copy.
- **How the integration solves it:** Place fake AWS-key and URL tokens in the env folder and repository secrets; alerts go to the owner.
- **Without a paid subscription?** F1 — Genuinely free. FREE STATUS NOT VERIFIED CONFIDENCE WARNING — pricing or licence not verified from an official page in this audit.
- **Expected operational benefits:** Detection where none exists.
- **Implementation difficulty:** LOW, 0.5 day.
- **Principal risks:** Tokens are fake by design. No code change.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 2 (rank 15).

## 16. INT-089 — Automatic security-fix pull requests (80/100, P1, quick win)

- **Why it deserves priority:** Days removed from exposure. Score 80/100; business value 6/10.
- **Exact affected sidebar modules:** BACKGROUND SERVICE — NO SIDEBAR ENTRY
- **Current problem or limitation:** Security updates are disabled; version updates run weekly (ISS-024).
- **How the integration solves it:** Turn on Dependabot security updates.
- **Without a paid subscription?** F2 — Free tier. Dependabot alerts, security updates, version updates and the dependency graph are listed under 'Available for all GitHub plans' ('regardless of the GitHub plan you are on'); the pricing page marks security and version updates 'Included' on Free with no public-only qualifier. Dependabot runs on standard GitHub-hosted or self-hosted runners 'does not count towards your included GitHub Actions minutes' (larger runners are billed). Not on Free: custom auto-triage rules, the dependency review action. Assigning alerts needs a GitHub Code Security licence. The CI runs that each Dependabot PR triggers do use Actions minutes (Free plan: 2,000 minutes/month for private repositories).
- **Expected operational benefits:** Faster patching.
- **Implementation difficulty:** LOW, 0.1 day.
- **Principal risks:** Positive. Already configured for version updates.
- **Dependencies:** Owner's word (repository setting).
- **Suggested implementation order:** Phase 2 (rank 16).

## 17. INT-042 — Persistent storage for offline drafts (80/100, P2, quick win)

- **Why it deserves priority:** No lost visits on full phones. Score 80/100; business value 5/10.
- **Exact affected sidebar modules:** Employee Portal › Phoenix CRM; Employee Portal › Submit Expense
- **Current problem or limitation:** Drafts live in IndexedDB without a persistence request (code search).
- **How the integration solves it:** Request persistent storage once drafts exist; warn if refused.
- **Without a paid subscription?** F1 — Genuinely free. MDN: 'Baseline — Widely available ... available across browsers since December 2021.' Secure context only. Compatibility data: persist() and persisted() - Chrome 55, Firefox 57, Safari 15.2 (iOS 15.2); estimate() - Chrome 61, Firefox 57, Safari 17 (iOS 17). persist() resolves to true only 'if the user agent is able to persist your site's storage' - the browser may refuse.
- **Expected operational benefits:** Fewer lost drafts.
- **Implementation difficulty:** LOW, 0.5 day.
- **Principal risks:** Local only. Widely available.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 4 (rank 17).

## 18. INT-043 — Resumable uploads for evidence photos and videos (79/100, P2, quick win)

- **Why it deserves priority:** Fewer failed evidence uploads. Score 79/100; business value 6/10.
- **Exact affected sidebar modules:** Orders & CRM › Verified Captures; Orders & CRM › Visit Recording; Employee Portal › Submit Expense
- **Current problem or limitation:** Uploads restart from zero on failure.
- **How the integration solves it:** Use the storage service's resumable endpoint for files above 6 MB.
- **Without a paid subscription?** F4 — Existing infrastructure. Libraries: none. Supabase side, as its docs state: Storage 'implements the TUS protocol'; recommended for files that may exceed 6MB; chunk size 'must be set to 6MB (for now)'; the upload URL is 'valid for up to 24 hours'. The page states no maximum file size or plan limit (those sit with the Supabase plan and were not read here).
- **Expected operational benefits:** Higher upload success.
- **Implementation difficulty:** LOW, 2 days.
- **Principal risks:** Same bucket policies. Supported by the current storage service.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 4 (rank 18).

## 19. INT-081 — Workflow lint and security audit (79/100, P1, quick win)

- **Why it deserves priority:** Workflow bugs and over-permission caught pre-merge. Score 79/100; business value 6/10.
- **Exact affected sidebar modules:** BACKGROUND SERVICE — NO SIDEBAR ENTRY
- **Current problem or limitation:** Two workflows hold write scopes at workflow level; a cache key reads an empty variable (ISS-025, ISS-048).
- **How the integration solves it:** Run both on every workflow change.
- **Without a paid subscription?** F3 — Free open source. none
- **Expected operational benefits:** Closes a class of CI risk.
- **Implementation difficulty:** LOW, 0.5 day.
- **Principal risks:** Positive — a public repository makes workflow injection a real path. Fast, no setup.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 2 (rank 19).

## 20. INT-097 — Quarterly restore drill into staging (78/100, P1, engineering project)

- **Why it deserves priority:** A tested recovery time. Score 78/100; business value 9/10.
- **Exact affected sidebar modules:** Platform › Data Backup
- **Current problem or limitation:** No restore has been rehearsed.
- **How the integration solves it:** Restore the latest dump (INT-096) into staging, run row-count and checksum checks, record the time.
- **Without a paid subscription?** F4 — Existing infrastructure. Pro: from $25/month per organization, includes $10/month compute credits (one Micro instance); 8 GB disk per project then $0.125/GB; 100 GB file storage then $0.0213/GB; 250 GB egress then $0.09/GB plus 250 GB cached egress then $0.03/GB; 100,000 MAU then $0.00325/MAU; Realtime 500 concurrent peak connections then $10 per 1,000, and 5 million messages then $2.50 per million; Edge Functions 2 million invocations then $2 per million; daily backups stored 7 days (Team 14); log retention 7 days (Team 28); max file upload 500 GB (Free 50 MB). Quotas are per organization except disk, which is per project; compute is billed per project. Add-ons: PITR $100/month per 7 days retention ($0.137/hour; 14 days ~$200, 28 days ~$400); Log Drains $60 per drain per month ($0.0822/hour) + $0.20 per million events + $0.09/GB egress, available on Pro, Team and Enterprise; Branching $0.01344 per branch per hour; Image transformations Pro and above, 100 origin images included then $5 per 1,000; Advanced MFA (phone) $75/month first project then $10 per additional; custom domain $10/month per project. Basic Multi-Factor Auth: included on Free, Pro, Team. Leaked password protection: Pro and above. Metrics endpoint: Not included on Free, Included on Pro and Team (docs: Metrics API is in beta, HTTP Basic auth with service_role + secret key at /customer/v1/privileged/metrics).
- **Expected operational benefits:** Known recovery time.
- **Implementation difficulty:** MEDIUM, 1 day a quarter.
- **Principal risks:** Real data in staging during the drill — restrict access, wipe after. Staging must be wiped and re-seeded after; vault secrets do not move (INT-076).
- **Dependencies:** INT-096.
- **Suggested implementation order:** Phase 3 (rank 20).

## 21. INT-016 — Maps Embed for read-only location views (78/100, P1, quick win)

- **Why it deserves priority:** Lower Maps bill at the same screens. Score 78/100; business value 6/10.
- **Exact affected sidebar modules:** Approvals Hub › Expense Approvals; Orders & CRM › Place Checks; Orders & CRM › Pharmacy Validation
- **Current problem or limitation:** Approval and review screens render billed static-map images and JavaScript maps.
- **How the integration solves it:** Use the no-charge Embed API iframe where the view is read-only.
- **Without a paid subscription?** F1 — Genuinely free. 'Maps Embed usage is available at no charge.' 'There are no short-term (queries per second) or long-term (queries per day) limits on the Maps Embed API.' The pricing table lists the Embed SKU as Unlimited with no paid tier. Modes: place, view, directions, streetview, search - no per-mode charge is listed.
- **Expected operational benefits:** Billed map loads on approval screens fall to zero.
- **Implementation difficulty:** LOW, 2 days.
- **Principal risks:** Key restricted to the Embed API and the company domain. Needs a frame-src entry in the content-security policy.
- **Dependencies:** CSP change.
- **Suggested implementation order:** Phase 2 (rank 21).

## 22. INT-045 — DMARC report reading (78/100, P2, quick win)

- **Why it deserves priority:** Spoofing and broken senders become visible. Score 78/100; business value 5/10.
- **Exact affected sidebar modules:** Platform › Mailbox Compliance; Platform › Email Delivery
- **Current problem or limitation:** DMARC is at p=reject with aggregate reports to a mailbox (T-DNS-01); nobody reads them.
- **How the integration solves it:** Turn on the free report view in the existing Cloudflare account.
- **Without a paid subscription?** F5 — Conditional free. 'Available on all plans' (includes Free). No report-volume limit stated on the page read.
- **Expected operational benefits:** Early warning on spoofing.
- **Implementation difficulty:** LOW, 0.5 day.
- **Principal risks:** Reports hold sending IPs only. Domain already on Cloudflare DNS.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 4 (rank 22).

## 23. INT-052 — Core Web Vitals into the existing page-timing table (78/100, P2, quick win)

- **Why it deserves priority:** Slow pages ranked by real user pain. Score 78/100; business value 5/10.
- **Exact affected sidebar modules:** Platform › System Audit; Platform › Activity Control
- **Current problem or limitation:** Page timing is recorded; the standard LCP, INP and CLS measures are not (code search).
- **How the integration solves it:** Report the three metrics into the existing intake.
- **Without a paid subscription?** F3 — Free open source. FREE STATUS NOT VERIFIED CONFIDENCE WARNING — pricing or licence not verified from an official page in this audit.
- **Expected operational benefits:** Targeted performance work.
- **Implementation difficulty:** LOW, 1 day.
- **Principal risks:** No personal data. Existing intake route.
- **Dependencies:** None.
- **Suggested implementation order:** Phase 4 (rank 23).

## 24. INT-001 — WhatsApp utility templates for employees with no Telegram (77/100, P1, engineering project)

- **Why it deserves priority:** Approvals stop stalling on people the platform cannot reach. Score 77/100; business value 9/10.
- **Exact affected sidebar modules:** Platform › Notification Recipients; Platform › Notification Confidence; Approvals Hub › Leave Approvals
- **Current problem or limitation:** Telegram reaches 54 of 229 users; 4,669 notices were skipped in seven days (T-DL-02). WhatsApp is live for hiring only.
- **How the integration solves it:** Pre-approved utility templates (approval waiting, deadline tomorrow) sent from the existing business number to employees who have no Telegram link and no live push device.
- **Without a paid subscription?** F5 — Conditional free. Not free: Egypt utility rate 0.0036 USD per template message (verified 13 Nov 2026); service replies free up to 1,000 a month per number since 1 Oct 2026.
- **Expected operational benefits:** Skipped notices fall toward zero for opted-in staff.
- **Implementation difficulty:** LOW, 3–4 days.
- **Principal risks:** Message text must carry no salary or medical detail; phone numbers are already held. Same API, number and webhook already in production.
- **Dependencies:** Template approval by Meta; opt-in recorded per employee.
- **Suggested implementation order:** Phase 3 (rank 24).

## 25. INT-063 — Integration registry fed by provider status feeds (77/100, P1, engineering project)

- **Why it deserves priority:** First question in every incident answered in seconds. Score 77/100; business value 7/10.
- **Exact affected sidebar modules:** PROPOSED NEW MODULE — NOT PRESENT IN CURRENT SIDEBAR
- **Current problem or limitation:** Nobody can tell from the code which optional integrations are live (ISS-039); provider incidents are learned from users.
- **How the integration solves it:** A registry table plus a job that reads each provider's public status feed and the app's own last-success times.
- **Without a paid subscription?** F4 — Existing infrastructure. No new charge; consumes existing database or host capacity.
- **Expected operational benefits:** Faster incident triage.
- **Implementation difficulty:** MEDIUM, 5 days.
- **Principal risks:** Shows configured / not configured, never a value. Fits under Platform; no secret values shown.
- **Dependencies:** INT-064.
- **Suggested implementation order:** Phase 3 (rank 25).
