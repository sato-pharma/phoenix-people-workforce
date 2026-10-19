// Railway Infrastructure as Code for Phoenix-HR-Workforce.
//
// 🔴 OWNER DECISION, 2026-10-10: THE 2026-10-01 HOLD ("leave the railway IaC inert for now") IS
// LIFTED, AND BOTH APPLIES ARE DONE — `phoenix-people-workforce` at 01:35 Cairo, `phoenix-headwind` at
// 01:51. The hold ended on his
// words, never on the 2026-12-01 deadline. Every further apply still needs his word, because it is a
// production change that does not pass the deploy gate. See docs/deployment.md, "The first apply".
//
// 🔴 `railway.toml` STAYS. The apply stored the healthcheck but Railway never stores the restart
// policy, so a plan shows `restartPolicyType` / `restartPolicyMaxRetries` as pending forever and the toml
// is the only thing enforcing them (owner, 2026-10-10: "keep railway.toml until the restart policy is
// stored"). An apply also REDEPLOYS the service, rebuilding the same commit.
//
// 🔴 THIS FILE IS THE AUTHORING FILE for the cutover away from `railway.json` / `railway.toml`, which
// Railway deprecated with existing files working until 2026-12-01; nothing applies it automatically.
// Per `.railway/README.md`, "services already managed by railway.json must be migrated before
// .railway/railway.ts can manage them", so each apply is reviewed from this file in git rather than
// generated on the spot at the moment of pressing.
//
// 🔴 HOW TO APPLY IT, AND WHY NOT `railway config migrate`. Measured 2026-10-01: `migrate --apply`
// translates only the two toml files and emits a WHOLE-PROJECT definition naming 2 services after
// DIRECTORIES, while the project holds 4 plus a 50 GB volume and three custom domains — and
// `.railway/README.md` states that "ordinary whole-project applies can delete omitted resources". It
// also silently drops the restart policy it is migrating. This file came from `railway config pull`
// instead, which reads the live project, with the deploy blocks added by hand below.
//
//   railway config plan --out railway-plan.json    # read it; an apply in an agent session needs
//   railway config apply --plan railway-plan.json  #   --confirm-destructive, Railway's own admission
//                                                  #   that this can delete
//
// An apply is a production infrastructure change that does NOT pass through the deploy gate, so it
// needs the owner's word the way a migration does. Only after it succeeds should the two railway.toml
// files be deleted and tests/railway-deploy-config.test.ts updated — that test still pins the root one.
//
// 🔴 VARIABLES ARE `preserve()`, so no secret value is written to source and existing values are kept.
// But IaC then owns variable EXISTENCE: dropping a name from a block here deletes it on the next
// apply. Regenerate with `railway config pull` rather than editing the env lists by hand.
//
// 🔴 AND THAT MAKES THIS FILE PERISHABLE — RE-PULL IMMEDIATELY BEFORE PLANNING, NEVER TRUST THE
// COMMITTED LIST. Measured 2026-10-10, nine days after the pull above: `phoenix-people-workforce`
// had grown from 94 variable names to 107, so an apply from the file as committed would have DELETED
// thirteen live production variables — `RESEND_API_KEY_2`/`_3`, `RESEND_EMAIL_FROM_2`/`_3` and
// `RESEND_WEBHOOK_SECRET_2`/`_3` (the sender rotation), `RECRUITMENT_APPLY_RECAPTCHA_SECRET` and its
// `_MIN_SCORE`, the three `PHOENIX_TURBIFY_*` switches, `PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD` and
// `NEXT_PUBLIC_SMI_USE_FACT_TABLES`. The list below was refreshed from a `railway config pull --json`
// read on that date; the other three services had not drifted at all. Thirteen names in nine days is
// the rate to plan against: whoever applies this re-pulls first, in the same sitting.
//
// The twelve `RAILWAY_*` names the platform injects are deliberately absent — `pull` omits them,
// because they are not the project's to own.
//
// 🔴 WHAT RAILWAY ACTUALLY READS TODAY IS `railway.toml`, AND THE BUILD LOG IS WHERE THAT IS VISIBLE.
// Read on 2026-10-10 off the serving revision's own build: `Starting Healthcheck / Path: /api/readyz
// / Retry window: 5m0s / [1/1] Healthcheck succeeded!`, while `config pull` shows the live service
// storing NO `healthcheckPath` and NO restart policy at all. So the deploy block below is not a
// convenience — it is the only copy of the readiness gate that would survive the cutover, and a
// `pull` that overwrites this file silently removes it. The same build log carries the deprecation
// warning and its `Existing files keep working until 2026-12-01`.
//
// Field names were verified against railway@3.12.0's own DeployConfig/IntentServiceConfig types, not
// inferred — inventing a field is how the auto-migration lost the restart policy without saying so.
import { defineRailway, github, image, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const headwindDbEuVolume = volume("headwind-db-eu-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 50000 });
  const phoenixCron = service("phoenix-cron", {
    source: image("alpine:3"),
    start: "apk add --no-cache curl >/dev/null 2>&1; M=$(date -u +%M); H=$(date -u +%H); D=$(date -u +%u); echo \"cron tick ${H}:${M} dow=${D}\"; h(){ curl -sS -m 300 -o /dev/null -w \"$1 -> %{http_code}\\n\" -H \"Authorization: Bearer $CRON_SECRET\" \"$APP_URL/$1\"; }; h \"api/notifications/process?limit=50\"; h \"api/cron/inbound-intake\"; case \"$M\" in 00|10|20|30|40|50) h \"api/cron/recruitment-email-intake\";; esac; case \"$H\" in 08|09|10|11|12) case \"$M\" in 00|15|30|45) h \"api/cron/ireports360-visits-live-sync\";; esac;; esac; if [ \"$H\" = \"06\" ] && [ \"$M\" = \"35\" ]; then h \"api/notifications/daily\"; fi; case \"$H\" in 09|12|19) if [ \"$M\" = \"05\" ]; then h \"api/cron/ireports360-visits-sync\"; fi;; esac; if [ \"$D\" = \"7\" ] && [ \"$H\" = \"04\" ] && [ \"$M\" = \"25\" ]; then h \"api/cron/ireports360-visits-reconcile\"; fi; if [ \"$D\" = \"5\" ] && [ \"$H\" = \"03\" ] && [ \"$M\" = \"00\" ]; then h \"api/cron/background-jobs?limit=10\"; fi; echo \"cron done\"; exit 0",
    replicas: { "sfo": 1 },
    deploy: { restartPolicyType: "NEVER" },
    env: { APP_URL: preserve(), CRON_REBUILD: preserve(), CRON_SECRET: preserve() },
  });
  const phoenixPeopleWorkforce = service("phoenix-people-workforce", {
    // 🔴 THE LIVE SOURCE ALSO CARRIES `branch: "main"`, AND THIS LINE DOES NOT SAY SO. Read from
    // `config pull` on 2026-10-10. It is left as the pull rendered it rather than written in by
    // hand, because an invented field is how the auto-migration lost the restart policy — but the
    // source branch is the 2026-08-13 incident (production silently pointing at a stale branch,
    // five merged green PRs stranded with nothing red), so whoever plans the apply CONFIRMS the
    // branch in the plan output before applying, and never leaves it to a default.
    // 🔴 `checkSuites: false` IS THE TARGET STATE OF THE RELEASE GATE (2026-10-19), NOT YET WHAT IS LIVE: live reads
    // `true` until the owner switches Wait for CI off (docs/deployment.md, "The release gate"). With it off Railway
    // builds the moment a commit lands and /api/readyz holds the new container until ci.yml's `release-gate` job has
    // recorded that the required checks passed. An apply of this file BEFORE that is safe only once the gate has
    // been live for a deploy; like every apply it needs his word, and the variable list below goes stale in days.
    source: github("Gawish-1997/phoenix-people-workforce", { checkSuites: false }),
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["phoenix-hr.satopharma.com"],
    // From railway.toml, which a pull cannot see: config-as-code is applied at DEPLOY time and is
    // not stored as a service setting. Omitting these leaves production with no readiness gate.
    deploy: {
      healthcheckPath: "/api/readyz",
      healthcheckTimeout: 900,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: { ACTION1_API_BASE_URL: preserve(), ACTION1_CLIENT_ID: preserve(), ACTION1_CLIENT_SECRET: preserve(), ACTION1_ORG_ID: preserve(), ANDROID_MANAGEMENT_ENTERPRISE_NAME: preserve(), ANDROID_MANAGEMENT_KEY: preserve(), ANDROID_MANAGEMENT_PROJECT_ID: preserve(), APP_ENV: preserve(), APP_URL: preserve(), ATTENDANCE_AGENT_BROWSER_TOKEN: preserve(), ATTENDANCE_AGENT_TOKEN: preserve(), BREVO_API_KEY: preserve(), BREVO_EMAIL_FROM: preserve(), BREVO_WEBHOOK_SECRET: preserve(), CLOUDFLARE_API_TOKEN: preserve(), CRON_SECRET: preserve(), CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET: preserve(), CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL: preserve(), EMAIL_NOTIFICATIONS_ENABLED: preserve(), FTP_VIDEO_HANDOFF_SECRET: preserve(), GITHUB_ACTIONS_DISPATCH_TOKEN: preserve(), GOOGLE_CALENDAR_API_KEY: preserve(), GOOGLE_DRIVE_OAUTH_CLIENT_ID: preserve(), GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: preserve(), GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: preserve(), GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID: preserve(), GOOGLE_HOLIDAY_CALENDAR_ID_EG: preserve(), GOOGLE_MAPS_SERVER_KEY: preserve(), GROQ_API_KEY: preserve(), HEADWIND_MDM_BASE_URL: preserve(), HEADWIND_MDM_LOGIN: preserve(), HEADWIND_MDM_PASSWORD: preserve(), HEALTHCHECKS_PING_KEY: preserve(), HR_NOTIFICATION_EMAILS: preserve(), IREPORTS360_BASE_URL: preserve(), IREPORTS360_PASSWORD: preserve(), IREPORTS360_TIMEOUT_MS: preserve(), IREPORTS360_USERNAME: preserve(), JOB_OFFER_EMAIL_FROM: preserve(), LOCATIONIQ_API_KEY: preserve(), MAILBOX_MONITOR_SECRET: preserve(), MANAGEENGINE_MDM_CLIENT_ID: preserve(), MANAGEENGINE_MDM_CLIENT_SECRET: preserve(), MANAGEENGINE_MDM_REFRESH_TOKEN: preserve(), MARKETING_SHEET_REFRESH_WEBHOOK_SECRET: preserve(), MARKETING_SHEET_REFRESH_WEBHOOK_URL: preserve(), MASTER_MAP_SYNC_TOKEN: preserve(), NEXT_PUBLIC_APP_URL: preserve(), NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: preserve(), NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID: preserve(), NEXT_PUBLIC_ONESIGNAL_APP_ID: preserve(), NEXT_PUBLIC_SENTRY_DSN: preserve(), NEXT_PUBLIC_SMI_USE_FACT_TABLES: preserve(), NEXT_PUBLIC_SUPABASE_ANON_KEY: preserve(), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: preserve(), NEXT_PUBLIC_SUPABASE_URL: preserve(), NOTIFICATION_DASHBOARD_URL: preserve(), NOTIFICATION_EMAIL_FROM: preserve(), NOTIFICATION_WEBHOOK_SECRET: preserve(), ONESIGNAL_REST_API_KEY: preserve(), OPENAI_API_KEY: preserve(), PHOENIX_ALLOWED_ORIGINS: preserve(), PHOENIX_APP_URL: preserve(), PHOENIX_AUTH_SECRET: preserve(), PHOENIX_CLOSING_LOCK_PASSWORD: preserve(), PHOENIX_EXPENSE_CLAIMS_READ: preserve(), PHOENIX_LIVE_CRM_POLL: preserve(), PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD: preserve(), PHOENIX_PROCESS_ROLE: preserve(), PHOENIX_STRICT_SUPABASE_BRIDGE: preserve(), PHOENIX_TURBIFY_ADMIN_PASSWORD: preserve(), PHOENIX_TURBIFY_ADMIN_USER: preserve(), PHOENIX_TURBIFY_JOINER_DRY_RUN: preserve(), PHOENIX_TURBIFY_JOINER_ENABLED: preserve(), PHOENIX_TURBIFY_REPORT_CONTROLS: preserve(), PHOENIX_TURBIFY_ROBOT_ENABLED: preserve(), RECRUITMENT_APPLY_RECAPTCHA_MIN_SCORE: preserve(), RECRUITMENT_APPLY_RECAPTCHA_SECRET: preserve(), RECRUITMENT_APPLY_WHATSAPP_NUMBER: preserve(), RECRUITMENT_EMAIL_IMPORT_SENDERS: preserve(), RECRUITMENT_EMAIL_INBOXES_JSON: preserve(), RECRUITMENT_WHATSAPP_CLASSIFY_ENABLED: preserve(), RECRUITMENT_WHATSAPP_DIRECT_INTAKE: preserve(), RECRUITMENT_WHATSAPP_IMPORT_SENDERS: preserve(), RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS: preserve(), RESEND_API_KEY: preserve(), RESEND_API_KEY_2: preserve(), RESEND_API_KEY_3: preserve(), RESEND_EMAIL_FROM_2: preserve(), RESEND_EMAIL_FROM_3: preserve(), RESEND_WEBHOOK_SECRET: preserve(), RESEND_WEBHOOK_SECRET_2: preserve(), RESEND_WEBHOOK_SECRET_3: preserve(), SENTRY_AUTH_TOKEN: preserve(), SENTRY_DSN: preserve(), SHEET_REFRESH_WEBHOOK_SECRET: preserve(), SHEET_REFRESH_WEBHOOK_URL: preserve(), SUPABASE_PROJECT_ID: preserve(), SUPABASE_PROJECT_REF: preserve(), SUPABASE_SERVICE_ROLE_KEY: preserve(), TELEGRAM_BOT_TOKEN: preserve(), TELEGRAM_BOT_USERNAME: preserve(), WHATSAPP_ACCESS_TOKEN: preserve(), WHATSAPP_APP_SECRET: preserve(), WHATSAPP_PHONE_NUMBER_ID: preserve(), WHATSAPP_PHONE_NUMBER_IDS: preserve(), WHATSAPP_WEBHOOK_VERIFY_TOKEN: preserve(), ZOOM_ACCOUNT_ID: preserve(), ZOOM_CLIENT_ID: preserve(), ZOOM_CLIENT_SECRET: preserve(), ZOOM_HOST_USER: preserve() },
  });
  // The worker: the same image as the app, running the background jobs so the page server never freezes
  // under them (owner, 2026-10-16: "Separate worker service"; src/lib/platform/process-role.ts). Created
  // 2026-10-16 by hand, not by an apply, so this block was written from the live service the same day.
  // Every variable but PHOENIX_PROCESS_ROLE and PHOENIX_LIVE_CRM_POLL is a Railway REFERENCE to the
  // app's own (`${{phoenix-people-workforce.NAME}}`), so the GitHub → Railway secret sync, which writes
  // the app, reaches the worker with nothing to keep in step. Its Railway-generated domain
  // (phoenix-workforce-worker-production.up.railway.app) is what the moved cron-job.org jobs call; a
  // re-pull before any apply must show it, or the apply would drop it and those jobs would fail.
  const phoenixWorkforceWorker = service("phoenix-workforce-worker", {
    // Target state, as on the app above: the worker runs the same /api/readyz, so it is held by the same release gate.
    source: github("Gawish-1997/phoenix-people-workforce", { checkSuites: false }),
    replicas: { "europe-west4-drams3a": 1 },
    deploy: {
      healthcheckPath: "/api/readyz",
      healthcheckTimeout: 900,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: { ACTION1_API_BASE_URL: preserve(), ACTION1_CLIENT_ID: preserve(), ACTION1_CLIENT_SECRET: preserve(), ACTION1_ORG_ID: preserve(), ANDROID_MANAGEMENT_ENTERPRISE_NAME: preserve(), ANDROID_MANAGEMENT_KEY: preserve(), ANDROID_MANAGEMENT_PROJECT_ID: preserve(), APP_ENV: preserve(), APP_URL: preserve(), ATTENDANCE_AGENT_BROWSER_TOKEN: preserve(), ATTENDANCE_AGENT_TOKEN: preserve(), BREVO_API_KEY: preserve(), BREVO_EMAIL_FROM: preserve(), BREVO_WEBHOOK_SECRET: preserve(), CLOUDFLARE_API_TOKEN: preserve(), CRON_SECRET: preserve(), CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET: preserve(), CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL: preserve(), EMAIL_NOTIFICATIONS_ENABLED: preserve(), FTP_VIDEO_HANDOFF_SECRET: preserve(), GITHUB_ACTIONS_DISPATCH_TOKEN: preserve(), GOOGLE_CALENDAR_API_KEY: preserve(), GOOGLE_DRIVE_OAUTH_CLIENT_ID: preserve(), GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: preserve(), GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: preserve(), GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID: preserve(), GOOGLE_HOLIDAY_CALENDAR_ID_EG: preserve(), GOOGLE_MAPS_SERVER_KEY: preserve(), GROQ_API_KEY: preserve(), HEADWIND_MDM_BASE_URL: preserve(), HEADWIND_MDM_LOGIN: preserve(), HEADWIND_MDM_PASSWORD: preserve(), HEALTHCHECKS_PING_KEY: preserve(), HR_NOTIFICATION_EMAILS: preserve(), IREPORTS360_BASE_URL: preserve(), IREPORTS360_PASSWORD: preserve(), IREPORTS360_TIMEOUT_MS: preserve(), IREPORTS360_USERNAME: preserve(), JOB_OFFER_EMAIL_FROM: preserve(), LOCATIONIQ_API_KEY: preserve(), MAILBOX_MONITOR_SECRET: preserve(), MANAGEENGINE_MDM_CLIENT_ID: preserve(), MANAGEENGINE_MDM_CLIENT_SECRET: preserve(), MANAGEENGINE_MDM_REFRESH_TOKEN: preserve(), MARKETING_SHEET_REFRESH_WEBHOOK_SECRET: preserve(), MARKETING_SHEET_REFRESH_WEBHOOK_URL: preserve(), MASTER_MAP_SYNC_TOKEN: preserve(), NEXT_PUBLIC_APP_URL: preserve(), NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: preserve(), NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID: preserve(), NEXT_PUBLIC_ONESIGNAL_APP_ID: preserve(), NEXT_PUBLIC_SENTRY_DSN: preserve(), NEXT_PUBLIC_SMI_USE_FACT_TABLES: preserve(), NEXT_PUBLIC_SUPABASE_ANON_KEY: preserve(), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: preserve(), NEXT_PUBLIC_SUPABASE_URL: preserve(), NOTIFICATION_DASHBOARD_URL: preserve(), NOTIFICATION_EMAIL_FROM: preserve(), NOTIFICATION_WEBHOOK_SECRET: preserve(), ONESIGNAL_REST_API_KEY: preserve(), OPENAI_API_KEY: preserve(), PHOENIX_ALLOWED_ORIGINS: preserve(), PHOENIX_APP_URL: preserve(), PHOENIX_AUTH_SECRET: preserve(), PHOENIX_CLOSING_LOCK_PASSWORD: preserve(), PHOENIX_EXPENSE_CLAIMS_READ: preserve(), PHOENIX_LIVE_CRM_POLL: preserve(), PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD: preserve(), PHOENIX_PROCESS_ROLE: preserve(), PHOENIX_STRICT_SUPABASE_BRIDGE: preserve(), PHOENIX_TURBIFY_ADMIN_PASSWORD: preserve(), PHOENIX_TURBIFY_ADMIN_USER: preserve(), PHOENIX_TURBIFY_JOINER_DRY_RUN: preserve(), PHOENIX_TURBIFY_JOINER_ENABLED: preserve(), PHOENIX_TURBIFY_REPORT_CONTROLS: preserve(), PHOENIX_TURBIFY_ROBOT_ENABLED: preserve(), RECRUITMENT_APPLY_RECAPTCHA_MIN_SCORE: preserve(), RECRUITMENT_APPLY_RECAPTCHA_SECRET: preserve(), RECRUITMENT_APPLY_WHATSAPP_NUMBER: preserve(), RECRUITMENT_EMAIL_IMPORT_SENDERS: preserve(), RECRUITMENT_EMAIL_INBOXES_JSON: preserve(), RECRUITMENT_WHATSAPP_CLASSIFY_ENABLED: preserve(), RECRUITMENT_WHATSAPP_DIRECT_INTAKE: preserve(), RECRUITMENT_WHATSAPP_IMPORT_SENDERS: preserve(), RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS: preserve(), RESEND_API_KEY: preserve(), RESEND_API_KEY_2: preserve(), RESEND_API_KEY_3: preserve(), RESEND_API_KEY_4: preserve(), RESEND_API_KEY_PEOPLE: preserve(), RESEND_API_KEY_SALES: preserve(), RESEND_EMAIL_FROM_2: preserve(), RESEND_EMAIL_FROM_3: preserve(), RESEND_EMAIL_FROM_4: preserve(), RESEND_EMAIL_FROM_PEOPLE: preserve(), RESEND_EMAIL_FROM_SALES: preserve(), RESEND_WEBHOOK_SECRET: preserve(), RESEND_WEBHOOK_SECRET_2: preserve(), RESEND_WEBHOOK_SECRET_3: preserve(), RESEND_WEBHOOK_SECRET_4: preserve(), RESEND_WEBHOOK_SECRET_PEOPLE: preserve(), RESEND_WEBHOOK_SECRET_SALES: preserve(), SENTRY_AUTH_TOKEN: preserve(), SENTRY_DSN: preserve(), SENTRY_WEBHOOK_SECRET: preserve(), SHEET_REFRESH_WEBHOOK_SECRET: preserve(), SHEET_REFRESH_WEBHOOK_URL: preserve(), SUPABASE_PROJECT_ID: preserve(), SUPABASE_PROJECT_REF: preserve(), SUPABASE_SERVICE_ROLE_KEY: preserve(), TELEGRAM_BOT_TOKEN: preserve(), TELEGRAM_BOT_USERNAME: preserve(), WHATSAPP_ACCESS_TOKEN: preserve(), WHATSAPP_APP_SECRET: preserve(), WHATSAPP_PHONE_NUMBER_ID: preserve(), WHATSAPP_PHONE_NUMBER_IDS: preserve(), WHATSAPP_WEBHOOK_VERIFY_TOKEN: preserve(), ZOOM_ACCOUNT_ID: preserve(), ZOOM_CLIENT_ID: preserve(), ZOOM_CLIENT_SECRET: preserve(), ZOOM_HOST_USER: preserve() },
  });
  const phoenixHeadwind = service("phoenix-headwind", {
    source: github("Gawish-1997/phoenix-people-workforce", { checkSuites: false, rootDirectory: "infra/headwind-phoenix-actions" }),
    // 🔴 DOCKERFILE, the owner's decision on 2026-10-01, NOT the RAILPACK that `config pull` read
    // from the live service. Its own railway.toml has always said DOCKERFILE, and that Dockerfile is
    // what extends the pinned image with lock, lost mode, factory reset and screen-lock reset - four
    // capabilities that REFUSE on the stock image. Pinning RAILPACK here would build the stock image
    // and ~100 rep tablets would quietly lose them.
    //
    // 🔴 watchPatterns IS LOAD-BEARING: without it every merge to `main` rebuilds the MDM server and
    // every tablet loses its check-in channel (docs/deployment.md, Infrastructure).
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["infra/headwind-phoenix-actions/**"],
    },
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["mdm-console.satopharma.com", "mdm.satopharma.com"],
    // From infra/headwind-phoenix-actions/railway.toml - applied at deploy time, never stored.
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 },
    // JAVA_TOOL_OPTIONS caps the Tomcat JVM heap (-Xmx768m, owner cost cuts 2026-10-14: the service held 60.6% of the project's memory-minutes at ~0 vCPU). preserve() keeps it, because dropping a name here deletes the variable on the next apply.
    env: { ADMIN_EMAIL: preserve(), BASE_DOMAIN: preserve(), HEADWIND_IMAGE_TAG: preserve(), JAVA_TOOL_OPTIONS: preserve(), PROTOCOL: preserve(), SQL_BASE: preserve(), SQL_HOST: preserve(), SQL_PASS: preserve(), SQL_PORT: preserve(), SQL_USER: preserve() },
  });
  const headwindDbEu = service("headwind-db-eu", {
    source: image("ghcr.io/railwayapp-templates/postgres-ssl:18"),
    replicas: { "europe-west4-drams3a": 1 },
    volumeMounts: { "/var/lib/postgresql/data": headwindDbEuVolume },
    env: { DATABASE_URL: preserve(), PGDATA: preserve(), PGDATABASE: preserve(), PGHOST: preserve(), PGPASSWORD: preserve(), PGPORT: preserve(), PGUSER: preserve(), POSTGRES_DB: preserve(), POSTGRES_PASSWORD: preserve(), POSTGRES_USER: preserve(), SSL_CERT_DAYS: preserve() },
  });

  return project("Phoenix-HR-Workforce", {
    resources: [phoenixCron, phoenixPeopleWorkforce, phoenixWorkforceWorker, phoenixHeadwind, headwindDbEu, headwindDbEuVolume],
  });
});
