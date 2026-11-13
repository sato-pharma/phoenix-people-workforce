/**
 * THE INTEGRATION REGISTRY (integration audit, 13 Nov 2026: ISS-039, ISS-040, ISS-042, INT-063).
 *
 * One entry per outside service Phoenix talks to, or that talks to Phoenix. Before this file the list lived in
 * code, variable names and operations notes, and nobody could tell from the app which optional integrations were
 * switched on in production. The Super Admin page /admin/integrations reads this registry and shows, for each one:
 * configured or not, the last success and the last failure.
 *
 * 🔴 NEVER A VALUE. An entry names the variables that hold a credential; the page is told only whether each one
 * is set. `integrationConfiguration` returns names and a state and nothing else, and
 * tests/integrations-registry.test.ts feeds it marked values and refuses any that come back out.
 *
 * Pure data and pure functions: no database, no network, no server-only import, so the test can load it.
 *
 * Not listed, on purpose: code libraries (spreadsheet, PDF and image packages), browser features (location,
 * camera, microphone) and the two hosts the company left (Google Cloud and Vercel). None of them holds a
 * credential or can be down for Phoenix alone.
 */

export type IntegrationCategory =
  | "Hosting and scheduling"
  | "Database"
  | "Email"
  | "Messages and notifications"
  | "AI"
  | "Maps and location"
  | "Google Workspace"
  | "Hiring"
  | "Devices and attendance"
  | "Monitoring and backup"
  | "Open data and assets";

export const INTEGRATION_CATEGORIES: readonly IntegrationCategory[] = [
  "Hosting and scheduling",
  "Database",
  "Email",
  "Messages and notifications",
  "AI",
  "Maps and location",
  "Google Workspace",
  "Hiring",
  "Devices and attendance",
  "Monitoring and backup",
  "Open data and assets",
];

/**
 * Where an integration's credential lives.
 *
 *   env      the app's own variables. `anyOf` is a list of complete sets: the integration is configured when
 *            EVERY name of at least ONE set is present. (Drive works with an OAuth trio or with one service key.)
 *   switch   on unless the named variable holds an "off" word: a kill switch, not a credential.
 *   outside  held where the app cannot read it (a GitHub secret, another Railway service). Said plainly, never
 *            shown as "not configured".
 *   none     no credential exists: an open feed, or a file the reader's own browser loads.
 */
export type IntegrationCredential =
  | { kind: "env"; anyOf: readonly (readonly string[])[] }
  | { kind: "switch"; name: string }
  | { kind: "outside"; where: string }
  | { kind: "none"; why: string };

/**
 * Where Phoenix already records that this integration last worked or last failed. The page reads these and
 * nothing else: an integration with no record says "Not recorded", never an empty cell and never a guess.
 *
 *   heartbeat        the job heartbeat register (job_heartbeats), for the scheduled jobs named in `slugs`.
 *                    "*" means every declared job.
 *   deliveries       notification_deliveries, by channel and provider.
 *   email-events     email_delivery_events, by provider.
 *   whatsapp         ats_whatsapp_outbound_messages.
 *   zoom             ats_interview_bookings.zoom_status.
 *   ai-failures      app_error_events rows written by the AI failure recorder, by route prefix. FAILURES ONLY:
 *                    a successful AI call writes nothing.
 *   none             nothing is recorded; `why` is shown.
 */
export type IntegrationHealthSource =
  | { kind: "heartbeat"; slugs: readonly string[] | "*" }
  | { kind: "deliveries"; channel: "telegram" | "push"; provider: string }
  | { kind: "email-events"; provider: "resend" | "brevo" | "turbify" }
  | { kind: "whatsapp" }
  | { kind: "zoom" }
  | { kind: "ai-failures"; routePrefix: string }
  | { kind: "none"; why: string };

export type IntegrationEntry = {
  id: string;
  name: string;
  provider: string;
  category: IntegrationCategory;
  /** What Phoenix uses it for, in one plain sentence. */
  usedFor: string;
  credential: IntegrationCredential;
  health: IntegrationHealthSource;
  /** Facts a reader must have beside the row: a data note, a review date. Each is a full sentence. */
  notes?: readonly string[];
};

