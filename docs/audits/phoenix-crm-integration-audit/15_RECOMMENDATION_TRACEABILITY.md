# 15 — Recommendation Traceability

For each recommendation: the evidence that the need is real, the findings it answers, the existing integration it touches and the sources behind its price and licence.

| ID | Integration | Need shown by | Answers findings | Touches existing | Price / licence sources | Recommendation |
|---|---|---|---|---|---|---|
| INT-001 | WhatsApp utility templates for employees with no Telegram | T-DL-02 | — | — | whatsapp-cloud-pricing | RECOMMENDED |
| INT-002 | vCard contact cards from the employee directory | code search (see Current situation in 07) | — | — | vcard | RECOMMENDED |
| INT-003 | Leave and calendar subscription feed (iCalendar) | code search (see Current situation in 07) | — | — | icalendar | HIGHLY RECOMMENDED |
| INT-004 | Open Badges for coaching, training and milestones | code search (see Current situation in 07) | — | — | open-badges | CONDITIONAL |
| INT-005 | Authenticator-app second factor (TOTP) for privileged roles | T-SB-15 | — | — | official docs (price not verified) | HIGHLY RECOMMENDED |
| INT-006 | Breached-password check when a password is set | code search (see Current situation in 07) | — | — | hibp-pwned-passwords | HIGHLY RECOMMENDED |
| INT-007 | Trusted timestamps on accepted offers, resignations and signed forms | code search (see Current situation in 07) | — | — | rfc3161, freetsa | RECOMMENDED |
| INT-008 | Digitally signed payslips and HR letters (PAdES) | code search (see Current situation in 07) | — | — | signpdf, pades | CONDITIONAL |
| INT-009 | Self-hosted e-signature for contracts and renewals | code search (see Current situation in 07) | — | — | docuseal | CONDITIONAL |
| INT-010 | Exit and pulse surveys | code search (see Current situation in 07) | — | — | formbricks | CONDITIONAL |
| INT-011 | Egyptian Tax Authority e-invoice lookup for supplier invoices | code search (see Current situation in 07) | — | — | eta-einvoice | CONDITIONAL |
| INT-012 | IBAN validation for employee bank details | code search (see Current situation in 07) | — | — | ibantools | HIGHLY RECOMMENDED |
| INT-013 | Phone number normalisation and validation | code search (see Current situation in 07) | — | — | libphonenumber-js | HIGHLY RECOMMENDED |
| INT-014 | Drug label and adverse-event reference lookup | code search (see Current situation in 07) | — | — | openfda | CONDITIONAL |
| INT-015 | ICH E2B(R3) case export for adverse-drug-reaction reports | code search (see Current situation in 07) | — | — | e2b-r3 | RECOMMENDED |
| INT-016 | Maps Embed for read-only location views | code search (see Current situation in 07) | — | — | google-maps-embed | HIGHLY RECOMMENDED |
| INT-017 | Plus codes for pharmacies and clinics without a street address | code search (see Current situation in 07) | — | — | open-location-code | RECOMMENDED |
| INT-018 | Hexagon grid for coverage heat-maps | code search (see Current situation in 07) | — | — | h3-js | RECOMMENDED |
| INT-019 | One geospatial library for distance and boundary checks | code search (see Current situation in 07) | — | — | turf | RECOMMENDED |
| INT-020 | Official administrative boundaries for governorates and districts | code search (see Current situation in 07) | — | — | geoboundaries | RECOMMENDED |
| INT-021 | Business-safe tile source for the Location Integrity board | code search (see Current situation in 07) | ISS-012 | — | openfreemap | HIGHLY RECOMMENDED |
| INT-022 | Open map renderer with a self-hosted Egypt tile file | code search (see Current situation in 07) | ISS-012 | — | maplibre-gl-js, pmtiles | RECOMMENDED |
| INT-023 | Spatial database for territories, bricks and visit checks | code search (see Current situation in 07) | — | — | postgis | RECOMMENDED |
| INT-024 | Daily visit route suggestions | code search (see Current situation in 07) | — | — | openrouteservice | RECOMMENDED |
| INT-025 | Self-hosted road distances for outstation claims | code search (see Current situation in 07) | — | — | osrm | CONDITIONAL |
| INT-026 | Self-hosted geocoder for Egyptian addresses | ISS-039 | ISS-039 | — | photon | EXPERIMENTAL |
| INT-027 | OpenStreetMap pharmacy and clinic points for validation | code search (see Current situation in 07) | — | — | osm-overpass | CONDITIONAL |
| INT-028 | Street-level imagery for place checks | code search (see Current situation in 07) | — | — | mapillary | EXPERIMENTAL |
| INT-029 | Public reverse-geocoding fallback | code search (see Current situation in 07) | — | — | nominatim-public | CONDITIONAL |
| INT-030 | Product barcode scanning for stock counts and orders | code search (see Current situation in 07) | — | — | barcode, barcode-detection-api | RECOMMENDED |
| INT-031 | Background sync for visits recorded offline | code search (see Current situation in 07) | — | — | background-sync | CONDITIONAL |
| INT-032 | Offline app shell for field pages | code search (see Current situation in 07) | — | — | workbox | RECOMMENDED |
| INT-033 | Job posts in Google's job search | code search (see Current situation in 07) | — | — | jobposting-schema, google-for-jobs | HIGHLY RECOMMENDED |
| INT-034 | Turnstile in place of reCAPTCHA on the public application | code search (see Current situation in 07) | — | — | cloudflare-turnstile, google-recaptcha | CONDITIONAL |
| INT-035 | Searchable scans of hiring documents | code search (see Current situation in 07) | — | — | ocrmypdf | CONDITIONAL |
| INT-036 | Candidate self-booking of interview slots | code search (see Current situation in 07) | — | — | cal-com | CONDITIONAL |
| INT-037 | One-tap approve or reject from Telegram | code search (see Current situation in 07) | — | — | telegram-bot-api | HIGHLY RECOMMENDED |
| INT-038 | Scheduled report files delivered in Telegram | code search (see Current situation in 07) | — | — | telegram-bot-api | CONDITIONAL |
| INT-039 | Pending-approval count on the app icon | code search (see Current situation in 07) | — | — | badging-api | EXPERIMENTAL |
| INT-040 | Share a receipt photo straight into Submit Expense | code search (see Current situation in 07) | — | — | web-share-target | EXPERIMENTAL |
| INT-041 | App-owned service worker and standard web push | ISS-031 | ISS-031 | — | web-push, web-push-api | RECOMMENDED |
| INT-042 | Persistent storage for offline drafts | code search (see Current situation in 07) | — | — | storage-manager | HIGHLY RECOMMENDED |
| INT-043 | Resumable uploads for evidence photos and videos | code search (see Current situation in 07) | — | — | tus | RECOMMENDED |
| INT-044 | Inbound address on a sub-domain for CV intake | code search (see Current situation in 07) | — | — | cloudflare-email-routing | CONDITIONAL |
| INT-045 | DMARC report reading | T-DNS-01 | — | — | cloudflare-dmarc | HIGHLY RECOMMENDED |
| INT-046 | Gmail deliverability dashboard | code search (see Current situation in 07) | — | — | google-postmaster | RECOMMENDED |
| INT-047 | Self-hosted video meetings for interviews | ISS-039 | ISS-039 | — | jitsi | NOT RECOMMENDED CURRENTLY |
| INT-048 | Looker Studio reports on a read-only reporting role | code search (see Current situation in 07) | — | — | looker-studio | CONDITIONAL |
| INT-049 | Self-hosted analytics for the management team | EX-55 | — | — | metabase | CONDITIONAL |
| INT-050 | In-browser analysis of large exports | code search (see Current situation in 07) | — | — | duckdb-wasm | EXPERIMENTAL |
| INT-051 | Privacy-first page analytics | EX-56 | — | — | cloudflare-web-analytics | NOT RECOMMENDED CURRENTLY |
| INT-052 | Core Web Vitals into the existing page-timing table | code search (see Current situation in 07) | — | — | official docs (price not verified) | RECOMMENDED |
| INT-053 | Performance and accessibility budget in CI | code search (see Current situation in 07) | — | — | lighthouse-ci | RECOMMENDED |
| INT-054 | Accessibility checks inside the Playwright journeys | code search (see Current situation in 07) | — | — | axe-core | RECOMMENDED |
| INT-055 | Hosted metrics dashboards from the database metrics endpoint | code search (see Current situation in 07) | — | — | grafana-cloud-free | CONDITIONAL |
| INT-056 | Per-provider spans in the existing error tracker | code search (see Current situation in 07) | — | — | opentelemetry-js, otlp | RECOMMENDED |
| INT-057 | Drive change notifications instead of polling CV folders | code search (see Current situation in 07) | — | — | official docs (price not verified) | CONDITIONAL |
| INT-058 | Push-style mailbox intake with IMAP IDLE | code search (see Current situation in 07) | — | — | official docs (price not verified) | EXPERIMENTAL |
| INT-059 | Sign-in gate in front of staging | T-RW-03 | — | — | official docs (price not verified) | RECOMMENDED |
| INT-060 | Unusual sign-in location flags | code search (see Current situation in 07) | — | — | dbip-lite | RECOMMENDED |
| INT-061 | Long jobs scheduled from the database | ISS-002 | ISS-002 | — | pg_net, pg_cron | HIGHLY RECOMMENDED |
| INT-062 | Database queue for the notification drain and intake | ISS-014 | ISS-014 | — | pgmq | RECOMMENDED |
| INT-063 | Integration registry fed by provider status feeds | ISS-039 | ISS-039 | — | official docs (price not verified) | RECOMMENDED |
| INT-064 | One outbound client: deadlines, retries, key redaction, provider metrics | ISS-011, ISS-053 | ISS-011, ISS-053 | — | official docs (price not verified) | HIGHLY RECOMMENDED |
| INT-065 | Cloudflare proxy in front of production | code search (see Current situation in 07) | — | — | cloudflare-free-proxy | CONDITIONAL |
| INT-066 | Outside-in uptime monitor | ISS-003 | ISS-003 | — | uptimerobot | HIGHLY RECOMMENDED |
| INT-067 | Second-vantage health probe from the edge | code search (see Current situation in 07) | ISS-003 | — | cloudflare-workers-cron | RECOMMENDED |
| INT-068 | Database-side freshness alarm for every job | ISS-001 | ISS-001 | — | pg_cron | HIGHLY RECOMMENDED |
| INT-069 | Self-hosted heartbeat server with no check limit | code search (see Current situation in 07) | ISS-001 | — | official docs (price not verified) | CONDITIONAL |
| INT-070 | Alarm when fingerprint punches stop arriving | ISS-034 | ISS-034 | — | pg_cron | HIGHLY RECOMMENDED |
| INT-071 | Off-site copy of storage buckets | ISS-009 | ISS-009 | — | cloudflare-r2 | RECOMMENDED |
| INT-072 | Hosted HTTP job queue | code search (see Current situation in 07) | — | — | upstash-qstash | NOT RECOMMENDED CURRENTLY |
| INT-073 | One verification helper for every inbound webhook | ISS-013 | ISS-013 | — | standard-webhooks | HIGHLY RECOMMENDED |
| INT-074 | One encrypted home for runtime secrets | ISS-054 | ISS-054 | — | sops, age | RECOMMENDED |
| INT-075 | Tripwire tokens beside real credentials | ISS-046 | ISS-046 | — | canarytokens | RECOMMENDED |
| INT-076 | Encrypted secrets inside the database | code search (see Current situation in 07) | — | — | supabase_vault | RECOMMENDED |
| INT-077 | Security-header scan in CI | T-RW-06 | — | — | mozilla-observatory | RECOMMENDED |
| INT-078 | Unused files, exports and packages scan | ISS-045 | ISS-045 | — | knip | RECOMMENDED |
| INT-079 | Vulnerability scan of the lockfile against the OSV database | code search (see Current situation in 07) | — | — | osv-scanner | RECOMMENDED |
| INT-080 | Container image scan | code search (see Current situation in 07) | — | — | trivy | RECOMMENDED |
| INT-081 | Workflow lint and security audit | ISS-025, ISS-048 | ISS-025, ISS-048 | — | actionlint, zizmor | HIGHLY RECOMMENDED |
| INT-082 | Migration safety lint | ISS-016 | ISS-016 | — | squawk | RECOMMENDED |
| INT-083 | Generated schema documentation | code search (see Current situation in 07) | — | — | tbls | RECOMMENDED |
| INT-084 | Database tests for grants and access helpers | T-SB-19 | — | — | pgtap | HIGHLY RECOMMENDED |
| INT-085 | Static check of 570 database functions | code search (see Current situation in 07) | — | — | plpgsql_check | RECOMMENDED |
| INT-086 | In-process Postgres for fast tests | code search (see Current situation in 07) | — | — | pglite | EXPERIMENTAL |
| INT-087 | Local mail catcher | code search (see Current situation in 07) | — | — | mailpit | RECOMMENDED |
| INT-088 | On-company transcription for dictated notes | ISS-040 | ISS-040 | — | whisper-cpp | CONDITIONAL |
| INT-089 | Automatic security-fix pull requests | ISS-024 | ISS-024 | — | dependabot | HIGHLY RECOMMENDED |
| INT-090 | Load tests on staging before payroll day | code search (see Current situation in 07) | — | — | k6 | CONDITIONAL |
| INT-091 | Passive security scan of staging | code search (see Current situation in 07) | — | — | owasp-zap | RECOMMENDED |
| INT-092 | Content-security-policy violation reports | code search (see Current situation in 07) | — | — | csp-reporting, sentry-csp | RECOMMENDED |
| INT-093 | security.txt contact file | T-RW-07 | — | — | security-txt | HIGHLY RECOMMENDED |
| INT-094 | Audit log of privileged database sessions | code search (see Current situation in 07) | — | — | pgaudit | RECOMMENDED |
| INT-095 | Personal-data redaction before AI calls | code search (see Current situation in 07) | — | — | presidio | CONDITIONAL |
| INT-096 | Nightly encrypted database dump off-site | ISS-009 | ISS-009 | — | rclone, age | HIGHLY RECOMMENDED |
| INT-097 | Quarterly restore drill into staging | code search (see Current situation in 07) | ISS-009 | — | supabase-pricing | HIGHLY RECOMMENDED |
| INT-098 | Index advice for slow queries | ISS-050 | ISS-050 | — | index_advisor, hypopg | RECOMMENDED |
| INT-099 | Time-partitioned log tables | code search (see Current situation in 07) | — | — | pg_partman | CONDITIONAL |
| INT-100 | Schema checks on JSON columns | code search (see Current situation in 07) | — | — | pg_jsonschema | RECOMMENDED |
| INT-101 | Tracing and cost per AI feature | code search (see Current situation in 07) | — | — | langfuse | CONDITIONAL |
| INT-102 | Regression tests for AI prompts | code search (see Current situation in 07) | — | — | promptfoo | RECOMMENDED |
| INT-103 | Semantic search over CVs and customer names | code search (see Current situation in 07) | — | — | pgvector | CONDITIONAL |
| INT-104 | On-company text embeddings, Arabic included | code search (see Current situation in 07) | — | — | transformers-js | CONDITIONAL |
| INT-105 | Moderation of public free text | code search (see Current situation in 07) | — | — | openai-pricing-note | CONDITIONAL |
| INT-106 | Local large language model | code search (see Current situation in 07) | — | — | ollama | NOT RECOMMENDED CURRENTLY |
| INT-107 | Free-tier AI model as a third fallback | code search (see Current situation in 07) | — | — | gemini-free-tier | NOT RECOMMENDED CURRENTLY |
| INT-108 | Receipt reading on expense submission | code search (see Current situation in 07) | — | — | tesseract-js | RECOMMENDED |
| INT-109 | Visual workflow automation server | code search (see Current situation in 07) | — | — | n8n | NOT RECOMMENDED CURRENTLY |
| INT-110 | Malware scan of uploaded files | code search (see Current situation in 07) | — | — | clamav, file-type | CONDITIONAL |
| INT-111 | Document archive server | code search (see Current situation in 07) | — | — | paperless-ngx | NOT RECOMMENDED CURRENTLY |
| INT-112 | Hosted uptime and status page | code search (see Current situation in 07) | — | — | betterstack | NOT RECOMMENDED CURRENTLY |
| INT-113 | Public-holiday API | T-GC-01 | — | — | nager-date | NOT RECOMMENDED CURRENTLY |
| INT-114 | Data-quality checks on closing inputs | code search (see Current situation in 07) | — | — | soda-core | EXPERIMENTAL |
| INT-115 | PDF rendering service | EX-50 | — | — | gotenberg | NOT RECOMMENDED CURRENTLY |
| INT-116 | Second alarm channel | code search (see Current situation in 07) | — | — | ntfy | NOT RECOMMENDED CURRENTLY |
| INT-117 | Multi-location API checks | code search (see Current situation in 07) | — | — | checkly | CONDITIONAL |
