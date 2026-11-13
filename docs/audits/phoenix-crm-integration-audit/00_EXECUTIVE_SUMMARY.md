# 00 — Executive Summary

**Phoenix CRM — Enterprise Integration Health, Discovery, Optimization and Expansion Audit**
Web app, revision `56fbe1070` (the revision production served during the audit) · Audit date 13 Nov 2026, 14:10–15:00 Cairo · Read-only: nothing in production was changed, sent, triggered or deployed.

## The landscape

The web app connects to **56 external integrations**: hosting (Railway), the database, sign-in and file store (Supabase), two schedulers, three e-mail senders, Telegram, WhatsApp, web push, Google Maps and four other Google APIs, two paid AI providers with failover, error tracking, an on-premises fingerprint agent, a self-hosted tablet-management server, the company's careers website, GitHub's CI and security tooling, and a handful of retired services that left residue behind. They serve **410 sidebar rows** (Admin 251, HR 72, Employee Portal 87).

## Health

| Class | Count |
|---|---:|
| HEALTHY | 14 |
| HEALTHY WITH WARNINGS | 12 |
| DEGRADED | 1 |
| CRITICAL / FAILED | 0 |
| NOT VERIFIED | 24 |
| NOT APPLICABLE (disabled, planned, retired) | 5 |
| **Total** | **56** |

89 read-only tests were run: PASS 32 · WARNING 33 · FAIL 3 · NOT VERIFIED 12 · NOT APPLICABLE 9. The three failures are a local error-tracking token that is no longer valid, a retired vendor's host that no longer answers, and a migration-drift check that has failed five days running. **24 NOT VERIFIED** is the honest count of integrations whose proof needs a console, a billed call, a sent message or a credential the audit was not allowed to use.

## Critical findings

No CRITICAL finding: no exposed secret in the code tree, no data reachable without sign-in, no money paid wrongly. **57 findings** are registered for separate correction sessions — **HIGH 9 · MEDIUM 21 · LOW 27**. The ones that matter most:

1. **Fingerprint punches can stop with nobody told** (ISS-034). Deductions and payroll are computed from them.
2. **The scheduler records three daily jobs as failed** (ISS-002) because it cuts every call at 30 seconds. The provider disables a job after more than 25 failures in a row, which would silently stop the daily notification run.
3. **No point-in-time recovery and no rehearsed restore** for the payroll database (ISS-009). Seven daily backups are the whole recovery story.
4. **The repository is public** (ISS-021, ISS-056) while its runner guide assumes it is private. Public is also what keeps CI and security scanning free — a trade-off for the owner to decide, set out in report 05.
5. **One secret-scanning alert open since 7 Nov 2026** (ISS-023) and **92 code-scanning alerts open, 72 high** (ISS-022).
6. **The server follows redirects on applicant-supplied links** (ISS-015).
7. **Outside monitoring watches 20 of 49 scheduled jobs** (ISS-001); **nobody has a second factor** (0 of 229 users) and **public sign-up is still on** at the auth provider (ISS-004).

## Main architecture concerns

- Good patterns exist only in places: one door with failover for AI and e-mail, but not for maps or push; signed webhooks for most providers but not all; deadlines on most outbound calls but not seven of them.
- Two schedulers call the same five routes, and the drain's overlap lock lives in process memory.
- There is no single place that says which integrations are live, healthy or near a free-tier ceiling.

## Main cost concerns

No company spending figure was readable, and none is stated. The cost levers found are: fewer and cheaper Google Maps calls (Maps Embed is free with no limit; session tokens; caching), removing dead infrastructure that may still be calling production, avoiding paid monitoring by watching jobs from the database, and the CI waste that costs nothing today only because the repository is public.

## Recommended direction

**Free first, inside what is already paid for.** 117 integration opportunities were researched against the providers' own pricing and licence pages (151 sources, 147 verified): HIGHLY RECOMMENDED 23 · RECOMMENDED 44 · CONDITIONAL 31 · EXPERIMENTAL 8 · NOT RECOMMENDED CURRENTLY 11. By cost class: genuinely free 25, free tier 13, free open source 45, existing infrastructure 20, conditional free 13, excluded 1. 24 of them extend a provider already in use.

The first five to do:

1. **Alarm when fingerprint punches stop arriving** (INT-070) — existing database and Telegram.
2. **Long jobs scheduled from the database** (INT-061) and **a freshness alarm for every job** (INT-068).
3. **Outside-in uptime monitor** (INT-066) — free plan.
4. **Nightly encrypted database dump off-site** (INT-096) with a **quarterly restore drill** (INT-097).
5. **Second factor for privileged roles** (INT-005) and **breached-password check** (INT-006).

The full ranked list is report 08; the plan that keeps recurring cost flat is "PHOENIX CRM — FREE-FIRST TECHNOLOGY OPTIMIZATION PLAN" in report 09; the architecture sequence is report 10.

## The reports

| # | Report |
|---|---|
| 01 | Sidebar module inventory (410 rows) |
| 02 | Existing integrations (56) |
| 03 | Integration health report |
| 04 | Integration dependency map |
| 05 | Security and data-protection findings |
| 06 | Existing integration optimization (KEEP 32 · OPTIMIZE 11 · REMOVE 6 · INVESTIGATE FURTHER 4 · REPLACE 2 · CONSOLIDATE 1) |
| 07 | Free integration opportunities (117) |
| 08 | Top 25 priority integrations |
| 09 | Cost optimization report |
| 10 | Integration architecture roadmap |
| 11 | Remediation and follow-up register (57) |
| 12 | Final audit conclusions |
| 13 | Test execution log (89) |
| 14 | Research sources (151) |
| 15 | Recommendation traceability |

Machine-readable copies: `integration_inventory.csv`, `integration_health_matrix.csv`, `integration_recommendations_100_plus.csv`, `integration_remediation_register.csv`, `sidebar_inventory.csv`. Every table is generated from `scripts/data/` by `scripts/build-reports.mjs`, which refuses to build if a sidebar name, ID or cross-reference does not resolve.