/**
 * THE MESSAGING API VERSION (ISS-042). WhatsApp messages go through Meta's Graph API at a version written into
 * seven files as a default. Meta retires each version on a published date, and a retired version stops answering.
 *
 * Read from Meta's own table on 13 Nov 2026 (developers.facebook.com/docs/graph-api/changelog/versions):
 * v23.0 was released on 29 May 2025 and expires on 8 October 2027.
 *
 * 🔴 Whoever changes the version in those seven files changes these three lines in the same commit:
 * tests/integrations-registry.test.ts reads all seven, refuses an eighth, and fails when they disagree with `version`.
 */
export const WHATSAPP_GRAPH_API = {
  version: "v23.0",
  expiresOn: "2027-10-08",
  reviewBy: "2027-07-08",
} as const;

/** The seven files that carry the version as a default. The test reads each one. */
export const WHATSAPP_GRAPH_API_VERSION_FILES: readonly string[] = [
  "src/lib/recruitment/inbound/whatsapp-health.ts",
  "src/lib/recruitment/inbound/whatsapp-interactive.ts",
  "src/lib/recruitment/inbound/whatsapp-media.ts",
  "src/lib/recruitment/inbound/whatsapp-reply.ts",
  "src/lib/whatsapp-inbox/graph.ts",
  "src/lib/recruitment/inbound/whatsapp-embedded-signup.ts",
  "app/api/whatsapp/embedded-signup/exchange/route.ts",
];

function plainDate(isoDay: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = isoDay.split("-").map(Number);
  return `${day} ${months[month - 1]} ${year}`;
}

const NOT_LOGGED_PER_CALL = "Phoenix keeps no record of each call to this service.";
const BROWSER_LOADS_IT = "The reader's own browser loads it; the server never calls it.";

