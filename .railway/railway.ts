// Railway Infrastructure as Code for Phoenix-HR-Workforce.
//
// 🔴 OWNER DECISION, 2026-10-01: IT STAYS THAT WAY UNTIL HE SAYS OTHERWISE — "leave the railway
// IaC inert for now". A session may not apply it, nor read the 2026-12-01 deadline as permission to:
// the deadline is a reason to ask him, never a mandate. Only he lifts this, in his own words.
//
// 🔴 THIS FILE IS NOT APPLIED YET, AND NOTHING APPLIES IT AUTOMATICALLY. It is the reviewed
// authoring file for the cutover away from `railway.json` / `railway.toml`, which Railway deprecated
// with existing files working until 2026-12-01. Both `railway.toml` files are still in place and are
// still what configures the live services; per `.railway/README.md`, "services already managed by
// railway.json must be migrated before .railway/railway.ts can manage them". So this lands inert, on
// purpose, so the apply can be reviewed from a file in git rather than from something generated on
// the spot at the moment of pressing.
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
    source: github("Gawish-1997/phoenix-people-workforce", { checkSuites: true }),
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["phoenix-hr.satopharma.com"],
    // From railway.toml, which a pull cannot see: config-as-code is applied at DEPLOY time and is
    // not stored as a service setting. Omitting these leaves production with no readiness gate.
    deploy: {
      healthcheckPath: "/api/readyz",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    env: { ACTION1_API_BASE_URL: preserve(), ACTION1_CLIENT_ID: preserve(), ACTION1_CLIENT_SECRET: preserve(), ACTION1_ORG_ID: preserve(), ANDROID_MANAGEMENT_ENTERPRISE_NAME: preserve(), ANDROID_MANAGEMENT_KEY: preserve(), ANDROID_MANAGEMENT_PROJECT_ID: preserve(), APP_ENV: preserve(), APP_URL: preserve(), ATTENDANCE_AGENT_BROWSER_TOKEN: preserve(), ATTENDANCE_AGENT_TOKEN: preserve(), BREVO_API_KEY: preserve(), BREVO_EMAIL_FROM: preserve(), BREVO_WEBHOOK_SECRET: preserve(), CLOUDFLARE_API_TOKEN: preserve(), CRON_SECRET: preserve(), CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET: preserve(), CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL: preserve(), EMAIL_NOTIFICATIONS_ENABLED: preserve(), FTP_VIDEO_HANDOFF_SECRET: preserve(), GITHUB_ACTIONS_DISPATCH_TOKEN: preserve(), GOOGLE_CALENDAR_API_KEY: preserve(), GOOGLE_DRIVE_OAUTH_CLIENT_ID: preserve(), GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: preserve(), GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: preserve(), GOOGLE_DRIVE_RECRUITMENT_FOLDER_ID: preserve(), GOOGLE_HOLIDAY_CALENDAR_ID_EG: preserve(), GOOGLE_MAPS_SERVER_KEY: preserve(), GROQ_API_KEY: preserve(), HEADWIND_MDM_BASE_URL: preserve(), HEADWIND_MDM_LOGIN: preserve(), HEADWIND_MDM_PASSWORD: preserve(), HEALTHCHECKS_PING_KEY: preserve(), HR_NOTIFICATION_EMAILS: preserve(), IREPORTS360_BASE_URL: preserve(), IREPORTS360_PASSWORD: preserve(), IREPORTS360_TIMEOUT_MS: preserve(), IREPORTS360_USERNAME: preserve(), JOB_OFFER_EMAIL_FROM: preserve(), LOCATIONIQ_API_KEY: preserve(), MAILBOX_MONITOR_SECRET: preserve(), MANAGEENGINE_MDM_CLIENT_ID: preserve(), MANAGEENGINE_MDM_CLIENT_SECRET: preserve(), MANAGEENGINE_MDM_REFRESH_TOKEN: preserve(), MARKETING_SHEET_REFRESH_WEBHOOK_SECRET: preserve(), MARKETING_SHEET_REFRESH_WEBHOOK_URL: preserve(), MASTER_MAP_SYNC_TOKEN: preserve(), NEXT_PUBLIC_APP_URL: preserve(), NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: preserve(), NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID: preserve(), NEXT_PUBLIC_ONESIGNAL_APP_ID: preserve(), NEXT_PUBLIC_SUPABASE_ANON_KEY: preserve(), NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: preserve(), NEXT_PUBLIC_SUPABASE_URL: preserve(), NOTIFICATION_DASHBOARD_URL: preserve(), NOTIFICATION_EMAIL_FROM: preserve(), NOTIFICATION_WEBHOOK_SECRET: preserve(), ONESIGNAL_REST_API_KEY: preserve(), OPENAI_API_KEY: preserve(), PHOENIX_ALLOWED_ORIGINS: preserve(), PHOENIX_APP_URL: preserve(), PHOENIX_AUTH_SECRET: preserve(), PHOENIX_EXPENSE_CLAIMS_READ: preserve(), PHOENIX_LIVE_CRM_POLL: preserve(), PHOENIX_STRICT_SUPABASE_BRIDGE: preserve(), PHOENIX_TURBIFY_ADMIN_PASSWORD: preserve(), PHOENIX_TURBIFY_ADMIN_USER: preserve(), PHOENIX_TURBIFY_ROBOT_ENABLED: preserve(), RECRUITMENT_APPLY_WHATSAPP_NUMBER: preserve(), RECRUITMENT_EMAIL_IMPORT_SENDERS: preserve(), RECRUITMENT_EMAIL_INBOXES_JSON: preserve(), RECRUITMENT_WHATSAPP_CLASSIFY_ENABLED: preserve(), RECRUITMENT_WHATSAPP_DIRECT_INTAKE: preserve(), RECRUITMENT_WHATSAPP_IMPORT_SENDERS: preserve(), RECRUITMENT_WHATSAPP_SILENCE_ALERT_HOURS: preserve(), RESEND_API_KEY: preserve(), RESEND_WEBHOOK_SECRET: preserve(), SENTRY_AUTH_TOKEN: preserve(), SHEET_REFRESH_WEBHOOK_SECRET: preserve(), SHEET_REFRESH_WEBHOOK_URL: preserve(), SUPABASE_PROJECT_ID: preserve(), SUPABASE_PROJECT_REF: preserve(), SUPABASE_SERVICE_ROLE_KEY: preserve(), TELEGRAM_BOT_TOKEN: preserve(), TELEGRAM_BOT_USERNAME: preserve(), WHATSAPP_ACCESS_TOKEN: preserve(), WHATSAPP_APP_SECRET: preserve(), WHATSAPP_PHONE_NUMBER_ID: preserve(), WHATSAPP_PHONE_NUMBER_IDS: preserve(), WHATSAPP_WEBHOOK_VERIFY_TOKEN: preserve(), ZOOM_ACCOUNT_ID: preserve(), ZOOM_CLIENT_ID: preserve(), ZOOM_CLIENT_SECRET: preserve(), ZOOM_HOST_USER: preserve() },
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
    env: { ADMIN_EMAIL: preserve(), BASE_DOMAIN: preserve(), HEADWIND_IMAGE_TAG: preserve(), PROTOCOL: preserve(), SQL_BASE: preserve(), SQL_HOST: preserve(), SQL_PASS: preserve(), SQL_PORT: preserve(), SQL_USER: preserve() },
  });
  const headwindDbEu = service("headwind-db-eu", {
    source: image("ghcr.io/railwayapp-templates/postgres-ssl:18"),
    replicas: { "europe-west4-drams3a": 1 },
    volumeMounts: { "/var/lib/postgresql/data": headwindDbEuVolume },
    env: { DATABASE_URL: preserve(), PGDATA: preserve(), PGDATABASE: preserve(), PGHOST: preserve(), PGPASSWORD: preserve(), PGPORT: preserve(), PGUSER: preserve(), POSTGRES_DB: preserve(), POSTGRES_PASSWORD: preserve(), POSTGRES_USER: preserve(), SSL_CERT_DAYS: preserve() },
  });

  return project("Phoenix-HR-Workforce", {
    resources: [phoenixCron, phoenixPeopleWorkforce, phoenixHeadwind, headwindDbEu, headwindDbEuVolume],
  });
});