export const INTEGRATIONS: readonly IntegrationEntry[] = [
  // ── Hosting and scheduling ──────────────────────────────────────────────────────────────────────────────
  {
    id: "railway",
    name: "Railway",
    provider: "Railway",
    category: "Hosting and scheduling",
    usedFor: "Runs the website, the background worker and the nightly backup service.",
    credential: { kind: "outside", where: "Railway's own project. The app holds no Railway key." },
    health: { kind: "none", why: "This page answering is the proof the host is up. Deploys are read on GitHub and Railway." },
  },
  {
    id: "cron-job-org",
    name: "cron-job.org scheduler",
    provider: "cron-job.org",
    category: "Hosting and scheduling",
    usedFor: "Calls the scheduled jobs on time. Each call must carry the scheduler's shared secret.",
    credential: { kind: "env", anyOf: [["CRON_SECRET"]] },
    health: { kind: "heartbeat", slugs: "*" },
    notes: ["Last success and last failure are the newest across every scheduled job, whichever scheduler started it."],
  },
  {
    id: "healthchecks",
    name: "Healthchecks dead-man's switch",
    provider: "Healthchecks.io",
    category: "Hosting and scheduling",
    usedFor: "Raises an alarm from outside when a scheduled job stops reporting.",
    credential: { kind: "env", anyOf: [["HEALTHCHECKS_PING_KEY"]] },
    health: { kind: "none", why: "Phoenix sends the pings and does not log them. A missed ping is reported by Healthchecks itself." },
  },
  {
    id: "github-actions",
    name: "GitHub Actions",
    provider: "GitHub",
    category: "Hosting and scheduling",
    usedFor: "Checks every change before it ships. The app also starts and reads workflow runs.",
    credential: { kind: "env", anyOf: [["GITHUB_ACTIONS_DISPATCH_TOKEN"]] },
    health: { kind: "heartbeat", slugs: ["phoenix-github-workflow-watch"] },
  },
  {
    id: "fly-standby",
    name: "Standby host",
    provider: "Fly.io",
    category: "Hosting and scheduling",
    usedFor: "A stopped copy of the website in Frankfurt, for a day Railway cannot deploy at all.",
    credential: { kind: "outside", where: "A GitHub secret, used only by the Emergency host workflow." },
    health: { kind: "none", why: "It runs only when started by hand. Its rehearsals are recorded in the integration audit's plan." },
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    provider: "Cloudflare",
    category: "Hosting and scheduling",
    usedFor: "Holds the company domain's addresses and guards the tablet console.",
    credential: { kind: "outside", where: "A GitHub secret for the domain; a service token on the tablet console." },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },

  // ── Database ───────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "supabase",
    name: "Supabase database, sign-in and files",
    provider: "Supabase",
    category: "Database",
    usedFor: "Holds every record, the sign-in accounts and the uploaded files.",
    credential: { kind: "env", anyOf: [["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]] },
    health: { kind: "heartbeat", slugs: ["phoenix-db-health-snapshot"] },
  },
  {
    id: "supabase-host-metrics",
    name: "Database host sampler",
    provider: "Supabase",
    category: "Database",
    usedFor: "Reads the database server's memory and processor load so a strained host is seen early.",
    credential: { kind: "switch", name: "PHOENIX_DB_HOST_METRICS" },
    health: { kind: "none", why: "The samples are on the System Audit board, not counted here." },
    notes: ["It samples only on the production worker, even when switched on."],
  },

  // ── Email ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "resend",
    name: "Resend",
    provider: "Resend",
    category: "Email",
    usedFor: "Sends the system's emails and reports each one's delivery.",
    credential: { kind: "env", anyOf: [["RESEND_API_KEY"]] },
    health: { kind: "email-events", provider: "resend" },
  },
  {
    id: "brevo",
    name: "Brevo",
    provider: "Brevo",
    category: "Email",
    usedFor: "The second email sender, used when the first refuses a message.",
    credential: { kind: "env", anyOf: [["BREVO_API_KEY"]] },
    health: { kind: "email-events", provider: "brevo" },
  },
  {
    id: "company-mailboxes",
    name: "Company mailboxes, incoming",
    provider: "Turbify",
    category: "Email",
    usedFor: "Reads the hiring mailboxes for new CVs.",
    credential: { kind: "env", anyOf: [["RECRUITMENT_EMAIL_INBOXES_JSON"]] },
    health: { kind: "heartbeat", slugs: ["phoenix-recruitment-email-intake"] },
  },
  {
    id: "company-mail-offers",
    name: "Company mail, job offers",
    provider: "Turbify",
    category: "Email",
    usedFor: "Sends job offers from the company's own address.",
    credential: { kind: "env", anyOf: [["JOB_OFFER_SMTP_APP_PASSWORD"]] },
    health: { kind: "email-events", provider: "turbify" },
  },
  {
    id: "turbify-console",
    name: "Mailbox console robot",
    provider: "Turbify",
    category: "Email",
    usedFor: "Opens and closes company mailboxes in the provider's console when someone joins or leaves.",
    credential: { kind: "env", anyOf: [["PHOENIX_TURBIFY_ADMIN_USER", "PHOENIX_TURBIFY_ADMIN_PASSWORD"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },

  // ── Messages and notifications ─────────────────────────────────────────────────────────────────────────
  {
    id: "telegram",
    name: "Telegram",
    provider: "Telegram",
    category: "Messages and notifications",
    usedFor: "Delivers notices and alarms to people who linked their Telegram.",
    credential: { kind: "env", anyOf: [["TELEGRAM_BOT_TOKEN"]] },
    health: { kind: "deliveries", channel: "telegram", provider: "telegram" },
  },
  {
    id: "onesignal",
    name: "Web push",
    provider: "OneSignal",
    category: "Messages and notifications",
    usedFor: "Shows a notice on a phone or computer that allowed notifications.",
    credential: { kind: "env", anyOf: [["NEXT_PUBLIC_ONESIGNAL_APP_ID", "ONESIGNAL_REST_API_KEY"]] },
    health: { kind: "deliveries", channel: "push", provider: "onesignal" },
  },
  {
    id: "whatsapp",
    name: "WhatsApp Business",
    provider: "Meta",
    category: "Messages and notifications",
    usedFor: "Talks to job candidates and sends urgent approval reminders.",
    credential: {
      kind: "env",
      anyOf: [
        ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_IDS"],
        ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"],
      ],
    },
    health: { kind: "whatsapp" },
    notes: [
      `Messages go through Meta's Graph API ${WHATSAPP_GRAPH_API.version}. Meta retires that version on ${plainDate(WHATSAPP_GRAPH_API.expiresOn)}, and a retired version stops answering. Review and move to a newer version by ${plainDate(WHATSAPP_GRAPH_API.reviewBy)}.`,
    ],
  },

  // ── AI ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "openai",
    name: "OpenAI",
    provider: "OpenAI",
    category: "AI",
    usedFor: "Reads CVs and documents, drafts text and checks uploads.",
    credential: { kind: "env", anyOf: [["OPENAI_API_KEY"]] },
    health: { kind: "ai-failures", routePrefix: "/ai/openai_client/" },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    provider: "Anthropic",
    category: "AI",
    usedFor: "Answers an AI request when the first provider fails, and reads images.",
    credential: { kind: "env", anyOf: [["ANTHROPIC_API_KEY"], ["ANTHROPIC_API_KEY_2"]] },
    health: { kind: "none", why: "AI failures are recorded by feature, not by this provider. They are on the System Audit board." },
  },
  {
    id: "groq",
    name: "Groq voice transcription",
    provider: "Groq",
    category: "AI",
    usedFor: "Turns a dictated voice clip into text, for browsers with no dictation of their own.",
    credential: { kind: "env", anyOf: [["GROQ_API_KEY"]] },
    health: { kind: "ai-failures", routePrefix: "/ai/groq_transcription/" },
    notes: [
      "Data note: a dictated clip may hold a doctor's or an employee's name. It is sent to Groq, a company in the United States, which stores customer data there.",
      "Groq's published terms (read 13 Nov 2026): it keeps nothing from a request by default, may log a request for up to 30 days to investigate a fault or abuse, and may not train on it.",
      "Not verified: whether Zero Data Retention is switched on for the company's Groq account. It is a setting in Groq's console, under Data Controls.",
    ],
  },

  // ── Maps and location ──────────────────────────────────────────────────────────────────────────────────
  {
    id: "google-maps-server",
    name: "Google Maps, server",
    provider: "Google",
    category: "Maps and location",
    usedFor: "Finds addresses and places, measures routes and draws map pictures.",
    credential: { kind: "env", anyOf: [["GOOGLE_MAPS_SERVER_KEY"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },
  {
    id: "google-maps-browser",
    name: "Google Maps, on screen",
    provider: "Google",
    category: "Maps and location",
    usedFor: "Draws the live maps people see.",
    credential: { kind: "env", anyOf: [["NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY"]] },
    health: { kind: "none", why: BROWSER_LOADS_IT },
  },
  {
    id: "locationiq",
    name: "LocationIQ",
    provider: "LocationIQ",
    category: "Maps and location",
    usedFor: "The first address finder tried, when its key is set. Google is tried after it.",
    credential: { kind: "env", anyOf: [["LOCATIONIQ_API_KEY"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },
  {
    id: "openstreetmap-tiles",
    name: "OpenStreetMap tiles",
    provider: "OpenStreetMap Foundation",
    category: "Maps and location",
    usedFor: "The map background on the Location Integrity board.",
    credential: { kind: "none", why: "An open service with no key." },
    health: { kind: "none", why: BROWSER_LOADS_IT },
  },

  // ── Google Workspace ───────────────────────────────────────────────────────────────────────────────────
  {
    id: "google-drive",
    name: "Google Drive",
    provider: "Google",
    category: "Google Workspace",
    usedFor: "Keeps the CV archive, and is read each day to check the nightly backups arrived.",
    credential: {
      kind: "env",
      anyOf: [
        ["GOOGLE_DRIVE_OAUTH_CLIENT_ID", "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN"],
        ["GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY"],
      ],
    },
    health: { kind: "heartbeat", slugs: ["phoenix-code-backup-verify"] },
  },
  {
    id: "live-company-sheets",
    name: "Live company sheets",
    provider: "Google",
    category: "Google Workspace",
    usedFor: "Tells the three live Google Sheets (direct orders, marketing requests and the CV lifecycle) to refresh when their data changes.",
    // Three sheets, each with its own address and shared key. All six must be set for all three to refresh.
    credential: {
      kind: "env",
      anyOf: [
        [
          "SHEET_REFRESH_WEBHOOK_URL",
          "SHEET_REFRESH_WEBHOOK_SECRET",
          "MARKETING_SHEET_REFRESH_WEBHOOK_URL",
          "MARKETING_SHEET_REFRESH_WEBHOOK_SECRET",
          "CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_URL",
          "CV_LIFECYCLE_SHEET_REFRESH_WEBHOOK_SECRET",
        ],
      ],
    },
    health: {
      kind: "heartbeat",
      slugs: [
        "phoenix-cv-lifecycle-rotate-sheet-token",
        "phoenix-direct-orders-rotate-sheet-token",
        "phoenix-marketing-requests-rotate-sheet-token",
      ],
    },
    notes: ["Last success and last failure are the weekly key changes of the three sheets, every Friday. Each refresh call is not logged."],
  },
  {
    id: "master-map-sheet",
    name: "Master map sheet",
    provider: "Google",
    category: "Google Workspace",
    usedFor: "Reads and writes the sales master map in Google Sheets.",
    credential: { kind: "env", anyOf: [["MASTER_MAP_GOOGLE_KEY"], ["MASTER_MAP_GOOGLE_ACCESS_TOKEN"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    provider: "Google",
    category: "Google Workspace",
    usedFor: "Reads Egypt's public holidays.",
    credential: { kind: "env", anyOf: [["GOOGLE_CALENDAR_API_KEY"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },

  // ── Hiring ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "zoom",
    name: "Zoom",
    provider: "Zoom",
    category: "Hiring",
    usedFor: "Creates the meeting for an online interview.",
    credential: { kind: "env", anyOf: [["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "ZOOM_HOST_USER"]] },
    health: { kind: "zoom" },
  },
  {
    id: "recaptcha",
    name: "reCAPTCHA",
    provider: "Google",
    category: "Hiring",
    usedFor: "Keeps robots off the public job application form.",
    credential: { kind: "env", anyOf: [["RECRUITMENT_APPLY_RECAPTCHA_SECRET"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },
  {
    id: "sato-website",
    name: "Company website careers feed",
    provider: "Sato Pharma website",
    category: "Hiring",
    usedFor: "Lets the company website show open jobs and hand in applications.",
    credential: { kind: "env", anyOf: [["SATO_WEBSITE_INTEGRATION_TOKEN"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },

  // ── Devices and attendance ─────────────────────────────────────────────────────────────────────────────
  {
    id: "headwind",
    name: "Tablet server",
    provider: "Headwind MDM",
    category: "Devices and attendance",
    usedFor: "Manages the representatives' tablets.",
    credential: { kind: "env", anyOf: [["HEADWIND_MDM_BASE_URL", "HEADWIND_MDM_LOGIN", "HEADWIND_MDM_PASSWORD"]] },
    health: { kind: "heartbeat", slugs: ["phoenix-tablet-fleet-watch"] },
  },
  {
    id: "android-management",
    name: "Managed Google Play",
    provider: "Google",
    category: "Devices and attendance",
    usedFor: "Publishes the company's web apps to managed devices.",
    credential: { kind: "env", anyOf: [["ANDROID_MANAGEMENT_ENTERPRISE_NAME"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },
  {
    id: "action1",
    name: "Laptop inventory",
    provider: "Action1",
    category: "Devices and attendance",
    usedFor: "Reads the list of company laptops for the custody register.",
    credential: { kind: "env", anyOf: [["ACTION1_CLIENT_ID", "ACTION1_CLIENT_SECRET"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },
  {
    id: "attendance-agent",
    name: "Fingerprint attendance agent",
    provider: "ZKTeco device and the company's own agent",
    category: "Devices and attendance",
    usedFor: "Brings fingerprint punches from the office device.",
    credential: { kind: "env", anyOf: [["ATTENDANCE_AGENT_TOKEN"]] },
    health: { kind: "none", why: NOT_LOGGED_PER_CALL },
  },

  // ── Monitoring and backup ──────────────────────────────────────────────────────────────────────────────
  {
    id: "sentry",
    name: "Sentry",
    provider: "Sentry",
    category: "Monitoring and backup",
    usedFor: "Collects errors from the server and from people's browsers.",
    credential: { kind: "env", anyOf: [["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"]] },
    health: { kind: "none", why: "Proved by hand on the Sentry Check page." },
  },
  {
    id: "nightly-backups",
    name: "Nightly backups",
    provider: "Railway service, to Google Drive",
    category: "Monitoring and backup",
    usedFor: "Each night, an encrypted copy of the code and of the whole database, kept on the company's Drive.",
    credential: { kind: "outside", where: "The backup service on Railway holds its own keys. The website cannot read them." },
    health: { kind: "heartbeat", slugs: ["phoenix-code-backup-verify", "phoenix-db-backup-verify"] },
    notes: ["Last success and last failure are the daily check that both files arrived, are recent and are large enough."],
  },
  {
    id: "synthetic-journeys",
    name: "Robot user journeys",
    provider: "GitHub Actions",
    category: "Monitoring and backup",
    usedFor: "A robot signs in and walks the main screens on a schedule, to catch a broken page before a person does.",
    credential: { kind: "outside", where: "GitHub secrets hold the robot's own account." },
    health: { kind: "heartbeat", slugs: ["phoenix-run-synthetic-journeys"] },
  },

  // ── Open data and assets ───────────────────────────────────────────────────────────────────────────────
  {
    id: "exchange-rates",
    name: "Exchange rates",
    provider: "ExchangeRate-API open feed",
    category: "Open data and assets",
    usedFor: "Reads the day's currency rates for production planning.",
    credential: { kind: "none", why: "An open feed with no key." },
    health: { kind: "heartbeat", slugs: ["phoenix-production-planning-fx"] },
  },
  {
    id: "google-fonts",
    name: "Google Fonts",
    provider: "Google",
    category: "Open data and assets",
    usedFor: "The Arabic typeface on the joining form.",
    credential: { kind: "none", why: "An open service with no key." },
    health: { kind: "none", why: BROWSER_LOADS_IT },
  },
];

// ── Configured or not ──────────────────────────────────────────────────────────────────────────────────────

export type IntegrationConfiguredState = "configured" | "partly" | "not-configured" | "on" | "off" | "outside" | "no-credential";

export type IntegrationConfiguration = {
  state: IntegrationConfiguredState;
  /** What the page prints. */
  label: string;
  /** Variable NAMES still missing from the set closest to complete. Never a value. */
  missing: string[];
  /** Variable names this integration reads. Never a value. */
  names: string[];
  /** A sentence for "outside" and "no-credential". */
  detail: string | null;
};

type Env = Record<string, string | undefined>;

// A value that is only blanks is not set. trim() also drops a byte-order mark, which has been stored in a variable before.
function isSet(env: Env, name: string): boolean {
  return String(env[name] ?? "").trim().length > 0;
}

const OFF_WORDS = new Set(["off", "0", "false"]);

/**
 * Whether an integration is configured, from variable NAMES alone. The returned object holds a state, a label
 * and names. It is built without ever copying a value: the only question asked of `env` is "is this name set".
 */
export function integrationConfiguration(entry: IntegrationEntry, env: Env): IntegrationConfiguration {
  const credential = entry.credential;
  if (credential.kind === "outside") {
    return { state: "outside", label: "Kept outside the app", missing: [], names: [], detail: credential.where };
  }
  if (credential.kind === "none") {
    return { state: "no-credential", label: "No credential needed", missing: [], names: [], detail: credential.why };
  }
  if (credential.kind === "switch") {
    const word = String(env[credential.name] ?? "").trim().toLowerCase();
    const off = OFF_WORDS.has(word);
    return {
      state: off ? "off" : "on",
      label: off ? "Switched off" : "Switched on",
      missing: [],
      names: [credential.name],
      detail: null,
    };
  }

  const names = [...new Set(credential.anyOf.flat())];
  let best: { missing: string[]; present: number } | null = null;
  for (const set of credential.anyOf) {
    const missing = set.filter((name) => !isSet(env, name));
    const present = set.length - missing.length;
    if (missing.length === 0) {
      return { state: "configured", label: "Configured", missing: [], names, detail: null };
    }
    if (!best || present > best.present) best = { missing, present };
  }
  const partly = best !== null && best.present > 0;
  return {
    state: partly ? "partly" : "not-configured",
    label: partly ? "Partly set" : "Not configured",
    missing: best ? best.missing : [],
    names,
    detail: null,
  };
}

export function findIntegration(id: string): IntegrationEntry | null {
  return INTEGRATIONS.find((entry) => entry.id === id) ?? null;
}
