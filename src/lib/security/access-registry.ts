import type { PermissionAction, PermissionResource } from "@/lib/auth/permissions";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type AuthMode =
  | "session"
  | "public-token"
  | "webhook-secret"
  | "cron-secret"
  | "machine-token"
  | "dev-only";

export type PermissionRequirement = {
  action: PermissionAction;
  resource: PermissionResource;
};

export type AccessRegistryEntry = {
  audit: {
    classification?: "access-read" | "export" | "mutation" | "public-token" | "machine" | "webhook" | "cron";
    required: boolean;
  };
  authMode: AuthMode;
  csrf: {
    exemptReason?: string;
    required: boolean;
  };
  exceptionReason?: string;
  guard?: "assert-permission" | "domain-helper" | "secret" | "public-token" | "dev-only";
  methods: readonly HttpMethod[];
  pattern: string;
  permission: PermissionRequirement | readonly PermissionRequirement[] | null;
  serviceRole: {
    allowed: boolean;
    reason?: string;
  };
  surface: "api" | "page" | "export";
};

export type SecurityPreflightResult = {
  checkedAt: string;
  environment: "local" | "staging" | "production";
  failures: string[];
  passed: boolean;
  warnings: string[];
};

const readOnly: readonly HttpMethod[] = ["GET"];
const allMethods: readonly HttpMethod[] = ["GET", "POST", "PATCH", "PUT", "DELETE"];

function sessionApi(input: {
  audit?: AccessRegistryEntry["audit"];
  csrfExemptReason?: string;
  csrfRequired?: boolean;
  guard?: AccessRegistryEntry["guard"];
  methods?: readonly HttpMethod[];
  pattern: string;
  permission: AccessRegistryEntry["permission"];
  serviceRoleReason?: string;
}): AccessRegistryEntry {
  return {
    audit: input.audit ?? { required: false },
    authMode: "session",
    csrf: {
      exemptReason: input.csrfRequired ? undefined : input.csrfExemptReason ?? "Protected session route; mutation does not accept cross-site form semantics.",
      required: Boolean(input.csrfRequired),
    },
    guard: input.guard ?? "assert-permission",
    methods: input.methods ?? allMethods,
    pattern: input.pattern,
    permission: input.permission,
    serviceRole: {
      allowed: true,
      reason: input.serviceRoleReason ?? "Server route uses guarded application authorization before service-role data access.",
    },
    surface: "api",
  };
}

function tokenApi(input: {
  authMode: Exclude<AuthMode, "session">;
  methods?: readonly HttpMethod[];
  pattern: string;
  reason: string;
}): AccessRegistryEntry {
  return {
    audit: { classification: input.authMode === "public-token" ? "public-token" : input.authMode === "webhook-secret" ? "webhook" : input.authMode === "cron-secret" ? "cron" : input.authMode === "machine-token" ? "machine" : undefined, required: input.authMode !== "dev-only" },
    authMode: input.authMode,
    csrf: {
      exemptReason: input.reason,
      required: false,
    },
    exceptionReason: input.reason,
    guard: input.authMode === "dev-only" ? "dev-only" : input.authMode === "public-token" ? "public-token" : "secret",
    methods: input.methods ?? allMethods,
    pattern: input.pattern,
    permission: null,
    serviceRole: {
      allowed: input.authMode !== "dev-only",
      reason: input.reason,
    },
    surface: "api",
  };
}

export const accessRegistry = [
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/login", reason: "Credential bootstrap endpoint; no existing Phoenix session is expected." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/logout", reason: "Session teardown endpoint accepts an existing cookie but does not expose data." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/heartbeat", reason: "Session heartbeat endpoint validates the Phoenix session token directly." }),
  // The native app opening a production portal module, already signed in. Two halves, declared apart
  // because they genuinely differ (src/lib/auth/native-web-handoff.ts):
  //
  // POST is the APP asking, with its bearer token — a full session route, gated on the same
  // employee_profile:read the portal shell asserts. It is CSRF-exempt because it mints ONLY for a
  // bearer caller: a cookie-bearing browser request, which is all a cross-site form can produce,
  // gets 401 before any ticket exists. It sets no cookie of its own, deliberately — React Native
  // replays one and the CSRF guard then refuses every later mutation as `csrf_blocked`.
  sessionApi({
    csrfExemptReason: "Mints only for an Authorization: Bearer caller; a cross-site form or cookie-only request cannot obtain a ticket, and the response sets no cookie.",
    methods: ["POST"],
    pattern: "/api/auth/web-session",
    permission: { resource: "employee_profile", action: "read" },
  }),
  // GET is the BROWSER TAB redeeming, and no Phoenix session exists in that tab yet — the same shape
  // as /api/auth/login above, with a sealed one-trip ticket in place of the password. It grants
  // nothing new: the cookie it sets is for the same session id and version the app already holds and
  // expires at the same second, and `next` can only ever be a path under /employee-portals.
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/auth/web-session", reason: "Credential redemption endpoint; the sealed 60-second ticket IS the credential and no Phoenix session exists in the opening tab yet. It mints a cookie for the session the app already holds — same sid, same version, same expiry — and redirects only within /employee-portals." }),
  // The REVERSE of web-session's GET: the native shell logged in on the real /login page inside its
  // WebView (cookie), and this hands the SAME token back as a bearer for the native half (CRM, push).
  // A live cookie session is required — so it is a sessionApi, CSRF-enforced (not exempt), gated on
  // the same minimal read the portal shell asserts. It mints nothing; see the route header.
  sessionApi({
    csrfRequired: true,
    methods: ["POST"],
    pattern: "/api/auth/native-token",
    permission: { resource: "employee_profile", action: "read" },
  }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/password-setup/:token", reason: "Password setup/reset is protected by a one-time token." }),
  // Self-service reset-by-code (owner, 2026-10-06). No Phoenix session exists yet — the person is
  // signed out and resetting. request-code emails a one-time 6-digit code and reveals nothing about
  // which identifiers are real (identical response for unknown/inactive/sent); verify-code trades a
  // correct code for a short-lived password-setup token and returns ONE generic error for every
  // failure. Both are rate-limited per IP and per identifier.
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/password-reset/request-code", reason: "Credential bootstrap endpoint; the signed-out person proves their Sato inbox. Enumeration-safe: unknown identifier, inactive account, missing mailbox and a successful send all return the same response. Rate-limited per IP and per identifier." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/password-reset/verify-code", reason: "Credential bootstrap endpoint; the emailed 6-digit code IS the credential and no Phoenix session exists yet. Enforces an attempt cap and expiry, returns one generic error for every failure, and on success mints a short-lived one-time password-setup token. Rate-limited per IP and per identifier." }),
  // Live Direct Orders report links (owner request, 2026-08-05). Unauthenticated ON PURPOSE: the
  // recipient has no Phoenix account, and a Google Sheet's IMPORTDATA formula cannot log in.
  // The 32-byte token is the credential, and resolveDirectOrderReportShareLink checks revocation,
  // expiry, passcode (live surface) and the creator-frozen scope BEFORE reading any row. Every
  // open is counted; both responses are no-store + noindex so a cached copy cannot outlive a revoke.
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/share/direct-orders/:token/feed", reason: "CSV feed for a Google Sheet IMPORTDATA formula, which cannot authenticate; guarded by a 32-byte token with mandatory expiry, revoke and creator-frozen scope." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/share/direct-orders/:token/live", reason: "Read-only live report for a recipient with no Phoenix account; additionally requires a passcode carried in the POST body, never the query string." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/share/direct-orders/:token/file", reason: "Streams the pharmacy-validation storefront photo so the live sheet's evidence cell is clickable. Same token as the feed, but a SEPARATE allow_files grant, and the storage path is resolved server-side from a request id — the caller never names an object." }),
  // Territory Management preview links (owner request, 2026-08-14). Unauthenticated AND
  // passcode-free — the owner asked for plain open access, so unlike the Direct Orders live link
  // above there is no second factor at all. The 32-byte token is the entire credential, and
  // assertTerritoryPreviewToken checks revocation and expiry before any read; every request is then
  // intersected against the link's frozen area_codes, so a forged area code reaches nothing. The
  // response is projected to brick pins only — the residence recommendation, the mis-assignment
  // findings and the route/span/gap figures never enter the payload, and neither does the line.
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/share/territory/:token/filters", reason: "Regions and areas a passwordless preview link may show; no passcode by owner instruction, so containment is the 32-byte token plus a mandatory 14-day expiry, one-click revoke and a creator-frozen area list." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/share/territory/:token/map", reason: "Brick pins for one area of a passwordless preview link; the requested area code is intersected against the link's frozen area list before any row is read, and the internal territory analysis is projected out of the response." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/share/marketing-requests/:token/feed", reason: "CSV bundle for the live Marketing Request Google Sheet's Apps Script, which runs on a timer and cannot authenticate; guarded by a 32-byte token with mandatory expiry, revoke and creator-frozen scope." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/share/marketing-requests/:token/file", reason: "Streams one evidence photo, invoice or money-transfer proof so the sheet's cells are clickable. Same token, but a SEPARATE allow_files grant, and the storage path is resolved server-side from a request code — the caller never names an object." }),
  // The CV-lifecycle sheet deliberately has NO file sibling. The two share feeds above can stream
  // an evidence photo; this one only ever emits links to Drive and to Phoenix, both of which make
  // the reader log in. A CV is the most sensitive document this system holds, and an
  // unauthenticated route that streams one is not a feature anybody asked for.
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/share/cv-lifecycle/:token/feed", reason: "CSV bundle for the owner's live CV-lifecycle Google Sheet, whose Apps Script runs on a timer and cannot authenticate; guarded by a 32-byte token with mandatory expiry and one-click revoke, and intended to live inside a private sheet rather than be handed to a person." }),
  // A picture inside a Sato email, fetched by the recipient's mail app. Unauthenticated because
  // there is no alternative: Gmail and Outlook fetch a body image with an anonymous GET, Gmail
  // through its own proxy, and they do it days after the mail was sent — so a signed URL would
  // have expired and a session check has nothing to check. The 24-byte token is the whole
  // credential, the sender is told so on the screen that uploads the picture, and the lookup
  // states kind = 'inline', so an ATTACHED file has no address to guess. The caller never names a
  // bucket or a path.
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/sato-email/media/:token", reason: "Serves one body picture to a recipient's mail client, which fetches it anonymously and long after the send, so neither a session nor a signed URL is available. The 24-byte token is the credential; bucket and path are resolved server-side from the row and only a kind='inline' row can be reached, so attachments stay unreachable." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/change-password", reason: "Auth-layer self-service endpoint: validates the active Phoenix session cookie directly via resolveSessionState before allowing password change." }),
  // Biometric (passkey) sign-in. The two /login/* routes are credential bootstrap exactly like
  // /api/auth/login — no session exists yet, and the WebAuthn signature IS the credential. The
  // /register/* and /credentials routes are self-service and validate the active Phoenix session
  // cookie directly via resolveSessionState, exactly like /api/auth/change-password above.
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/biometric/login/options", reason: "Credential bootstrap endpoint; no existing Phoenix session is expected. Returns only an opaque challenge and deliberately reveals nothing about which accounts have biometrics enrolled." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/biometric/login/verify", reason: "Credential bootstrap endpoint; the verified WebAuthn assertion replaces the password check, then the route re-applies every gate /api/auth/login applies (is_active, terminal employment, lockout, IP blocklist, force_password_reset)." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/biometric/register/options", reason: "Auth-layer self-service endpoint: validates the active Phoenix session cookie directly via resolveSessionState before issuing an enrollment challenge." }),
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/auth/biometric/register/verify", reason: "Auth-layer self-service endpoint: validates the active Phoenix session cookie directly via resolveSessionState before storing a device public key." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "DELETE"], pattern: "/api/auth/biometric/credentials", reason: "Auth-layer self-service endpoint: validates the active Phoenix session cookie directly via resolveSessionState and is scoped to the caller's own login_id, so it cannot read or revoke another person's devices." }),
  tokenApi({ authMode: "dev-only", methods: ["GET"], pattern: "/api/dev-auth", reason: "Development-only local preview authentication helper." }),
  // Super Admin only, on top of the same dev-only env+localhost gate as /api/dev-auth above
  // (see isLocalDevelopmentRequest): auto-picks a real active employee for a role+line and
  // swaps the caller's own session for a dev-preview session as that employee. Role gate is
  // in-route (domain-helper) rather than a permission resource, matching /api/admin/system-issues.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: readOnly, pattern: "/api/dev-auth/preview", permission: null, guard: "domain-helper" }),
  // Same Super Admin + dev-only gate as the preview route above: read-only candidate listing
  // that powers the picker's Line -> Region -> Area -> Name cascade client-side.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/dev-auth/candidates", permission: null, guard: "domain-helper" }),
  tokenApi({ authMode: "webhook-secret", methods: ["POST"], pattern: "/api/webhooks/resend", reason: "Resend webhook signature/secret protected." }),
  tokenApi({ authMode: "webhook-secret", methods: ["POST"], pattern: "/api/webhooks/brevo", reason: "Brevo transactional webhook is protected by a shared secret token (?token= / x-brevo-token) verified against BREVO_WEBHOOK_SECRET." }),
  tokenApi({ authMode: "webhook-secret", methods: ["GET", "POST"], pattern: "/api/webhooks/whatsapp", reason: "GET is Meta's one-time verify-token handshake; POST is protected by the X-Hub-Signature-256 HMAC verified against WHATSAPP_APP_SECRET. Recruitment inbound CV intake." }),
  // Completes WhatsApp coexistence onboarding started on the public /whatsapp-connect page. Public
  // by design: no Phoenix session exists (the owner runs it on a phone), and the credential is Meta's
  // one-time Embedded Signup `code`, which Meta issues only to a holder of a role on our Meta app. It
  // exchanges that code for a business token server-side (WHATSAPP_APP_SECRET) and subscribes this app
  // to the joined WABA so its inbound routes to /api/webhooks/whatsapp; it writes nothing to our
  // database and returns nothing sensitive. CSRF-exempt because it carries no ambient cookie authority
  // — a forged cross-site POST reaches nothing without a valid Meta code.
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/whatsapp/embedded-signup/exchange", reason: "Unauthenticated WhatsApp coexistence onboarding callback; the credential is Meta's one-time Embedded Signup code (issued only to a role-holder on our Meta app), exchanged server-side for a business token. No Phoenix session, no DB write, no sensitive response." }),
  tokenApi({ authMode: "webhook-secret", methods: ["POST"], pattern: "/api/integrations/telegram/webhook", reason: "Telegram bot webhook is protected by the Telegram secret-token header." }),
  tokenApi({ authMode: "machine-token", methods: ["GET", "POST"], pattern: "/api/integrations/ftp-videos", reason: "FTP portal lists WhatsApp closing videos waiting to be filed (short-lived signed links, sender submission IDs) and claims them once filed; bearer-guarded by its own FTP_VIDEO_HANDOFF_SECRET, never CRON_SECRET. No session, so CSRF-exempt." }),
  tokenApi({ authMode: "machine-token", methods: ["POST"], pattern: "/api/attendance/raw-punches", reason: "Local attendance agent bearer-token ingestion route." }),
  tokenApi({ authMode: "machine-token", methods: ["GET"], pattern: "/api/sales/master-map/sheet", reason: "Read-only feed for the Master Map Google Sheet, polled every five minutes by the Apps Script bound to that workbook. A shared bearer token (MASTER_MAP_SYNC_TOKEN) rather than a session because the caller is a Google script with no Phoenix user, and Google's org policy blocks the service-account key the other direction would need. GET only and mutates nothing — the sole risk it carries is DISCLOSURE of the customer master, which is why it fails closed when the token is unset in production. Longer pattern than the /api/sales/** blanket, so it wins the longest-match and is never treated as a session route." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "POST"], pattern: "/api/excuses/:id/decision", reason: "Manager excuse decision email link is protected by a one-time token; POST is explicitly unsupported." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/birthdays", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/contract-renewals", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/holiday-confirmation", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/notifications/daily", reason: "Scheduled notification route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/ireports360-visits-sync", reason: "Scheduled iReports360 visits sync route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/ireports360-visits-reconcile", reason: "Scheduled wide iReports360 reconciliation sync route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/ireports360-visits-live-sync", reason: "Scheduled high-frequency morning iReports360 visits sync route guarded by cron controls." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/probation-milestones", reason: "Probation Day 30/60/75 milestone emails — To Yasmeena Elsafory, BCC the owner. The sweep also rides the daily notifications cron; this route runs ONLY it, so a catch-up need not wait for 06:36 Cairo and does not re-fire that route's other 29 sub-jobs. Guarded by CRON_SECRET; idempotent per (case, milestone, recipient), so a repeat call sends nothing." }),
  tokenApi({ authMode: "machine-token", methods: ["POST"], pattern: "/api/mcp-source/authorize", reason: "Owner-only live authorization for the isolated MCP reader. Disabled unless PHOENIX_MCP_SOURCE_ENABLED is true; a dedicated bearer secret with no development bypass; reads every input uncached and fails closed." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/background-jobs", reason: "Durable background-job worker drain guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/attendance-weekly-digest", reason: "Weekly attendance review clock — build a closed week for the Super Admin's release (sends nothing), settle days unanswered past their deadline to salary, apply settled answers to payroll; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/recruitment-email-intake", reason: "Scheduled IMAP poll for inbound recruitment CV intake, guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/inbound-intake", reason: "Durable inbound-CV intake queue worker drain, guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/recruitment-cv-digest", reason: "6-hourly email digest to each hiring manager who received candidate pushes, with their manager CC chain; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/mailbox-offboarding-sweep", reason: "Daily sweep of the Turbify mailbox revocation register: opens a task for any leaver still holding a mailbox and alerts on the ones nobody has shut. Turbify publishes no email API, so this sweep and the register it drives are the only way the company learns that a leaver is still reachable; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET"], pattern: "/api/cron/crm-contact-lists", reason: "Daily refresh of each rep's assigned doctor list from the CRM web app (ContactsList.aspx), which the Reporting API does not expose at all. Sole writer of ireports360_contacts and the only path by which Phoenix learns of a doctor assigned to a rep but never planned and never visited; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/direct-orders-expire-held", reason: "Daily 14-day expiry sweep for held direct orders (spec B6), guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/direct-orders-probation", reason: "Daily 90-day probation sweep: promotes pharmacies with a footprint, reports phantoms (spec A3), guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET"], pattern: "/api/cron/direct-orders-rotate-sheet-token", reason: "Rotates the live Google Sheet's feed token so the bootstrap token committed in docs/direct-orders-live-sheet.gs is revoked and worthless; revokes the old link only after the sheet confirms the new one; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET"], pattern: "/api/cron/marketing-requests-rotate-sheet-token", reason: "Rotates the marketing live sheet's feed token — the counterpart to the direct-orders route above. Marketing shipped without rotation, and on 2026-08-05 its share-link table was found anon-readable with RLS off, exposing a token that reads every request in scope and opens the evidence photographs; revokes the old link only after the sheet confirms the new one; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET"], pattern: "/api/cron/cv-lifecycle-rotate-sheet-token", reason: "Rotates the CV-lifecycle live sheet's feed token — the third of the three. This one guards the most sensitive feed of the set: a bare bearer token, with no passcode possible because the consumer is a timer-driven Apps Script, that reads every candidate's name and phone number. It shipped without rotation, so its first token was minted by hand and never changed; revokes the old link only after the sheet confirms it has USED the new one; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET"], pattern: "/api/cron/run-synthetic-journeys", reason: "Asks GitHub Actions to run the production synthetic-journey smoke suite. Exists because GitHub does not honour the workflow's own schedule here — measured 2026-08-05, both workflows added that day never fired and the one that does runs 4.5-9h late — while cron-job.org fires on time. Keeps the GitHub dispatch PAT in Railway rather than in that third-party account; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/marketing-assignment-backfill", reason: "Tells the approver holding a marketing request that it is on their desk, for any request where that never happened. A decision recorded outside the app skips the notify path, so MKT-REQ-20260818-8C628BF4 reached Finance Execution on 2026-08-19 with zero deliveries on any channel while its sibling, decided in the UI 22 minutes earlier, reached the same person on three. Re-sends nothing — the notice keys on the step id against a UNIQUE idempotency index; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/marketing-field-capture-nudge", reason: "Tells each rep which of their marketing customers still show a validated status with no field capture behind them — in-app/Telegram/push only, never email, because 64 recipients is bulk by any reading. Split off the daily notification bundle on 2026-08-29: it joined that run in #2360 on 24 August and took it from 9s to 34s, past cron-job.org's unraisable 30s cut, so phoenix-notify-daily logged a red timeout every morning while Healthchecks recorded 36 of 36 successes. Re-sends nothing — the idempotency key carries the Cairo date; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/marketing-invoice-overdue-nudge", reason: "Tells the requester and finance that an approved marketing request's invoice has passed its deadline (owner decision 2026-08-29: \"the requester and finance\"). In-app/Telegram/push only, never email — marketing lateness reminders lost email in 2026-07-25 and marketing-sla-channel-guard.ts blocks this event type as a hard post-filter. Its own schedule rather than a 23rd sub-job on phoenix-notify-daily, which is already at cron-job.org's unraisable 30s cut. Re-sends nothing on a repeat run — the idempotency key carries the Cairo date and the summed day count; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/distributor-upload-overdue-nudge", reason: "Tells Super Admin and the SFE Manager which distributor files for the month just closed are later than that same distributor's file was last month (owner decision 2026-09-03, asked directly: sfe, plus you and Super Admins). Exists because nothing watched the eighteen hand-uploaded files the monthly closing is assembled from: July 2026 was built on four of its eighteen sources, 84% of its value absent, and every tab rendered immaculately. Judges each distributor against its own previous arrival day rather than one company-wide deadline, because July's files landed across ten days, so a single deadline would either nag ten distributors that are on time or stay silent on the one that is genuinely late. In-app/Telegram/push only, never email - the house rule for lateness reminders since 2026-07-25. Silent once the period is locked. Reads distributor names, periods and batch totals; no PII. Re-sends nothing on a repeat run - the idempotency key carries the Cairo date and the summed day count; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/recruitment-requisition-autopilot", reason: "The requisition autopilot (owner, 2026-10-16: no manual work in recruitment): hourly, opens an already-open requisition for each empty seat with none — owned by the Talent Acquisition seat, no approval, no notice — and fills or cancels each requisition whose seat row is filled or cancelled. Acts as the system through the requisition service and the workflow registry; parked seats and replacements for somebody still employed are left alone. dryRun=1 writes nothing." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/interview-reminders", reason: "Reminds the District Manager or above chosen to conduct an interview on the calendar (owner, 2026-09-20): the evening before from 5 PM Cairo with the day's list, and an hour before each interview — in-app, email and Telegram. Every ten minutes; a message's idempotency key means a repeat tells nobody twice. Reads the calendar as the system and notifies only the interviewer named on the row." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/phoenix-crm-daily-digest", reason: "Phoenix CRM's 06:55 Cairo digest (owner, 2026-09-26): to each DISTRICT MANAGER, about the previous field day, in-app + Telegram and never e-mail, which the module blocks on its module key. A CLEAN MANAGER IS TOLD NOTHING — most mornings most managers hear nothing at all, and that is the feature rather than the cron failing. Reads the whole company's exceptions board as the system, writes nothing, and its idempotency key is per manager per DAY so a retry or a double fire reaches nobody twice." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/phoenix-crm-plan-reminder", reason: "Phoenix CRM's \"your coming week is not sent\" reminder (owner, 2026-10-02), 12:57 and 17:57 Cairo: to the rep and their district manager, in the teams that have started, from the day a week is due until it starts. In-app, Telegram and push, never email; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/phoenix-crm-approval-nudge", reason: "Phoenix CRM's daily nudge to a slow approver (owner, 2026-10-02), 09:57 Cairo: whoever has a list request, an off-plan visit or a request to edit a week waiting on them for more than 24 hours at their step — the territory's district manager (the decide rule's own reviewer) or the SFE Manager — gets ONE message naming the counts by kind, opening Team. Real entries only; nothing already decided is ever named. Reads the three waiting queues as the system and writes only notifications. In-app, Telegram and push, never email; one message per approver per Cairo day, so a retry or a double fire reaches nobody twice; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/phoenix-crm-fraud-scan", reason: "Phoenix CRM's weekly visit-fraud scan (owner, 2026-10-07), Thursday 07:00 Cairo: the integrity board's flags for the completed Sat–Wed working week — the GPS detector's (mock provider, coordinate replay, impossible travel, zero jitter, coarse location) and the nightly photo sweep's — summarised to the Super Admin and the SFE Managers, and nobody else. It judges nothing of its own: it re-runs no detector and sets no threshold, reading phoenix_crm_location_integrity through the board's single reader and summarising the week. Golden Rule #1 holds — the rep is never told, the audience is the two admin roles, and the GPS (position) cases are the Super Admin's alone, so the SFE copy is the photo cases only. In-app and Telegram ONLY — never email or push (crm_fraud_scan is on PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES). It reports a clean week too, so a report that only appears with bad news cannot be mistaken for one that stopped. Reads as the system and writes only notifications; the idempotency key is per recipient per week so a retry or double fire reaches nobody twice; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/private-calendar-gap-notice", reason: "The employee's own unexplained-day notice (owner, 2026-10-08), Saturday 08:09 Cairo: one in-app and push notice per employee whose Private Calendar has a day in the completed Sat-Thu week with nothing recorded on it, saying that Request review is how to answer it. Measured the same day: the control had been used ONCE since 22 July across 111 active employees, because nothing ever told anybody to look. It judges nothing of its own - the days come from getCompanyNoActivityDays, the same engine call the Deductions module's No Records Activity connector makes and the same exceptions the employee's own calendar renders, so the day the notice names, the day the calendar shows and the day that can become a deduction candidate are one day by construction. The audience is the EMPLOYEE ALONE - never the manager, never HR, and never an admin digest: a recording gap is not an accusation, and nobody else is told before the employee has had the chance to answer. NEVER email (bulk outbound email from a business system is banned, and every automated email mirrors to the owner's Telegram) - in-app and push only. A day already carrying a review request of any status is named to nobody, and that suppression read fails CLOSED. Reads as the system and writes only notifications; the idempotency key is per employee per week so a retry or double fire reaches nobody twice; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/phoenix-crm-visit-rollup", reason: "Phoenix CRM's hourly routine-visit rollup (owner, 2026-10-05): the batched half of the activity mirror — routine PLANNED visits, about 600 a working day, gathered into ONE message an hour per in-scope manager (the national sales manager in the rep's chain, about the visits beneath them; and every SFE Manager, about every routine visit in the hour) instead of one notice each. A quiet hour tells nobody and overnight sends nothing. In-app and Telegram ONLY — never email or push (crm_visit_rollup is on PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES). Reads one keyset-paged hour of visits as the system and writes only notifications; the idempotency key is per manager per hour so a retry or double fire reaches nobody twice; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/rep-ranks", reason: "Phoenix Ranks' nightly rebuild (owner, 2026-10-05), 04:17 Cairo: scores every medical rep of every line on eight equal measures for every window holding yesterday (day, week, month, quarter, semester), reading Phoenix CRM only (its countable visits, lists, plans, start presses) plus approved leave, and writing only its own table, rep_rank_standings. Sends nothing. ?backfill=YYYY-MM rebuilds one past month instead, under the same guard. Safe to fire twice: every write is an upsert on the window and the rep. Guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/phoenix-crm-integrity-sweep", reason: "Phoenix CRM's nightly 03:35 Cairo photo sweep (owner, 2026-09-25, Golden Rule #1: \"close this hole whithout reps knowing\"). Fingerprints every visit and place photo it has never read — a sha256 for the same FILE re-sent, and a 64-bit difference hash for the same PICTURE re-encoded, which the sha256 misses — then files a duplicate as evidence. IT SENDS NOTHING AND TELLS NOBODY, in either direction: no rep is warned and no manager is notified, because a nightly alert about a rep's honesty is a rumour on a schedule and a rep who hears about a check learns what to defeat. Evidence lands in phoenix_crm_location_integrity under source='photo', readable only by the Super Admin and the SFE Manager. Reads photo objects and writes only its own two tables; safe to fire twice, because the photo path is the identity and a second fingerprint of one photo is ignored. Guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/production-planning-fx", reason: "One USD to EGP rate a day for the production planner, 06:07 Cairo, so a price the owner typed in dollars keeps deriving a pound figure that is current (the owner's instruction, 2026-10-05: one currency is typed and the other derived). Keyless public endpoint, 10s timeout, one upsert against today's Cairo date. It never overwrites a good rate with nothing — a failed read records fetch_ok = false and the reason and leaves the last good rate standing — and never touches the rate the owner set by hand, which is a separate column that wins at read time. Gated by its own pair of settings switches, `fx_fetch_enabled` and `fx_fetch_dry_run`, both read fail-safe. Sends no email and reads no PII; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/production-planning-reorder", reason: "The Ivyronc reorder alarm, 06:11 Cairo: the raw materials Sato supplies whose stock cover has fallen to about one more production run, emailed to Dr. Sahar Khalil with the CEO and the Finance and Admin Manager copied and the owner blind-copied (the owner's named recipients, 2026-10-05). It exists because the imported material takes about six months to arrive and the owner said plainly that it would otherwise be forgotten. SILENT UNTIL THE OWNER ARMS IT: `alarm_enabled`, `alarm_dry_run`, the template's `is_active` (it ships inactive) and EMAIL_NOTIFICATIONS_ENABLED are four independent switches, each fail-safe on its own, and none of them a default. A disabled pass answers skipped rather than a zero; a dry-run pass writes the rows a real pass would and sends nothing. Reads material names, stock figures and lead times; no PII. Re-sends nothing on a repeat run — the idempotency key carries the Cairo date, the number of materials and the worst cover; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET"], pattern: "/api/cron/mapping-guard-notify", reason: "The attribution freshness clock: every few minutes it re-derives the rollup of any period whose attribution fingerprint has drifted after a mapping change, so achievement reads keep serving the precomputed rollup. It carried the Mapping Guard alert until the owner retired the guard on 2026-10-10; the path and job name stay because the clock that calls it lives on cron-job.org. Touches no sales row and no published month; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/retention-risk-sweep", reason: "Tells HR Operations, HR Advisory, Super Admin, the SFE Manager and the subject's own line manager when an employee reaches five consecutive working days of recorded leave, or a Medical Rep reaches five consecutive working days with no CRM entry of any kind (owner instruction 2026-09-06, recipients chosen by him). Exists because payroll pays Part 1 at the start of the month and Part 2 the day after, and people collect both and resign: 23 of 59 recorded resignations land in the first ten days of a month, five medical reps resigned on 9 August 2026 alone, and four of those five had gone quiet in the CRM five or more days earlier with nothing raised. In-app, email and Telegram; never push, which would put a named employee on a lock screen. Reads the employee directory, the CRM visits mirror and leave requests; the notification body carries employee names, so it is PII-bearing and its audience is role-gated rather than open. Re-sends nothing on a repeat run — the idempotency key carries each streak's START date, so one announcement per streak; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/retention-risk-pre-payroll", reason: "The pre-payroll \"take care, HR\" digest: one message listing every employee currently flagged for retention risk, sent on the 25th so there are working days left to check on somebody before Part 1 pays. Owner instruction 2026-09-06, who asked for this AND a second notice when Part 1 is confirmed in the wizard — the two carry different `reason` values in the idempotency key so neither suppresses the other. Same audience, channels and PII footprint as /api/cron/retention-risk-sweep. Sends even when nobody is flagged: a notice that appears only when there is bad news cannot be told apart from one that has silently stopped working. Guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/brevo-keepalive", reason: "Resets Brevo's 90-day inactivity expiry on the email failover key and reports a revoked key; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/reconciliation-check", reason: "Read-only reconciliation harness comparing each domain service against an independent derivation; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/db-health-snapshot", reason: "Snapshots pg_stat_statements into pg_stat_statements_snapshots so slow-query history is retained and queryable. Exists because neither log_min_duration_statement nor track_io_timing can be enabled here — Supabase's config API rejects both keys and ALTER DATABASE refuses them as superuser-context GUCs — which is how the 2026-08-10 audit found a 17.5s query that had run 192 times unreported. Reads server statistics only and writes no business data; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/expense-claims-refresh", reason: "Rebuilds the expense_claims read mirror from the legacy outstation tables. Reads have been live on that mirror since 2026-08-12 while writes still go to legacy, so it is correct only for as long as something rebuilds it — and phx_refresh_expense_claims() had no caller at all, so it drifted for ten days and hid 31 approved claims worth EGP 15,294.74 from the approvals queue. Reads and rewrites no business data of its own; the mirror is derived entirely from the legacy tables. Reports parity in the response body, because a 200 here means the rebuild ran, not that the mirror is correct; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/territory-restamp", reason: "Nightly re-stamp of OPEN Source-of-Sales periods to today's geography — the scheduled counterpart to the Territory Drilldown's Sync button, which was the rule's only trigger even though what breaks it is silent (one employee insert auto-seats them and flips line_area_map.area_state, staling 8 of 8 periods off 3 inserts with no error). Skips every period with a published closing, because publishing does not freeze a closing's figures — snapshot_units was NULL on every published row on 2026-08-29 — so re-stamping one would move numbers under a closing already sent. Notifies nobody by design; its trace is the audit row the sync already writes. Guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/brick-move-drain", reason: "Finishes a brick move that sos_relocate_brick only half-applied. The move re-stamps the brick master, the customer map and the import rows at once; the sales files whose TOTALS still need rebuilding wait in source_of_sales_brick_move_files, and until 2026-10-13 the only thing that drained that queue was the poller on the Database Mapping screen — so closing the tab stranded the move with no error, badge or alert, and the قوص and أبنود moves left 71 files unrebuilt for a full day while every Qena figure on every screen read pre-move. Rebuilds rollups for up to four minutes a fire, then settles the stored store-split net for the periods those files touched — never a published month, which the database freezes by design — and pages in-app/Telegram/push when the queue stops emptying or when a residue is left that nothing will retry. Reads and rewrites sales aggregates only: no PII in the notification bodies beyond brick and period names; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "cron-secret", methods: ["GET", "POST"], pattern: "/api/cron/job-heartbeat-sweep", reason: "Sweeps public.job_heartbeats — the in-house dead-man's switch — and pages in-app/Telegram/push when a scheduled job has stopped reporting. Exists because the external switch (Healthchecks.io) is capped at 20 checks on its free tier and was full: POST /checks/ answered 403 for the 21st on 2026-08-30, so four declared jobs had switch code shipped and nothing watching them. Judges each job against its own cron expression rather than an elapsed interval, because several schedules here are windowed and an interval rule calls them stranded every afternoon. Reads and writes only job names and timestamps — no business data, no PII; guarded by CRON_SECRET." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/health/email", reason: "Unauthenticated health check; reports env-var presence only, no secrets or PII." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/healthz", reason: "Unauthenticated Cloud Run liveness probe; returns status/revision only, no data or secrets." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/readyz", reason: "Unauthenticated readiness probe; returns dependency booleans + missing-env NAMES only, never values." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "POST"], pattern: "/api/email/unsubscribe/:token", reason: "RFC 8058 one-click unsubscribe protected by a signed, expiring HMAC token; write-only suppression action, exposes no data." }),
  tokenApi({ authMode: "public-token", methods: ["GET", "POST"], pattern: "/api/public/apply", reason: "The satopharma.com/careers application endpoint. GET returns the live question schema for a role; POST accepts a CV plus answers and feeds them straight into the Candidates pipeline (channel \"website\"). A website visitor has no Phoenix session, so this is deliberately unauthenticated and CSRF-exempt (posted cross-origin from the careers site, hence the explicit exemption in proxy.ts) — containment is a per-IP rate limit, a reCAPTCHA verifier, and a CORS allowlist that lets only satopharma.com read a reply. Writes only through the same ingest the WhatsApp/email intake uses; exposes no data back to the caller beyond ok/errors." }),
  // The offer joining form (owner, 2026-10-08). The candidate presses Accept in the offer email and
  // lands on /join/[token] with no Phoenix account; Submit IS his acceptance and creates his record.
  tokenApi({ authMode: "public-token", methods: ["POST"], pattern: "/api/public/offer-acceptance/:token", reason: "The offer joining form's Submit, which is the candidate's acceptance. The candidate has no Phoenix session, so the HMAC-signed, expiring offer token is the credential; the offer row is re-read and claimed with a conditional update before any write, every answer is validated server-side, only the candidate's own personal fields are taken from the body (job, seat and pay come from the offer), and it is rate-limited per link and per IP. Posted same-origin from /join/[token]." }),
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/public/apply/counts", reason: "Read-only applicant COUNTS for the satopharma.com careers panel. GET returns, per public role, how many candidates applied for it — and for the field-force roles a per-region/area breakdown — computed from ats_candidates' stated applied-for title or a matching requisition link. Aggregate only: no name, email or per-person field ever leaves this route, which is why it needs neither reCAPTCHA nor the apply rate limit. The Sato backend reads it server-side to fill each panel job's badge." }),

  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST", "PATCH"], pattern: "/api/admin/users/**", permission: [{ resource: "admin_access", action: "read" }, { resource: "user_admin", action: "update" }] }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PATCH"], pattern: "/api/admin/permissions", permission: [{ resource: "admin_access", action: "read" }, { resource: "permission_admin", action: "update" }] }),
  // PM product master: Super Admin writes, CEO/SFE Manager/Super Admin read — enforced
  // in-route by role (domain-helper), like the system-issues admin routes.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/admin/pm-products", permission: null, guard: "domain-helper" }),
  // Pharmacy Search. Access mirrors the Customers Database hub it is listed under: Super Admin and
  // CEO short-circuit, everyone else needs sales:import. That short-circuit is why these carry
  // `guard: "domain-helper"` — the enforcement is assertPharmacySearchAccess() rather than a bare
  // assertPermission call — while `permission` still records the resource a normal user is checked
  // against, so this registry keeps saying what actually gates the route.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/pharmacy-search", permission: { resource: "sales", action: "import" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/pharmacy-search/profile", permission: { resource: "sales", action: "import" }, guard: "domain-helper" }),
  // Reads nothing of ours — it spends a billed Google Places call per request, which is why it is
  // its own entry rather than inheriting a blanket: the cost of an unguarded loop here is money.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/pharmacy-search/external", permission: { resource: "sales", action: "import" }, guard: "domain-helper" }),
  // The one write in the feature. It records a Google-derived pharmacy in its own discovery
  // register and never touches source_of_sales_customer_map, so it cannot move sales attribution.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/pharmacy-search/save", permission: { resource: "sales", action: "import" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/logs", permission: { resource: "admin", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/errors", permission: { resource: "admin", action: "read" } }),
  // System Issues dashboard is CEO + Super Admin (checks access.role === "CEO" ||
  // canAccessSystemAdministratorWorkspace(access) directly) rather than the "admin"
  // permission resource, which is hard-locked to Super Admin only.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues/attempts", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues/repro-trail", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues/security", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/system-issues/notify-user", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/system-issues/timeline", permission: null, guard: "domain-helper" }),
  // Super-Admin-only: blocking/unblocking a login IP changes who can authenticate.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/system-issues/block-ip", permission: null, guard: "domain-helper", csrfRequired: true }),
  // AI triage — POSTs that call OpenAI (cost); CEO + Super Admin only, rate-limited in-route.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/system-issues/explain", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/system-issues/summary", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Notification Recipients editor (which roles get told about a cron-triggered system
  // notification): Super Admin only end-to-end, both view and edit — there's no "CEO needs to
  // see this" oversight story for internal notification-routing plumbing. Its page is
  // /admin/notification-recipients, which is also where AGENTS.md 2.3 sends an operator to
  // silence or retarget the stranded-drain alert.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/notification-recipients", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/notification-recipients/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Distribution lists (named recipient groups) and the Turbify alias register: Super Admin, plus
  // the HR Business Partner narrowed to the HR-owned lists — the boundary is
  // @/lib/distribution-lists/access, and the per-list check lives in the [listKey] route rather
  // than only on the screen. Same reasoning as notification-recipients above: editing one changes
  // who receives company mail, which is routing plumbing rather than an oversight surface.
  //
  // ⚠ CORRECTED 2026-09-12. This note read "Super Admin only end-to-end", which stopped being true
  // when the owner asked that she reach that screen. A registry comment claiming a narrower
  // audience than the code allows is the one kind of staleness this file cannot afford.
  //
  // Neither route sends anything; the alias half cannot even reach a mailbox, because Turbify has
  // no API and its output is a worklist somebody applies by hand. The only sender that reads a
  // list is the Sato Email Composer, registered below.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/distribution-lists", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/distribution-lists/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/email-aliases", permission: null, guard: "domain-helper", csrfRequired: true }),
  // The Sato Email Composer: Super Admin and the HR Business Partner, gated by canUseSatoEmail in
  // @/lib/sato-email/access. Owner 2026-09-11: "This module would be accessible for HR business
  // partner and the system administrator."
  //
  // 🔴 THIS IS THE ONE SURFACE HERE THAT ACTUALLY PUTS MAIL IN SOMEBODY'S INBOX, and `send` is the
  // route that does it — everything above this block edits routing and sends nothing. A sent email
  // cannot be recalled, so the send route carries a 5-per-minute limit and a required audit row of
  // its own beside the `sato_email_sends` record.
  //
  // `preview` is a POST that writes nothing: the draft is a whole email and has no business in a
  // URL. It is classified as a read because that is what it is.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/sato-email/employees", permission: null, guard: "domain-helper" }),
  // `polish` is the same shape as `preview`: a POST because the draft is a whole email, and a
  // read because it changes nothing. It calls a model to rewrite the sender's own wording and
  // hands it straight back to his screen — no row is written, no mail leaves.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/sato-email/polish", permission: null, guard: "domain-helper", csrfRequired: true }),
  // `document` is `polish` with the facts coming out of a file the sender uploaded — he attaches a
  // paper and it writes the email that carries it. A read for the same reason: the file is read in
  // memory, nothing is stored, no row is written and no mail leaves. It is a multipart POST, so the
  // same-origin check matters more here than anywhere else on this domain.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/sato-email/document", permission: null, guard: "domain-helper", csrfRequired: true }),
  // `media` is the upload behind the attach button and the toolbar Insert image, classified as a
  // mutation because it writes an object and a row — and because an `inline` upload mints a
  // PERMANENT PUBLIC ADDRESS for that picture (served by the token route above), which is a thing
  // that should be answerable later. Same gate as everything else here; an upload endpoint on this
  // domain reachable by anyone else is not a feature.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/sato-email/media", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/sato-email/preview", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/sato-email/send", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/sato-email/templates", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/sato-email/templates", permission: null, guard: "domain-helper", csrfRequired: true }),
  // The CEO Email Composer: the chief executive and the Super Admin, gated by canUseCeoEmail in
  // @/lib/ceo-email/access. Owner 2026-10-06: "a module thats called ceo email composr exactly as
  // sato email composer copy paste but a more corporate templete".
  //
  // 🔴 THE SECOND SURFACE THAT PUTS MAIL IN SOMEBODY'S INBOX, and it signs with the chief
  // executive's name — so `send` carries the same 5-per-minute limit and the same required audit row
  // as its Sato sibling above. The signature itself is NOT in the posted draft: it is resolved
  // server-side from the employee directory on every render (@/lib/ceo-email/identity), because the
  // Super Admin seat can open this screen too and a name on the wire would be a name that seat
  // could set.
  //
  // Every classification here is the Sato block's, for the reasons stated there: `preview`, `assist`
  // and `document` are POSTs because a draft is a whole email with no business in a URL, and reads
  // because they write no row and send no mail.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/ceo-email/assist", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/ceo-email/document", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/ceo-email/employees", permission: null, guard: "domain-helper" }),
  // Writes into the SAME object store as the Sato composer's upload, so the one public token route
  // registered above stays the only anonymous address in this area — a second one would be a second
  // thing to reason about. A mutation for the same reason as its sibling: an `inline` upload mints a
  // permanent public address for that picture.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/ceo-email/media", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/ceo-email/preview", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/ceo-email/send", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/ceo-email/templates", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/ceo-email/templates", permission: null, guard: "domain-helper", csrfRequired: true }),
  // `transcribe` turns one spoken clip into text and hands it straight back to his own screen. A
  // read: the audio is held in memory for the length of the call, nothing is stored, no row is
  // written and no mail leaves. Multipart, so the same-origin check matters here as on `document`.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/admin/ceo-email/transcribe", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Email Control Center: a read-only rollup over the 3 systems above plus email-templates —
  // view = CEO + Super Admin, edit = Super Admin only (matches
  // notification-recipients), since every write here dispatches straight into those systems'
  // own existing update functions rather than a new mechanism of its own.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/email-control-center", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/admin/email-control-center/**", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Mailbox compliance monitor — the most sensitive read surface in the app (an admin reading an
  // employee's company mailbox). Super Admin only, enforced by the mailbox_monitor hard boundary in
  // permissions.ts. Every method is audited; each live IMAP read also writes mailbox_monitor_access_log.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/mailbox-monitor", permission: { resource: "mailbox_monitor", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/mailbox-monitor", permission: { resource: "mailbox_monitor", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/mailbox-monitor/:id", permission: { resource: "mailbox_monitor", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH", "DELETE"], pattern: "/api/admin/mailbox-monitor/:id", permission: { resource: "mailbox_monitor", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/mailbox-monitor/:id/messages", permission: { resource: "mailbox_monitor", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/mailbox-monitor/:id/message", permission: { resource: "mailbox_monitor", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/workflow-control/**", permission: { resource: "workflow_registry", action: "update" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/workflow-registry/**", permission: { resource: "workflow_registry", action: "update" } }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/email-templates/**", permission: { resource: "communication", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/email-composer/**", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notifications/telegram/templates", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "PATCH"], pattern: "/api/admin/notifications/telegram/templates", permission: { resource: "communication", action: "update" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notifications/telegram", permission: { resource: "communication", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "PATCH"], pattern: "/api/admin/notifications/telegram", permission: { resource: "communication", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/email-reply/send", permission: { resource: "communication", action: "update" } }),
  // Super-Admin-only via assertSystemAdministratorWorkspaceAccess (direct role check), not
  // the permission matrix — same pattern as the visits-report/backfill entry below.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/vacation/company-report/export", permission: null, guard: "domain-helper" }),
  // Converts one CRM-signal row into a real, balance-deducting vacation_requests row —
  // Super-Admin-only, same direct-role-check pattern as the export route above. Individual,
  // human-reviewed decisions only; never a bulk write.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/vacation/company-report/approve", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Super Admin + SFE Manager only, via assertCompanyActivityReportReadAccess (direct role
  // check) — same pattern as the vacation company-report export above, not the permission matrix.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/company-activity-report/export", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/monitoring/events-csv", permission: { resource: "admin", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET", "POST"], pattern: "/api/admin/data-backup", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: ["GET"], pattern: "/api/admin/data-backup/status/:jobId", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/data-backup/download/:jobId", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/exports/table", permission: { resource: "overview", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Company-wide unscoped iReports360 data sync utility; checks access.role === "Super Admin"
  // directly rather than the permission matrix. Both routes now back the CRM hub (/admin/crm)
  // directly — the curated visits-report/export route was retired when its page merged into the
  // hub's own (superset) master-export.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/visits-report/backfill", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/visits-report/resolve-identity", permission: null, guard: "domain-helper", csrfRequired: true }),
  // CRM master table XLSX export: returns all rows for the current dataset+filters. Super-Admin-gated
  // inline (same as the /admin/crm page), so guarded by the domain helper, not the permission matrix.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/crm/master-export", permission: null, guard: "domain-helper" }),
  // Portal-scoped CRM export — the portal twin of the admin route above. Enforces crm_visits:read
  // plus the per-viewer row scope (isPortalCrmRole + resolvePortalCrmScope) inside the handler, so
  // like its admin sibling the fine gate is the domain helper, not the permission matrix alone.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/crm/master-export", permission: { resource: "crm_visits", action: "read" }, guard: "domain-helper" }),
  // Region Mapping tab resolver: assigns a CRM region to a real Phoenix brick. Same posture as
  // resolve-identity above — checks access.role === "Super Admin" directly.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/resolve-region", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Region Mapping bulk download/upload template — same Super-Admin-gated posture as the
  // single-row resolver above.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/crm/region-mapping/template", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/region-mapping/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Customer Mapping tab: one level finer than Region Mapping above (CRM customer/contact -> brick,
  // not CRM region -> brick). Same Super-Admin-gated posture, checks access.role directly.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/resolve-customer", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/crm/customer-mapping/template", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/customer-mapping/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  // New Hire CRM Setup: records a newly created employee's CRM username and code, or that they
  // need no CRM account. Same posture as the CRM resolvers above — the fine gate is
  // canUseAdminCrmWorkspace (Super Admin + SFE Manager), not the permission matrix, because this
  // writes two columns on an employee and the SFE Manager deliberately does NOT hold
  // employees:update. Audited as a mutation: it is a write to the employee master, reached from a
  // screen whose whole purpose is that somebody acted on a notification.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/crm/account-setup", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/field-workforce-compliance/**", permission: { resource: "hr_calendar", action: "read" } }),
  // Field Activity — one person's field days, read-only. The matrix key is the coarse gate; the fine
  // one is `resolveFieldActivityAccess`, which refuses every role outside the module's own list (the
  // Medical Rep above all — CRM golden rule #1 keeps the rep blind to what measures him) and then
  // narrows to the viewer's org-tree scope. GET only: this module reads and never writes.
  sessionApi({ methods: ["GET"], pattern: "/api/admin/field-activity/**", permission: { resource: "double_visit_analytics", action: "read" } }),
  // Unified Deductions module — the sole deductions pipeline as of the C6 cutover (2026-08-30); the
  // legacy deductions-governance routes it replaced were removed in the same change. Every route
  // self-gates with assertPermission + the Super-Admin-only assertDeductionsDecisionActor for
  // mutations.
  //
  // Each entry now names the action its handler actually asserts. Until 2026-09-03 all eleven said
  // `read`, described here as "the coarse baseline gate" — which is what licensed the drift: six of
  // them were reading as though downloading every employee's amounts, approving a deduction and
  // publishing a month were all read-gated. Nothing was mis-enforced, because this registry is a
  // declarative inventory that no request path imports, but an auditor reading it was told the
  // mutation routes were open to any reader. `assertRegistryMatchesHandlers` in
  // tests/access-registry-coverage.test.ts now fails if a declared action and its handler disagree.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/candidates", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/filters", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/export", permission: { resource: "deductions", action: "export" }, guard: "domain-helper" }),
  // The whole-month master workbook (every category, summary + detail). Separate path segment from the
  // per-category export above, so it needs its own entry; same export gate + Super-Admin/CEO/Finance read actor.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/export/master", permission: { resource: "deductions", action: "export" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/decisions", permission: { resource: "deductions", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  // Deduct from leave balance / Return to salary (owner, 2026-10-09): a CRM or half-day deduction paid from annual leave. Same approve gate and Super-Admin check as the decision itself.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/leave-balance", permission: { resource: "deductions", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/leave-balance", permission: { resource: "deductions", action: "approve" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/summary/employee", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/summary/company", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/comments", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  // The sidebar badge for the Deduction Disputes inbox (its own row under the Approvals tab since
  // 2026-10-08). Counts the threads whose newest line came from the employee's side; no audit row,
  // because every open tab polls it every 30 s and it reads nobody's figures, only how many are
  // waiting. The route adds assertDeductionsReadActor on top of this matrix gate, which is what
  // keeps a seat holding deductions:read for its own portal line out of the company-wide count.
  sessionApi({ methods: ["GET"], pattern: "/api/deductions/disputes/pending-count", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/comments", permission: { resource: "deductions", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/collect", permission: { resource: "deductions", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/manual", permission: { resource: "deductions", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/settlement", permission: { resource: "deductions", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/deductions/publish", permission: { resource: "deductions", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/deductions/publish", permission: { resource: "deductions", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/deductions/comments", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // One picture from a dispute reply. The employee it belongs to or an admin reader of the Deductions module
  // — readDisputeAttachmentForViewer decides before any byte is read. Not audited: it is an image behind the
  // conversation the portal already shows, fetched once per thumbnail.
  sessionApi({ methods: ["GET"], pattern: "/api/deductions/comments/attachments/:id", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/double-visit-analytics/export", permission: { resource: "double_visit_analytics", action: "export" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/double-visit-analytics/audit-export", permission: { resource: "double_visit_analytics", action: "export" }, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/admin/double-visit-analytics/**", permission: { resource: "double_visit_analytics", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/outstation/expense-command/export", permission: { resource: "outstation", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/outstation/**", permission: { resource: "outstation", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/admin/system-cleanup/**", permission: { resource: "system_cleanup", action: "delete" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: allMethods, pattern: "/api/admin/profile", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PATCH"], pattern: "/api/admin/support-requests", permission: { resource: "support_requests", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PATCH"], pattern: "/api/admin/business-card-requests", permission: { resource: "business_card_requests", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/admin/activity/timeline", permission: { resource: "user_activity", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/activity/export", permission: { resource: "user_activity", action: "export" } }),
  sessionApi({ audit: { classification: "access-read", required: false }, methods: readOnly, pattern: "/api/admin/activity/live", permission: { resource: "user_activity", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/activity/force-logout", permission: { resource: "user_activity", action: "export" }, csrfRequired: true }),
  tokenApi({ authMode: "machine-token", methods: ["POST"], pattern: "/api/admin/synthetic-journeys/ingest", reason: "Synthetic journey runner bearer-token ingestion route; protected by SYNTHETIC_INGEST_TOKEN." }),
  // Temporary module locks. Its own entry rather than the /api/admin/** blanket below, which states
  // `admin:read` — this route CLOSES a module on somebody's account, so it declares the update it
  // actually performs and carries the CSRF requirement a mutation owes.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST", "DELETE"], pattern: "/api/admin/module-locks", permission: { resource: "admin", action: "update" }, csrfRequired: true }),
  // Test accounts (src/lib/auth/test-persona.ts). Its own entries rather than the /api/admin/** blanket
  // below: these routes CREATE logins and mint their one-time password links, so they declare the
  // user-administration update they perform (the service also demands the Super Admin role).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST", "PATCH"], pattern: "/api/admin/test-accounts", permission: { resource: "user_admin", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/test-accounts/password-link", permission: { resource: "user_admin", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  // WhatsApp screening questions, and the AI question-prompt helper beside them. Their own
  // entries rather than the /api/admin/** blanket below, which states `admin:read`, because
  // that is no longer what gates them. On 2026-09-01 the owner asked for this screen to reach
  // the HR Business Partner; `admin:update` was the wrong door to widen, since it also gates
  // module locks, scope visibility, salary flags and a notification TEST-SEND endpoint. So the
  // screen was re-gated to `recruitment:update` with the admin assertion kept underneath as the
  // fallback -- which is exactly the pharmacy-search shape above: `guard: "domain-helper"`
  // because enforcement is assertScreeningQuestionsAccess() rather than a bare assertPermission
  // call, while `permission` still records the resource a normal user is checked against, so
  // this registry keeps saying what actually gates the route.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST", "DELETE"], pattern: "/api/admin/screening-questions", permission: { resource: "recruitment", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/admin/question-prompts", permission: { resource: "recruitment", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  // The third editor on the same screen: the automatic WhatsApp replies the bot sends by itself.
  // Same helper, same gate, same reason the two above carry `guard: "domain-helper"`.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/admin/whatsapp-auto-replies", permission: { resource: "recruitment", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/admin/**", permission: { resource: "admin", action: "read" } }),

  sessionApi({ methods: allMethods, pattern: "/api/attendance/agent/**", permission: { resource: "employees", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/device-user-mappings/template", permission: { resource: "employees", action: "export" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/attendance/device-user-mappings/**", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/attendance/policies", permission: { resource: "employees", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // guard: "domain-helper" — gated via assertFingerprintReportPermission (CEO gets a
  // page-scoped exception to the employees hard boundary; see src/lib/auth/permissions.ts).
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/fingerprint-report/export", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/employee-fingerprint-export", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/attendance/monthly-summary/export", permission: { resource: "employees", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/sync-now", permission: { resource: "employees", action: "update" } }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/employee-attendance", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/exceptions", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/exceptions", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: ["PATCH", "DELETE"], pattern: "/api/attendance/exceptions/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/holiday-calendar", permission: { resource: "employees", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/holiday-calendar", permission: { resource: "employees", action: "update" }, guard: "domain-helper", csrfRequired: true }),

  // Weekly attendance review (release flow 2026-09-15). The employee routes carry the
  // plain `attendance:read` grant because they are self-scoped INSIDE the service —
  // listMyDigests takes no employee parameter, and answerDigestLine asserts the
  // digest's own owner — so the grant opens a door to your OWN released week and
  // nobody else's. The review, release, build, mark and dispute routes are guard:
  // "domain-helper" instead: they show and decide other people's pay, so
  // canReviewDisputes gates them on Super Admin or the configured reviewer list ON
  // TOP of the matrix grant, and release, build and mark (ticking the days to deduct)
  // narrow further to the Super Admin alone (canManageWeeklyReview). A matrix grant alone is what once let a Regional Manager
  // export 69 employees' deduction amounts.
  sessionApi({ methods: readOnly, pattern: "/api/attendance/digests", permission: { resource: "attendance", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/digests/:id/answer", permission: { resource: "attendance", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/weekly-review", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/weekly-review/release", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/weekly-review/build", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/weekly-review/lines/:lineId/mark", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/attendance/disputes", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/attendance/disputes/:lineId/review", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),

  // Business Review workbook export. Gated by a direct allow-list of CEO / SFE Manager /
  // Super Admin rather than the permission matrix — the same direct-role-check pattern as the
  // vacation company-report export above — because the module is a fixed executive surface,
  // not a permissioned resource. It reads LIVE company performance for whatever window the
  // caller asks for (it used to serve a bundled snapshot), so the audit row carries the window
  // that is actually in the file — see app/api/business-review/export/route.ts.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/business-review/export", permission: null, guard: "domain-helper" }),
  // The Sales Review pack. Same shape as the export above, and the same reason: the scope is
  // resolved inside the route from the SESSION and never read from the request, so there is no
  // permission to name here — a district manager exporting gets his own district and nothing else.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/business-review/pack", permission: null, guard: "domain-helper" }),

  sessionApi({ methods: allMethods, pattern: "/api/coaching/**", permission: { resource: "coaching", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/contracts/**", permission: { resource: "contracts", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/coaching/reports/export", permission: { resource: "coaching", action: "export" }, guard: "domain-helper" }),
  // `recruitment`, not `vacancies` — moved 2026-09-01 with the route itself, so this declaration
  // keeps describing what the handler enforces. See app/(admin)/cv-database/page.tsx for why.
  // The template row's action is `read` because that is what the handler asserts; the `export`
  // written here before matched nothing in that file and was already describing a gate that did not
  // exist. The audit classification stays `export` — it is a download, whatever verb admits it.
  sessionApi({ methods: allMethods, pattern: "/api/cv-database/**", permission: { resource: "recruitment", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/cv-database/template", permission: { resource: "recruitment", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/employees/template", permission: { resource: "employees", action: "export" } }),
  sessionApi({ methods: allMethods, pattern: "/api/employees/**", permission: { resource: "employees", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/employee-portal/profile-photo", permission: { resource: "employee_profile", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PATCH"], pattern: "/api/employee-portal/account-activation", permission: [{ resource: "account_activation", action: "read" }, { resource: "account_activation", action: "update" }], csrfRequired: true }),
  // The portal home screen as JSON, for the native Android app. It asserts exactly what
  // `app/employee-portals/page.tsx` asserts and returns what the same domain service returned, so
  // the two clients cannot disagree; no audit row, like its sibling portal GETs, because reading
  // your own landing screen is not an access event. The route drops `latestPayslip` before
  // answering — no payslip belongs on any landing surface for any role.
  sessionApi({ methods: readOnly, pattern: "/api/employee-portals/home", permission: { resource: "employee_profile", action: "read" } }),
  // Which portal modules this viewer has, for the app's Modules tab — the native counterpart of the
  // web sidebar. Same gate and same reasoning as `home` above: it resolves visibility with the exact
  // call EmployeePortalServerShell makes and returns a list of destinations, never any module's data,
  // so reading your own navigation is not an access event. Every page behind a row still asserts its
  // own permission when it opens; a row is a door the viewer can see, never a grant.
  sessionApi({ methods: readOnly, pattern: "/api/employee-portals/navigation", permission: { resource: "employee_profile", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/excuses/**", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/exports", permission: { resource: "probation", action: "export" }, guard: "domain-helper" }),
  // Split for the same reason the hiring pack below is: the blanket said `read` for a PATCH that
  // changes a checklist, and a registry that understates what a route can do is worse than no
  // registry entry, because it reads as though somebody checked.
  // The readiness workbook. Listed ABOVE the blanket so the more specific pattern is the one that
  // answers: reading it is still `employee_documents:read`, but a GET that hands over a file naming
  // many employees, their hire dates and the paperwork each of them is missing is an EXPORT, and
  // the registry says so — the route writes its audit row with the filters that decided who is in
  // it. Rate-limited in the handler, and gated again on an HR authority role, as the page is.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/hiring-documents/export", permission: { resource: "employee_documents", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/hiring-documents/**", permission: { resource: "employee_documents", action: "read" } }),
  sessionApi({ methods: ["PATCH", "POST", "DELETE"], pattern: "/api/hiring-documents/**", permission: { resource: "employee_documents", action: "update" }, csrfRequired: true }),
  // The scans and photographs behind the ticks. Reading one streams a birth certificate or a
  // national ID out of a private bucket, so it stays on `employee_documents:read` and never on a
  // public URL; attaching and deleting are `update` and same-origin only.
  sessionApi({ methods: readOnly, pattern: "/api/hiring-documents/files/**", permission: { resource: "employee_documents", action: "read" } }),
  sessionApi({ methods: ["POST", "DELETE"], pattern: "/api/hiring-documents/files/**", permission: { resource: "employee_documents", action: "update" }, csrfRequired: true }),
  // The HR forms pack — the printable contract, Form 1, Form 6 and the two Ministry of Labour exit
  // templates — is the same workflow as the tracker above seen from the other end, so it is gated
  // on the same resource. Reading or printing needs `read`; saving either profile, recording a
  // signature, and the field-layer editor (moving, adding or deleting a printed field, including its
  // DELETE verb) need `update`, which is why this is two entries and not one blanket: a blanket
  // would say `read` and quietly understate what a PUT or DELETE can do. The `**` covers the
  // offboarding profile route and the field-layer route deliberately — a separate resource for
  // either would let them drift from the documents they describe, so that somebody could print a
  // Form 6 for an employee whose own checklist they cannot open, or move a field on a form they
  // cannot fill in.
  sessionApi({ methods: readOnly, pattern: "/api/hiring-pack/**", permission: { resource: "employee_documents", action: "read" } }),
  sessionApi({ methods: ["PUT", "POST", "DELETE"], pattern: "/api/hiring-pack/**", permission: { resource: "employee_documents", action: "update" }, csrfRequired: true }),
  // ── Business cards ─────────────────────────────────────────────────────────────────────────
  // POST only because the chosen people and their on-screen corrections travel in a body; it writes
  // nothing and returns a file, so the resource is read. The handler also requires an HR seat.
  // Gated by canPrintBusinessCards (src/lib/business-cards/access.ts), hence domain-helper: HR Advisory
  // and HR Operations print on employee_documents:read as declared, the Talent Acquisition seat on
  // business_card_requests:update (2026-10-08).
  // The signed-in employee's OWN card, rendered as the print-ready PDF (front and back). Scoped to
  // the caller — there is no hrId in the request — so employee_profile:read is the whole gate. Listed
  // before the HR export below so the exact /mine path never falls to the employee_documents gate.
  sessionApi({ methods: ["POST"], pattern: "/api/business-cards/mine", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Every file hands over names, work emails and mobiles in bulk, so it is an audited export.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/business-cards", permission: { resource: "employee_documents", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // ── Job Offers ─────────────────────────────────────────────────────────────────────────────
  // Registered route by route rather than under one `/api/offers/**` blanket, for the reason the
  // hiring pack above gives and one more: this module's three verbs are not variations of each
  // other. Reading an offer shows a salary; editing the letter changes what every future offer
  // says; SENDING puts a binding figure in a stranger's inbox under Sato Pharmaceuticals' name and
  // cannot be recalled. A blanket would have flattened all three into whichever one was listed.
  sessionApi({ methods: readOnly, pattern: "/api/offers", permission: { resource: "offers", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/offers", permission: { resource: "offers", action: "create" }, csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/offers/:id", permission: { resource: "offers", action: "read" } }),
  sessionApi({ methods: ["PATCH"], pattern: "/api/offers/:id", permission: { resource: "offers", action: "update" }, csrfRequired: true }),
  // The module's irreversible route, and (with Resend below) the only ones that audit. `create`
  // rather than `update` because sending is what makes the offer exist to somebody outside the company.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/offers/:id/send", permission: { resource: "offers", action: "create" }, csrfRequired: true }),
  // Resend (owner, 2026-09-28): the SAME letter to the same address again, for a sent offer the
  // candidate never received. It changes no offer row, but it puts the same binding figure in a
  // stranger's inbox, so it carries Send's gate and audits every copy that leaves.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/offers/:id/resend", permission: { resource: "offers", action: "create" }, csrfRequired: true }),
  // Expire (owner, 2026-10-07): tell a sent offer's candidate it has lapsed and withdraw it. Like
  // Resend it puts a message in a stranger's inbox, so it carries Send's gate and audits the notice;
  // unlike Resend it then changes the offer row (to withdrawn), which the required audit records.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/offers/:id/expire", permission: { resource: "offers", action: "create" }, csrfRequired: true }),
  // The PDF of a single offer — one candidate's salary, to the person who could already read it on
  // screen. Not an export in the registry's sense (no list, no bulk, nothing filtered), which is
  // also why the export-audit guard's `template|export|download` match deliberately misses it.
  sessionApi({ methods: readOnly, pattern: "/api/offers/:id/pdf", permission: { resource: "offers", action: "read" } }),
  // What Add Employee can already know from an ACCEPTED offer — the candidate's name, the job
  // title, the agreed package, the first working day and the open seat the letter was written
  // against. `read`, and read is the whole of it: it writes nothing, creates nobody, and hands back
  // only what the Offers screen the caller is standing on already shows them. The employee record
  // is still written by /api/employees under its own `employees:update` gate.
  sessionApi({ methods: readOnly, pattern: "/api/offers/:id/hire-draft", permission: { resource: "offers", action: "read" } }),
  // POST, but a pure function: it renders unsaved blocks to HTML and writes nothing. `read` is the
  // honest permission — a preview shows exactly what a GET of the saved letter would.
  sessionApi({ methods: ["POST"], pattern: "/api/offers/preview", permission: { resource: "offers", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/offers/templates", permission: { resource: "offers", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/offers/templates", permission: { resource: "offers", action: "create" }, csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/offers/templates/:id", permission: { resource: "offers", action: "read" } }),
  sessionApi({ methods: ["PATCH"], pattern: "/api/offers/templates/:id", permission: { resource: "offers", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: ["DELETE"], pattern: "/api/offers/templates/:id", permission: { resource: "offers", action: "delete" }, csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/offers/templates/restore-default", permission: { resource: "offers", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/offers/job-titles", permission: { resource: "offers", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/offers/job-titles", permission: { resource: "offers", action: "create" }, csrfRequired: true }),
  sessionApi({ methods: ["PATCH"], pattern: "/api/offers/job-titles/:id", permission: { resource: "offers", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: ["DELETE"], pattern: "/api/offers/job-titles/:id", permission: { resource: "offers", action: "delete" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/imports/**", permission: { resource: "employees", action: "import" } }),
  // Declared `user_admin:export` until 2026-09-03, but the GET handler asserts `user_admin:read` —
  // the registry claimed a STRICTER gate than the code has, which is the direction that reads as
  // false comfort. Recorded here as what is enforced, not as what was hoped: whether a bulk user
  // download ought to require `export` is a live question for the owner, and tightening the handler
  // would change who can call it, so that is deliberately NOT done here. The file also exports a
  // POST (asserting imports:import + user_admin:update) that this GET-only entry does not declare.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/admin/users/bulk", permission: { resource: "user_admin", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/marketing/roi-refresh", permission: { resource: "overview", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing/roi-refresh", permission: { resource: "overview", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/roi-tracking/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only ROI report export: serialises the role-scoped, filtered report into a styled XLSX; performs no state mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/marketing-requests/:id/view-sales/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/marketing-requests/report/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/marketing-requests/report/share-links", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Minting a link that copies candidate names and phone numbers into a Google Sheet is gated on
  // recruitment:EXPORT, not recruitment:read — reading the pool inside Phoenix and issuing a
  // credential that survives the session are different acts, and only the second one leaves the
  // building.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/recruitment/cv-lifecycle/share-links", permission: { resource: "recruitment", action: "export" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/marketing-requests/control", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/marketing-requests/venue-merge", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/finance-evidence", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST", "DELETE"], pattern: "/api/marketing-requests/direct-order-offset", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/drafts", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/bulk-upload", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/reverse-geocode", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only: resolves caller-supplied coordinates via the Google reverse-geocode proxy and persists nothing." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/roi-tracking", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only filtered ROI report; uses POST only to carry a complex filter body, persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/validation", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/marketing-requests/roi-tracking/presets", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Direct Orders module — the service enforces the precise permission + per-step approver binding (domain-helper guard).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/submit", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/decision", permission: { resource: "direct_orders", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/reverse", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // Correct & resubmit a RETURNED order. `create` rather than `approve` because this is the
  // requester answering a return, not an approval action — and the service additionally requires
  // that the caller OWNS the order and that it is actually in `returned`. Same request id, same
  // approval chain: see reviseDirectOrder.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/revise", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // Attach the distributor invoice to an order already sent (owner, 2026-09-14). `create` admits every
  // requester role; the real gate is attachDirectOrderInvoice — the order's OWN requester, and only
  // while it is held or still waiting on the SFE Manager.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/invoice", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // Re-address a stuck approval rung. `update` is the widest permission this entry can name, and it
  // is NOT the real gate: repairDirectOrderApprovalRung is Super Admin only, asserts the workflow
  // registry transition, and refuses any rung whose approver still resolves in the directory. That
  // last refusal is what keeps this a repair rather than a way to choose your own approver — a
  // permission string cannot express it, so the service owns it and this entry says so.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/repair-rung", permission: { resource: "direct_orders", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  // Close a returned order whose requester has LEFT — the return is a question only they could
  // answer, and nothing expires `returned`, so it ages out of sight for ever. `read` is deliberately
  // the permission named here and is NOT the gate: closeOrphanedDirectOrder is Super Admin / system
  // scope (assertHeldDeskAccess), demands a written reason, takes `returned` only, and REFUSES while
  // the requester can still log in — that last refusal is what keeps this a clear-up rather than a
  // delete button, and no permission string can express it.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/close-orphaned", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Early Birds. The sync route mirrors the whole company-day from the vendor, so it is gated on a
  // role allowlist plus a GLOBAL rate-limit bucket rather than on a per-roster permission — the
  // roster guarantee is a read guarantee, not a write one.
  sessionApi({ methods: ["POST"], pattern: "/api/crm/early-birds/sync", permission: { resource: "crm_visits", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  // Doctor Coverage visit norms (visits per month, per contact kind and grade). `crm_visits:update`
  // is held ONLY by Super Admin and SFE Manager — it exists for this policy singleton alone; the
  // CRM visit mirror stays read-only for everyone. The CEO account is deliberately excluded, being
  // observational on policy. The PATCH is audited because it silently redefines what every role's
  // coverage % means, and "why did coverage jump" has to be answerable later.
  sessionApi({ methods: ["GET"], pattern: "/api/crm/doctor-coverage/config", permission: { resource: "crm_visits", action: "update" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/crm/doctor-coverage/config", permission: { resource: "crm_visits", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // Rep Doctor Lists. Pulls one month of the vendor's WEEKLY PLAN into ireports360_plan_entries --
  // the rep's assigned doctor list, the counterpart to the visits mirror. Audited as a mutation
  // because it reaches an external system and rewrites a mirror table on every call; gated on
  // `crm_visits:update` (Super Admin + SFE Manager) and then narrowed again to Super Admin alone by
  // assertRepDoctorListsAccess, per the owner's "admin account only for now" (2026-08-21).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/crm/rep-doctor-lists/sync", permission: { resource: "crm_visits", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // Teams counted from Phoenix CRM (owner, 2026-10-02: "Only when I start it"). Start or stop counting
  // a team's Phoenix visits and plans instead of its reps' iReports360 rows on every other screen — the
  // field-work compliance matrix and the deductions connectors among them. Gated on `crm_visits:update`
  // and narrowed again to Super Admin alone by assertPhoenixTeamStartsAdmin, both before the write; the
  // writer (phoenix_crm_set_team_start, service role only) records the audit row in its own transaction.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/crm/phoenix-team-starts", permission: { resource: "crm_visits", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // Plan Verification. The ONLY route in Phoenix that writes into the customer's CRM: a manager
  // signs off one rep's weekly or monthly plan and the vendor's own status moves. Audited as a
  // mutation because it leaves our system and cannot be undone from here — there is no unverify.
  //
  // `crm_plans:approve` and NOT `crm_visits:update`: the latter is the Doctor Coverage visit-norms
  // gate held only by Super Admin and SFE Manager, and reusing it would either lock out the district
  // managers this feature is for, or hand them company-wide visit norms. The permission is then
  // narrowed AGAIN inside the route by the viewer's org scope against the plan's own rep — a
  // district manager holding `approve` is still only entitled to HIS reps' plans, and that is the
  // gate a role check cannot perform.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/crm/plan-verification/verify", permission: { resource: "crm_plans", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  // Working on an approved vacation day (CRM phase 6, rule 9). `guard: "domain-helper"` — the gate is
  // assertVacationDayAccess(): a rep who may enter visits asks, a manager holding crm_visit_entry
  // approve answers for a rep beneath him, and only the administrator gives the HR approval. Each
  // action re-checks its own permission inside the service. Dormant until the CRM cutover date.
  //
  // The pilot's own visit entry, on-behalf entry, roster and plans routes that used to sit here are
  // retired (2026-09-25, once nothing called any of them any more) — the vacation-day-work feature
  // is the only one left in this family, and crm_visit_entry now gates nothing else.
  sessionApi({ methods: ["GET"], pattern: "/api/crm/native-visits/vacation-day-requests", permission: null, guard: "domain-helper", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/crm/native-visits/vacation-day-requests", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Doctor lists maintained in Phoenix (CRM phase 7). `guard: "domain-helper"` — the gate is
  // assertContactListAccess(): a rep asks for his own list (create), the stored manager answers for a
  // rep beneath him (approve), and the SFE Manager or administrator edits directly (update). Each action
  // re-checks its own permission inside the service. Changes open on the CRM cutover date.
  sessionApi({ methods: ["GET"], pattern: "/api/crm/contact-lists", permission: null, guard: "domain-helper", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/crm/contact-lists", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Phoenix CRM — the field force's own module, built clean (the owner, 2026-09-16). Its own resource,
  // `phoenix_crm`, and its own tables; none of these routes touches the pilot above or iReports360.
  // Every permission is narrowed AGAIN inside src/lib/phoenix-crm/server by the organogram: a
  // territory's list, plan and photos are written by that territory's rep only; a visit by its rep or
  // a manager above it; a grade, drop or plan decision by its reviewing manager only (the SFE Manager
  // may only return a plan); scope runs downward only; the Super Admin's writes are test entries.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/overview", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // There is no /api/phoenix-crm/integrity entry, and that is deliberate (2026-09-26). The route
  // existed and had NO caller — the board is a server component that loads the evidence directly —
  // so it was an address a curious rep could probe for nothing in return. Deleting it is strictly
  // more blind than widening it: a URL that 404s because it was never built is indistinguishable
  // from one that 404s because he is not the audience. Do not re-add it without a real client.
  // The rep's own day, as he works it. A read only — entering a visit is the visits route's job, and
  // this screen only hands it the customer.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/today", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // A working day that was not a call (owner, 2026-09-26). A record only — nothing downstream reads
  // it — and the rep's own to write, exactly like his list and his plan.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/day-activities", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/day-activities", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // "Show your manager you started working" (owner, 2026-10-03): the rep's own press, before his first
  // AM visit. The service narrows the POST to the territory's own rep (`territoryForRepWrite`), the
  // same boundary the day activity keeps — a manager enters a rep's visit, never his start of day.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/day-start", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/day-start", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // The daily forecast (owner, 2026-10-01), CNS only: the rep's own form and send, and the managers'
  // board. The service narrows each again — the form to the territory's own rep, the board to a reader
  // of team reports — so `read` here is gate one of two, as everywhere in the module.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/forecast", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/forecast", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/forecast/board", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/visits", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/visits", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/visits/form", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: false }),
  // The rep's own open commitments, and his prep for the next day a plan can hold (2026-10-03). Both
  // are plain reads with NO POST at all: a commitment closes by going back to the customer, and a
  // sent week changes only through "Ask to edit this week" — so neither path may ever write. Both are
  // narrowed in the service to the territory's OWN rep (`territoryForRepWrite`), because they are the
  // sentences he wrote and his own plan; `read` here is gate one of two, as everywhere in the module.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/commitments", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/call-prep", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // Deciding an off-plan visit: the same split as a grade or drop request, `approve` rather than
  // `update`, and narrowed AGAIN in the service to the one person whose step it is — the territory's
  // reviewing manager, then the SFE Manager. A district manager holding `approve` is not entitled to
  // another district's off-plan visits, and that is a gate a permission cannot perform. The queue
  // itself has no route: it rides in /api/phoenix-crm/team.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/visits/unplanned", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  // A record a rep MISSED — a visit, or how his day was spent — entered for him by the Super Admin
  // (owner, 2026-10-01). `update`, the same gate as Settings, and narrowed AGAIN in the service to the
  // Super Admin alone (`territoryForMissedRecord`), so holding `update` is not enough.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/missed-records", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/missed-records", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // A rep's visit CORRECTED by the Super Admin — who was on it, its products, its comment (owner,
  // 2026-10-06). The same footing as the entry above: `update`, narrowed to the Super Admin alone in
  // the service (`territoryForVisitEdit`).
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/visit-detail", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/visit-detail", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/visit-edit", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/visit-edit", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/list", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // The same territory's list as the Reps List board holds it — grouped by brick, with the month's
  // activity beside each row. It gets its own entry rather than inheriting a blanket because it reads
  // a SECOND source (the iReports360 mirror) beside the CRM's own, behind the CRM's own seat gate.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/list/board", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // One customer's past Phoenix visits, newest first, on his page (owner, 2026-10-02): read through the
  // list's own seat gate (`territoryForRead`) and carrying no location, distance or flag of any kind.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/list/timeline", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/validate", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/rename", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/primary-pharmacy", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // A pharmacy added to his own list by its name (owner, 2026-10-03): no photo and no approval. Since
  // 2026-10-09 it may carry two OPTIONAL extras in the same save — the pharmacy's pinned location and
  // its responsible person's phone.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/pharmacy", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // Those same two on a pharmacy already on his list — set, corrected or cleared (owner, 2026-10-09).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/pharmacy-details", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/places", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/places/update", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // Approving or rejecting a place the Google Maps check could not confirm (owner, 2026-10-03): the
  // Super Admin ALONE — `update` at the route, `canDecideValidationReviews` in the service.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/validation-reviews", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // A comment on a place check, and a manager's recommendation about it (owner, 2026-10-13). NEITHER
  // decides anything — the decision is still the Super Admin's alone, above.
  //
  // 🔴 `approve`, NOT `update`, AND THAT IS THE POINT OF THESE TWO ROUTES. A District Manager holds
  // phoenix_crm ["read", "create", "approve"] and no `update` at all, so `update` would 403 the one
  // person they exist for. Gate two is the service (`savePlaceNote` / `savePlaceRecommendation`): the
  // Super Admin, or a district manager on his OWN team's seats, re-read from the place's own row — so
  // the RSM, the NSM and the SFE Manager, who all hold `approve`, are refused there.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/place-notes", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/place-notes/recommendation", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  // Refusing a validation the check never held — every PM customer, and the AM ones that matched
  // (2026-10-03). The same gate and the same decider; the reject underneath is the one above.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/validation-reviews/refuse", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // Settling a location-integrity case, and putting a settled one back (owner, 2026-10-09): the Super
  // Admin ALONE — `update` at the route, `canSettleIntegrityCases` in the service, so the SFE Manager
  // reads that board without being able to close a case on it. Neither route deletes anything.
  //
  // 🔴 UNDER `/api/admin/`, NOT `/api/phoenix-crm/`, and that is the same decision as the note above
  // about the deleted integrity GET: the rep's own app calls `/api/phoenix-crm/*`, so an address
  // there that reaches the evidence is a disclosure surface whatever it answers. The admin namespace
  // is where the board's own decisions belong — the board page itself is `(admin)`.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/phoenix-crm/integrity/settle", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/phoenix-crm/integrity/reopen", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // Settling SEVERAL cases with one reason (owner, 2026-10-13: "make me able to multi select and
  // settle"). The same gate as the single settle, the same `canSettleIntegrityCases` 404 underneath,
  // and one note stamped on every selected case — with each case's OWN flags, never the batch's.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/phoenix-crm/integrity/settle-many", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // The board as an XLSX, narrowed by the filters the screen wrote into the address. `read`, not
  // `update` — the SFE Manager reads this board and may download the part of it he reads, which is
  // what `loadIntegrityBoard` hands back for him and nothing more. A GET, so no CSRF.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/phoenix-crm/integrity/export", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // A polyclinic, medical centre, medical tower or hospital outpatient suite — captured ONCE at its
  // door, with customers seated inside it (owner, 2026-10-09). GET is the picker, for a reader of the
  // territory; POST captures one, and the service gates it to the territory's own rep or a manager.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/shared-places", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/shared-places", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // Deciding one of those venues: the Super Admin ALONE — `canDecideSharedPlaces` in the service. A
  // rejection retires the venue and sends every customer seated in it back to To validate. POST only:
  // the Polyclinics section is read on the page itself, so there is no GET to gate.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/validation-reviews/shared-place", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/validation-reviews/shared-place/restore", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // Approving a place AFTER it was rejected (owner, 2026-10-03). The same gate and the same decider.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/validation-reviews/restore", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // Moving or removing a validated place: the Super Admin and the SFE Manager only (owner, 2026-09-29),
  // `approve` at the route and the movers' own check in the service.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/places/move", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/places/seat", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // The rep drops a customer he met outside his list (no approval: he was never on it).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/outside/drop", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // The SFE Manager brings a customer back from the Archive himself.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/archive/bring-back", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  // The SFE Manager curates a rep's list from outside it (owner, 2026-10-06): he drops an irrelevant
  // customer himself, or hands him to another rep with a written reason. `canCurateList` inside the
  // service is the gate on WHO — this permission only opens the door to the module.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/curate/drop", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/curate/move", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/requests", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/requests/withdraw", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/requests/return", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/requests/answer", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/requests/decide", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/plans", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/plans", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // A plan's own moves are split by who makes them: the rep sends or takes back (`create`), a manager
  // approves or returns (`approve`). Each route refuses the other's actions before the service runs.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/plans/submit", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/plans/decide", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  // A sent week is changed through a request (owner, 2026-10-01): the rep asks (`create`), and the
  // district manager, SFE and HR take their steps (`approve`) — the step is read from the row.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/plans/edit-requests", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/plans/edit-requests/decide", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  // The Administrator takes back a decision already taken (owner, 2026-10-08); WHO is checked in the service.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/administrator/reverse", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/plans/reviews", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // Last month's iReports360 plan as a read-only reference for "Copy last month".
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/plans/history", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // The territory's own Phoenix plans between two days, as what "Copy last month / week / a day" replays.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/plans/copy-source", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // The monthly plan sits above the weekly plan; the rep builds and sends it (`create`), a manager
  // approves or returns it (`approve`) — same split as the weekly plan's own routes above.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/monthly-plans", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/monthly-plans", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/monthly-plans/reviews", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/monthly-plans/reviews", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/team", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // The district manager's double-visit plan (owner, 2026-10-02): which of his reps he joins on which
  // day, AM or PM. The rep never sees it. Read (`read`) by that district manager, the SFE Manager and
  // the Super Admin only — narrowed in the service; written (`create`) by the district manager alone
  // on his own plan, and by the Super Admin only in test mode.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/double-visit-plans", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/double-visit-plans", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // A rep's ask for a visit with somebody (owner, 2026-10-02): his manager, a product manager of his
  // line, or a chain visit with his district manager and the manager above. The customer's page reads
  // the asks through the list's own seat gate (`read`); the rep raises and cancels his own (`create`,
  // narrowed to the territory's own rep); the inbox of the people an ask reaches — managers, product
  // managers, SFE and the Super Admin — is a `read` narrowed in the service.
  //
  // 🔴 ANSWERING IS `read`, AUDITED AS A MUTATION, AND THAT IS DELIBERATE. A product manager — and the
  // Marketing Manager, whom CNS reps may ask (the owner's CNS rule) — holds
  // phoenix_crm `read` alone — `create`, `update` and `approve` are what the module turns into entering
  // visits and deciding a territory's requests — so gate one is the permission every person asked
  // already holds, and gate two is IDENTITY, read from the ask's own row (`assertVisitAskAnswerer`):
  // only the person recorded as asked answers it. The same shape as the direct-order sales month below.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/visit-asks", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/visit-asks", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/visit-asks/cancel", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/visit-asks/answer", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/visit-asks/inbox", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/reports", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // The whole reports pack as one workbook (C1). Same "read" gate as the screen — it can never be a
  // way round a refusal, because the sections a viewer may not read are never loaded and write no
  // sheet. Audited as an export: a workbook naming individual employees leaves the building.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/phoenix-crm/reports/export", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // The Visit report generator (owner, 2026-10-15): the module's "read" gate, narrowed in the service to the
  // Super Admin and the SFE Manager (a 404 for anybody else). The data answer is a read sent as a POST — the
  // chosen fields do not belong in a URL — audited as a read; the workbook is an export, because a file
  // naming employees and where their phones were leaves the building.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/visit-report", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/phoenix-crm/visit-report/export", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // The one-page start guide a District Manager sends a rep, English or Arabic. NOT audited and not
  // scoped: it names no rep, no customer and no figure, so there is nothing in it to disclose and
  // nothing for an organogram scope to narrow. It is served as HTML because the browser is what
  // shapes Arabic correctly, and half the document is Arabic.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/start-guide", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // The Doctors directory: validated customers across territories. Scope is settled in
  // loadDoctorDirectory — a directory role reads the company, everyone else reads downward only.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/doctors", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/time-anchor", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/photos/upload-slot", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // The native app's live photo: it sends the stamped JPEG as a base64 data URL and the server does the
  // PUT the browser makes to the slot directly (React Native cannot PUT binary to a signed URL). Same
  // gate as upload-slot — it issues the slot itself — so it audits and requires CSRF the same way.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/photos/upload", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // A read sent as a POST (a batch of photo paths does not belong in a URL); it writes nothing.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/photos/sign", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  // The voice note's upload slot: whoever may enter this territory's visits may attach a recording to
  // one, so the gate is the same "create" as the photo's. It is deliberately its own route rather than
  // a purpose on photos/upload-slot — a recording is not evidence of presence, and the photo path is
  // the one that dates a visit by the slot it issued.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/voice/upload-slot", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // Playback, on the photo's own pattern: a read sent as a POST, writing nothing. It is audited because
  // hearing what a rep said on a call is a disclosure of the same kind as seeing where they stood.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/voice/sign", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  // Writing a voice note out as TEXT, for a browser with no speech engine of its own (Firefox). GET is
  // only whether the path is configured — a boolean the control asks for BEFORE it promises a rep that
  // his words will be written, disclosing nothing about anyone, so it is `read` and unaudited.
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/voice/transcribe", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: false }),
  // POST reads a stored recording and sends it to a third-party speech service, so it is audited on the
  // playback route's classification. Gated on `create`, not `read`: the module narrows it again to a note
  // this same person recorded in the last two hours, because unlike playback it costs money per second of
  // audio — "anyone who may hear it" would be a bill for a district's whole history of recordings.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/voice/transcribe", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // The visit recording the Super Admin requires of the reps he chooses (owner, 2026-10-16). The upload
  // slot is the voice note's shape and gate; the module narrows it to the territory's own rep.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/recording/upload-slot", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // Playback, audited as the voice note's is: hearing a visit's conversation is a disclosure. The module
  // narrows it to the Super Admin, the SFE managers and the managers above the territory.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/recording/play", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  // The Super Admin's own page: switch a rep on or off, download a recording, delete one. `update` at
  // the route, and the module narrows each to the Super Admin alone.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/recording/admin", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/recording/admin/download", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/recording/admin/delete", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  // The place stamp burned into a live photo (address, brick, area, coordinates). Same gate as taking
  // the photo; it resolves and returns, persisting nothing, so audit is classified but not required.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["POST"], pattern: "/api/phoenix-crm/location", permission: { resource: "phoenix_crm", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // The touch trail (owner, 2026-10-03: "anything touches him, automatically saved"). `read`, not
  // `create`: a rep who may OPEN Phoenix CRM is a rep whose taps belong in its trail, and gating it on
  // `create` would have left every manager who only reads the module untraced. Audit is classified as a
  // mutation — it does write rows — but NOT required, because this route IS the record: an audit entry
  // per flush would be a second copy of the same fact, every few seconds per rep.
  // The viewer has a Phoenix CRM module on screen: his own unread notices that open it are marked read, so the pulsing "new" badge clears (owner, 2026-10-08). Writes only the caller's own read state.
  sessionApi({ audit: { classification: "mutation", required: false }, methods: ["POST"], pattern: "/api/phoenix-crm/notices/seen", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: false }, methods: ["POST"], pattern: "/api/phoenix-crm/touch-trail", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: false }, methods: ["POST"], pattern: "/api/phoenix-crm/refused-readings", permission: { resource: "phoenix_crm", action: "read" }, guard: "assert-permission", csrfRequired: true }),
  // The module's settings: the Super Admin's only (`update`, narrowed again by assertSettingsWriter).
  // The SFE's customer-list template (owner's ask, 2026-10-02): the download for one territory, and the
  // filled sheet back. `approve`, the same gate as MOVING A PLACE — the module's other act reserved to
  // the SFE Manager and the Super Admin — and narrowed again in the service by the integrity board's own
  // predicate. NOT `update`: SFE holds `read` and `approve` only, so an update gate would silently have
  // made this the Super Admin's alone. The GET audits as an export because a workbook naming a
  // territory's customers and their grades leaves the building; the POST as a mutation.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/phoenix-crm/list/template", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/list/template/import", permission: { resource: "phoenix_crm", action: "approve" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/phoenix-crm/settings", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: false }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/phoenix-crm/settings", permission: { resource: "phoenix_crm", action: "update" }, guard: "assert-permission", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/approvals/early-bird/:id/decision", permission: { resource: "early_birds", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  // `create` matches the other requester-side mutations, but it is NOT the real gate: cancelling is
  // restricted to the requester of that specific held order (or a Super Admin) by
  // canCancelHeldDirectOrder inside the service. The coarse permission alone would let any
  // create-holder cancel anyone's order — the mistake `reverse` shipped with (audit F5).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/cancel", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // Sales month is Finance-owned: the registry permission is only `read` because the real gate
  // is an identity check inside setDirectOrderSalesMonth (Ahmed El Maraghy / Super Admin), not a
  // role action — the CEO holds direct_orders:approve but must NOT be able to move a month.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/sales-month", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Collections are Finance-owned on exactly the same terms as the sales month above, and for the
  // same reason the permission reads `read`: the gate is canRecordDirectOrderCollection, an
  // identity check, not a role action. Separate route from sales-month deliberately — recording a
  // payment must never be able to move which month the sales landed in.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/collection", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/service-fee", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // The record-level conversation (open at ANY status, owner 2026-09-22). Read and post are gated by
  // loadDirectOrderForConversation -> getDirectOrderRequest, which asserts direct_orders:read and then
  // applies the same scope check every approval surface uses; that domain helper IS the gate, so the
  // permission reads `read`. Marketing's twin needs no entry — /api/marketing-requests/** covers it.
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/:id/conversation", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/:id/conversation", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Sidebar badge for the unbooked queue (approved, no sales month). Same `read` permission as the
  // setter above, and the same identity gate behind it: getDirectOrderUnbookedBadge returns 0 to
  // anyone who cannot actually book a month, so the shared Direct Orders nav row stays unbadged for
  // the sales roles. Not audited — it returns a count and a boolean, no rows and no names.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: readOnly, pattern: "/api/direct-orders/unbooked-count", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  // The ONE Direct Orders sidebar badge: awaiting-approval + awaiting-Finance-month, summed. Same
  // permission and same guard style as the two counts it composes; both halves gate themselves.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: readOnly, pattern: "/api/direct-orders/needs-action-count", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/pharmacies", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Pharmacy registry — pre-register a pharmacy so a later order is recognised. Registry
  // permission is only `read` because the real gate is a role check inside the service
  // (Super Admin + SFE Manager); every sales role holds direct_orders:read and must NOT be
  // able to mint a pre-confirmed pharmacy. The `confirm` action routes to the Super-Admin-only
  // acknowledgeDirectOrderPharmacy, so SFE reaching it gets a 403 by design.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/pharmacies/registry", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Type-ahead over the distributor's customer catalogue for the new-pharmacy picker. Read-only,
  // so no CSRF; the territory bound lives in searchDistributorCustomers, which clamps every
  // result to the caller's own areas rather than trusting the query string.
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/customers", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  // The submit form's pharmacy combo box (spec B1/B2): read-only type-ahead over the UNION of the
  // distributor customer directory and Phoenix pharmacies; area scope enforced in the service.
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/pharmacy-search", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/campaign-options", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  // The venue form's "this venue on the CRM" picker — the campaign picker's counterpart, and the
  // only thing that lets a direct order reach a rep's CRM contact list (2026-09-03). Read-only, so
  // no CSRF. `create` rather than `read`, for the same reason invoice-extract below is: enumerating
  // contacts to declare one against a venue is only useful to someone who may register a venue.
  //
  // TWO DOORS, ONE ROUTE. `direct_orders:create` is the SUBMIT form's authority and the one declared
  // here. The ADMIN REGISTRY reaches the same picker on a different authority — Super Admin or SFE
  // Manager, per canManagePharmacyRegistry — because the SFE Manager holds `read, export, approve`
  // and NO `create`, yet is one of the two roles the owner allowed to manage the registry
  // (2026-08-04). Declaring the widest permission would be the security lie; declaring the narrow
  // one and saying so is the truth. assertMayDeclareVenueContact() in venue-contact-options.ts is
  // where the two are joined, and it is the only place either is granted.
  //
  // guard: "domain-helper" — listVenueContactOptions() is the boundary. It calls that gate itself
  // AND resolves the caller's own reach (their CRM list UNION their org subtree) from the live
  // AccessContext, never from the query string, so the route cannot return a contact the caller
  // could not already see. Neither door widens that scope: both registry roles resolve to `company`
  // on their own merits, being in the doctor list's own COMPANY_ROLES. assertVenueContactInScope()
  // re-runs the same resolution on the WRITE path, because a picker whose choice is not re-checked
  // server-side is decoration.
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/crm-contacts", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper" }),
  // Reads a photographed invoice to prefill the order form (spec B5). POST because the payload is
  // an image, but it writes NOTHING — hence no audit classification. `create` rather than `read`:
  // prefilling a submission is only useful to someone who may submit one.
  sessionApi({ methods: ["POST"], pattern: "/api/direct-orders/invoice-extract", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // Materialize/reuse a pharmacy from a combo selection (spec B1/B3). Body carries pointers only;
  // every stored field is copied server-side from the trusted catalogue row.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/pharmacies/from-directory", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // The Held Desk (spec C3). Registry permission is only `read` because the real gate is the
  // Super-Admin identity check inside the service (same idiom as the acknowledge route above).
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/held", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/rep-counters", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  // Pharmacy Validation (spec A2). GET is the Super Admin desk and POST is a rep submitting
  // evidence, so the registry permission is the module's `create`/`read` while the REAL gate is
  // the identity check inside the service — same idiom as the acknowledge route.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/pharmacy-validations", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // The evidence stamp for the pharmacy-validation storefront photo: turns the rep's GPS pin
  // into a street address plus the Phoenix brick/area/region burned onto the JPEG. `create` is
  // deliberately the SAME permission as the capture it serves — this route reveals the geography
  // of a point the caller already holds, and must not be reachable by anyone who cannot file the
  // evidence in the first place. Audit is classified but not required: it resolves and returns,
  // persisting nothing.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["POST"], pattern: "/api/direct-orders/reverse-geocode", permission: { resource: "direct_orders", action: "create" }, guard: "assert-permission", csrfRequired: true }),
  // "Did you mean…" candidates for a claimed pharmacy name (spec B4). Read-only, area-agnostic on
  // purpose: the point is to show the rep a pharmacy they may have mis-spelled, wherever it sits.
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/pharmacy-suggestions", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  // Code-collision "did you mean this pharmacy?" preflight, asked BEFORE a rep registers one by
  // hand (owner, 2026-08-13 — the atomic-create fix). POST because the body carries a list of
  // (distributor, customer code) pairs, but it writes NOTHING — hence no audit classification,
  // same idiom as invoice-extract above. CSRF stays required: this reports which pharmacy owns a
  // given distributor code, which a third-party page should not be able to enumerate.
  sessionApi({ methods: ["POST"], pattern: "/api/direct-orders/pharmacies/check", permission: { resource: "direct_orders", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // "My pharmacies" — the caller's own previously-approved pharmacies, offered so a rep picks
  // instead of re-registering (owner, 2026-08-13). Read-only, own-scope only.
  sessionApi({ methods: ["GET"], pattern: "/api/direct-orders/pharmacies/mine", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/pharmacy-validations/:id/decision", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/held/notify", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Duplicate cleanup (owner rule 5, 2026-08-09): merge pharmacy records that are one pharmacy, and
  // cancel orders submitted twice. Registry permission is only `read` because the REAL gate is the
  // Super Admin / SFE Manager identity check inside confirmDirectOrderCleanup — same idiom as the
  // acknowledge and Held Desk routes above. Every cancellation additionally passes the workflow
  // registry's own cancel_duplicate gate, so an approved order can never be closed this way.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/cleanup", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Acknowledging a hand-entered pharmacy. Registry permission is only `read` because the real
  // gate is a Super-Admin identity check inside acknowledgeDirectOrderPharmacy — an approver
  // holds direct_orders:approve but must NOT be able to self-clear an unverified pharmacy.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/pharmacies/:id/acknowledge", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // The counterpart to acknowledge: record that a pharmacy is FALSE. `read` matches its sibling and
  // is not the real gate — rejectDirectOrderPharmacy requires Super Admin or the system context,
  // and refuses without a written reason.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/direct-orders/pharmacies/:id/reject", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/direct-orders/report/export", permission: { resource: "direct_orders", action: "export" }, guard: "domain-helper", csrfExemptReason: "read-only report export; request body carries no mutation" }),
  // Minting and revoking the live links above. Gated on `export` — publishing the report outside
  // the login wall is the export permission's strongest form, not a lesser read.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/report/share-links", permission: { resource: "direct_orders", action: "export" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/caps", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/direct-orders/variances", permission: { resource: "direct_orders", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/coverage-report/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only Coverage Report export: serialises the role-scoped, filtered report into a styled XLSX; performs no state mutation." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/coverage-report", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfExemptReason: "Read-only filtered Coverage Report; uses POST only to carry a complex filter body, persists nothing." }),
  // Manager Scorecard — the ROI report grouped by the person who raised each request. Read-only
  // GET, no body: the viewer's own scope is the only filter, resolved server-side.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/marketing-requests/manager-scorecard", permission: { resource: "expenses", action: "read" }, guard: "domain-helper" }),
  // Excel and PDF of the same report, behind the same door as the page above it.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/marketing-requests/manager-scorecard/export", permission: { resource: "expenses", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/marketing-requests/coverage-report/presets", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/decision", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),

  // Make It Happen — the forecast planner. `sales:read` is the ROLE gate; canUseMakeItHappen then
  // admits only the eight owner-named roles, and the workspace is rebuilt in the caller's own scope
  // before anything is suggested or saved. A plan is saved for its owner only, never for someone else.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/make-it-happen/suggest", permission: { resource: "sales", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/make-it-happen/plans", permission: { resource: "sales", action: "read" }, guard: "domain-helper", csrfRequired: true }),

  // Market Awareness — conferences, round tables and speaker programmes raised by the product
  // managers. Gated on its OWN `market_awareness` resource rather than borrowing `expenses`, which
  // already gates the whole /api/marketing-requests/** namespace: widening that key would hand this
  // module to everyone who holds it. The permission decides whether the ROLE may touch the module;
  // the service then narrows by identity, because the matrix has no per-row layer and a Product
  // Manager may see only his own activities.
  sessionApi({ methods: ["GET"], pattern: "/api/market-awareness", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/market-awareness", permission: { resource: "market_awareness", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/market-awareness/options", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper" }),
  // The approvals queue. Gated on `read`, not `approve`: it is scoped inside the service to the
  // decisions that are actually the caller's, so a reader sees an empty queue rather than a refusal.
  sessionApi({ methods: ["GET"], pattern: "/api/market-awareness/inbox", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper" }),
  // The queue's nav badge. Registered ABOVE the /:activityId entries on purpose — it is a literal
  // segment, and a pattern list that reached `:activityId` first would gate a count behind the
  // wrong entry. Same `read` gate as the inbox it counts, and the service narrows it identically.
  sessionApi({ methods: ["GET"], pattern: "/api/market-awareness/pending-count", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper" }),
  // The conversation. Read is gated with the activity itself (getActivity carries the per-row
  // narrowing), and posting is `read` too: commenting is not a decision, and the people who must be
  // able to answer a returned activity are exactly the people who can see it.
  sessionApi({ methods: ["GET"], pattern: "/api/market-awareness/:activityId/comment", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/market-awareness/:activityId/comment", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/market-awareness/:activityId", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/market-awareness/:activityId", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/market-awareness/:activityId/tracking", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/market-awareness/:activityId/submit", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // The approval steps. `approve` is held by the CEO, the Group Product Manager, the Marketing
  // Manager, each line's National Sales Manager and Super Admin — and canDecideStep then narrows
  // further: an NSM answers only his own line's slot, and the retired manager step checks IDENTITY,
  // so a GPM cannot approve an activity routed to somebody else.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/market-awareness/:activityId/decision", permission: { resource: "market_awareness", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/market-awareness/:activityId/withdraw", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/market-awareness/:activityId/close", permission: { resource: "market_awareness", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Finance's paid / not-paid mark — `update`, which only Finance Manager and Super Admin hold.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/market-awareness/:activityId/finance", permission: { resource: "market_awareness", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/comment", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/marketing-requests/:id/resubmit", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Super-Admin-only direct-sales tracking toggle (Phase D). GET reads the flag; POST is
  // the mutation (Super-Admin gate enforced in the service). csrf is applied to the POST.
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/marketing-requests/:id/track-direct-sales", permission: { resource: "expenses", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/marketing-requests/**", permission: { resource: "expenses", action: "read" }, guard: "domain-helper" }),
  // Verified Captures gallery — the Super-Admin oversight of field-captured customers (direct orders
  // and validated marketing requests), read-only. The role gate lives in the domain helper
  // (assertVerifiedCapturesAccess — Super Admin, SFE Manager or system scope), so permission is null and the
  // guard is the domain helper, exactly as customer-pharmacy-mapping below.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["GET"], pattern: "/api/verified-captures/marketing", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["GET"], pattern: "/api/verified-captures/direct-orders", permission: null, guard: "domain-helper" }),
  // Customer Pharmacy Mapping — standalone read-only master-data governance. Role gate lives in the
  // domain helper (assertCustomerPharmacyMappingAccess); Phase 1 is Super Admin + CEO only.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["GET"], pattern: "/api/customer-pharmacy-mapping", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/customer-pharmacy-mapping/:id/decision", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Pharmacy Master / Distributor Matching — standalone read-only candidate-review report
  // (Phase 1, no write actions). Role gate lives in the domain helper
  // (assertPharmacyMasterAccess); Super Admin + CEO only.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["GET"], pattern: "/api/pharmacy-master/candidates", permission: null, guard: "domain-helper" }),
  // "My email" in the envelope — each person's OWN Turbify mailbox, connected once with their own
  // app password. `permission: null` for the same reason as the personal layout below: every route
  // derives the owner from the session (src/lib/personal-mailbox/service.ts) and accepts no id, so
  // there is nothing to grant — being signed in is the whole requirement, and the guard rejects on
  // access.source. No role, Super Admin included, can reach another person's mailbox through here.
  // Audit is deliberately not required: a Phoenix-side trail of who emailed whom would be the very
  // monitoring this feature promises not to do.
  sessionApi({ audit: { classification: "access-read", required: false }, methods: ["GET"], pattern: "/api/messages/mailbox/**", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: false }, methods: ["POST", "DELETE"], pattern: "/api/messages/mailbox/**", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/messages/**", permission: { resource: "communication", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // Personal sidebar arrangement. `permission: null` is the honest declaration rather than a gap:
  // there is no resource to gate on, because the route can only ever read or write the CALLER'S
  // OWN row. The hr_id comes from the resolved session and is never accepted from the request, so
  // there is no input by which one person could reach another's layout. Being signed in is the
  // whole requirement, which is why the guard rejects on access.source rather than a role.
  //
  // Nothing stored here grants access to anything: a layout only reorders links the viewer was
  // already permitted to see (applyPersonalLayout cannot emit an href absent from its gated input),
  // so the worst a bad write can do is give that one person an inconvenient menu.
  sessionApi({ methods: ["GET"], pattern: "/api/navigation/personal-layout", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: false }, methods: ["PUT", "DELETE"], pattern: "/api/navigation/personal-layout", permission: null, guard: "domain-helper", csrfRequired: true }),
  // The COMPANY DEFAULT navigation layout. Deliberately its own pattern rather than a scope flag on
  // the personal route above: the personal route derives its key from the session and cannot name a
  // different target, so the one write that reaches every account keeps its own URL and its own gate.
  // Guard is "domain-helper" because the handler checks `access.role === "Super Admin"` directly —
  // there is no navigation permission resource to assert against. Audit is classified but not
  // required, matching the personal route: a layout only reorders links the viewer could already
  // open, never widens access, and never overwrites a saved personal arrangement.
  sessionApi({ methods: ["GET"], pattern: "/api/navigation/company-layout", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: false }, methods: ["PUT", "DELETE"], pattern: "/api/navigation/company-layout", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/notifications/in-app", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/notifications/settings", permission: { resource: "employee_profile", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/notifications/settings", permission: { resource: "employee_profile", action: "update" } }),
  // These five declared `employee_profile:update` until 2026-09-03; every handler asserts
  // `employee_profile:read`. They are self-service routes that act only on the caller's own row, so
  // read + own-identity is a defensible gate — but the registry said `update`, so an auditor reading
  // it believed a profile-edit permission was required. Recorded as enforced.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/integrations/telegram/connect", permission: { resource: "employee_profile", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/integrations/telegram/disconnect", permission: { resource: "employee_profile", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/integrations/telegram/test", permission: { resource: "employee_profile", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/notifications/push/context", permission: { resource: "employee_profile", action: "read" } }),
  // No audit classification: this fires on every authenticated page load and every
  // browser subscription-change event, not a deliberate user action like Telegram
  // connect/disconnect — an audit-log row per ping would just be noise.
  sessionApi({ methods: ["POST"], pattern: "/api/notifications/push/register", permission: { resource: "employee_profile", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/notifications/push/test", permission: { resource: "employee_profile", action: "read" } }),
  // Dismisses the push opt-in nudge card, permanently, for the caller — same permission as
  // PATCH /api/notifications/settings, which this is: a notification preference write through
  // its own tiny endpoint. See dismissPushOptInNudge in src/lib/notifications/settings.ts.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/notifications/push/nudge", permission: { resource: "employee_profile", action: "update" } }),
  // Declared `admin:read` until 2026-09-03; the handler asserts `admin:update`. Draining the
  // outbox is a write, and reading it as a read-gated route understated who may trigger one.
  sessionApi({ methods: allMethods, pattern: "/api/notifications/process", permission: { resource: "admin", action: "update" } }),
  sessionApi({ methods: allMethods, pattern: "/api/notifications/test", permission: { resource: "admin", action: "update" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/outstation/workload-evidence", permission: { resource: "outstation", action: "read" }, guard: "domain-helper" }),
  // The native app's "which of my trips still owe a departure photo" list. It declares
  // `outstation:create` because that is the capture it leads to; a caller without it is answered
  // an empty list, never a 403, since the app signs out on any 403 (see the route's own comment).
  sessionApi({ methods: readOnly, pattern: "/api/outstation/departure-photo-due", permission: { resource: "outstation", action: "create" } }),
  sessionApi({ methods: allMethods, pattern: "/api/outstation/**", permission: { resource: "outstation", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/outstation/expenses", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/outstation/expenses", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/outstation/expenses/analyze", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/outstation/expenses/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PUT", "DELETE"], pattern: "/api/admin/outstation/expenses/reports/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/admin/outstation/expenses/export", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/start", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/message", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/actions", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/materialize", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/cancel", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId/deductions/vacation", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/deductions/vacation", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId/deductions/expenses", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/deductions/expenses", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/payroll/copilot/:runId/deductions/holiday-bridging", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/copilot/:runId/deductions/holiday-bridging", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/payroll/statutory/insurance-wages/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: allMethods, pattern: "/api/payroll/**", permission: { resource: "payroll", action: "read" }, csrfRequired: true }),
  // Automated Payroll — HR-owned monthly salary wizard. The role gate lives in the domain
  // service (assertAutomatedPayroll*Actor: Super Admin builds/publishes; CEO/Financial Advisor/
  // Finance Manager download the locked finance sheet), so guard: "domain-helper" — the same
  // pattern as the Payroll Copilot routes above. A separate namespace from /api/payroll/**.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/cancel", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/reconcile", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/population-diff", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/hold-review", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/data-quality", permission: null, guard: "domain-helper" }),
  // Employee-days this run would charge twice. Names people and salary figures, so the same
  // domain-helper gate as the wizard itself.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/day-collisions", permission: null, guard: "domain-helper" }),
  // Which confirmed figures the Deductions module no longer agrees with. Names people and
  // salary figures, so the same domain-helper gate as the wizard itself.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/module-drift", permission: null, guard: "domain-helper" }),
  // Who changed which figure on a run's sheet, and why. Same gate as the wizard itself.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/cell-history", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/publish", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/sheet", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "PUT"], pattern: "/api/automated-payroll/runs/:runId/steps/:stepKey", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/steps/:stepKey/confirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/steps/:stepKey/export", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/steps/:stepKey/import", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/part1/confirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/part1/unconfirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/part2/unconfirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/part2/confirm", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/exclude", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/include", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Held settlements — "this held salary was already transferred outside payroll" (owner rule
  // 2026-09-10). Held balances name people and salary figures, so the read is the same
  // domain-helper gate as the wizard itself, not the wider finance read role.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/runs/:runId/held-settlements", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST", "DELETE"], pattern: "/api/automated-payroll/runs/:runId/held-settlements", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Non-Employees Payroll — free-form list, no employee/HR_ID record; same domain-helper gate.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/automated-payroll/runs/:runId/non-employees", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PUT", "DELETE"], pattern: "/api/automated-payroll/runs/:runId/non-employees/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Standing (recurring) Non-Employees roster — the register each run's list is
  // seeded from, plus the on-demand sync into an already-open run. Same
  // Super-Admin domain-helper gate as the per-run list above.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/automated-payroll/runs/:runId/non-employees/sync", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/automated-payroll/non-employee-recurring", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PUT", "DELETE"], pattern: "/api/automated-payroll/non-employee-recurring/:id", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/finance", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/finance/download", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/finance/fab-download", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/automated-payroll/finance/cib-download", permission: null, guard: "domain-helper" }),
  // Employee Day-by-Day Report deduction decisions — replaced the standalone Fingerprint
  // Deductions page (retired 2026-07-24); this is now the one place a fingerprint deduction
  // gets confirmed/rejected. Super Admin gate enforced in-route (matches the page itself).
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/attendance/employee-day-report/decisions", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/attendance/employee-day-report/decisions", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/attendance/employee-day-report/all-summary", permission: null, guard: "domain-helper" }),
  // Probation Decision Intelligence routes are gated at probation:read at the middleware; each
  // route enforces its exact permission / row-level ownership / decision-role check in-handler
  // (findAccessRegistryEntry picks the longest matching pattern, so these override the blanket
  // below). Without these, the /api/probation/** blanket would require Super-Admin-only
  // probation:update and lock out managers / SFE / CEO / TM who legitimately hold probation:read.
  sessionApi({ methods: readOnly, pattern: "/api/probation/feedback-tasks", permission: { resource: "probation", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/probation/dashboard", permission: { resource: "probation", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/probation/analytics", permission: { resource: "probation", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/cases/**", permission: { resource: "probation", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/dv/**", permission: { resource: "probation", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/dv-feedback/**", permission: { resource: "probation", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/development-actions/**", permission: { resource: "probation", action: "read" }, csrfRequired: true }),
  // Config editor stays admin-only (probation:update).
  sessionApi({ methods: allMethods, pattern: "/api/probation/config", permission: { resource: "probation", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/probation/**", permission: { resource: "probation", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/requisitions/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/intake/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  // Advertising channels — the Facebook groups a vacancy gets posted into, and the tracking code
  // each one hands out. Same authority as the rest of the pipeline; the handlers ask for create/
  // update on their own mutating methods.
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/job-post-channels/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/applications/**", permission: { resource: "recruitment", action: "read" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/candidates/template", permission: { resource: "candidates", action: "read" } }),
  // Answering an applicant on WhatsApp in a recruiter's own words. Listed ABOVE the candidates
  // catch-all, and on a different permission from it, because the catch-all's candidates:read is
  // the authority to LOOK at someone's record — this is the authority to send a message to a member
  // of the public in the company's name, which is the same authority as putting their CV in front
  // of a manager (recruitment:update). Left to the catch-all, a widening of read access would
  // silently hand out the ability to message applicants.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/recruitment/candidates/*/whatsapp-reply", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  // The candidate's application PDF (CV plus the Job application form, and the WhatsApp Q&A when they had
  // one) — the screening page's "Download application" on any CV. A CV leaving the building is an audited
  // export, exactly like the WhatsApp conversation's own /application above, so it is listed here rather
  // than left to the candidates/** catch-all, which would not mark it an export. Same candidates:read gate.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/candidates/:id/application", permission: { resource: "candidates", action: "read" } }),
  // The screening page's one-press "Attach to requisition" (owner, 2026-10-16: "by one click from
  // admin or TA"). Listed ABOVE the catch-all on `candidates:update`, the grant hard-locked to Super
  // Admin and Talent Acquisition: it opens an application and tells the requisition's hiring
  // manager, which is far more than the catch-all's authority to look at a record.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/recruitment/candidates/*/attach-requisition", permission: { resource: "candidates", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/candidates/**", permission: { resource: "candidates", action: "read" }, csrfRequired: true }),
  // CV LOOKUP — the search-only CV access the owner asked for on 2026-09-30 (HR Operations may find
  // a CV she searches for; she may not have the pool). TWO CONCRETE ENTRIES AND NO WILDCARD, so the
  // inventory says exactly what this narrow surface is: a read that returns candidate identities,
  // and a read that hands over one person's CV.
  //
  // `cv_lookup:read`, NOT `candidates:read`, and the difference is the entire feature — the seat
  // behind it does not hold `candidates` and must not (see app/(admin)/cv-lookup/page.tsx). A row
  // here naming the wrong resource is how the CV Database ended up advertising a gate it did not
  // enforce, so these two say what the handlers assert and nothing else.
  //
  // The file route is an audited EXPORT: a CV leaving the building is the same event whichever
  // door it went through, and its handler additionally writes a REQUIRED audit row naming the
  // candidate. The search route is a plain read here — it writes its own best-effort audit row, on
  // the owner's instruction, but a search is not an export and must not be counted as one.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/cv-lookup/:id/application", permission: { resource: "cv_lookup", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/cv-lookup", permission: { resource: "cv_lookup", action: "read" } }),
  // The recruiter's OWN folder tree — folders and subfolders built by hand, and the CVs pushed into
  // them (owner request 2026-09-12). Gated on `candidates` rather than `recruitment` because of what
  // filing a CV DOES: a candidate sitting in any of these folders is hidden from the pool every
  // recruiter works from, which is the same authority as the four derived shelves already on
  // /api/recruitment/candidates/**. `candidates:update` is hard-boundary-locked to Super Admin and
  // Talent Acquisition, so a hiring-manager-type role cannot reach a shared folder even through an
  // override — deliberately, since this tree is one shared arrangement for the whole team rather
  // than a per-manager shelf.
  //
  // Four CONCRETE entries and no wildcard, so the inventory says exactly what each method requires:
  // reading the tree is `read`, and every write — create, rename, re-parent, delete, file, take out,
  // return to pool — is `update`. A single `/cv-folders/**` blanket would have been shorter and
  // would have reported the GET as an update, which is the false-comfort direction this registry
  // exists to prevent.
  sessionApi({ methods: ["GET"], pattern: "/api/recruitment/cv-folders", permission: { resource: "candidates", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/cv-folders", permission: { resource: "candidates", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: ["PATCH", "DELETE"], pattern: "/api/recruitment/cv-folders/:id", permission: { resource: "candidates", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: ["POST", "DELETE"], pattern: "/api/recruitment/cv-folders/:id/items", permission: { resource: "candidates", action: "update" }, csrfRequired: true }),
  // Listed after the `:id` entry it would otherwise be swallowed by — the matcher prefers the longer
  // pattern, so this concrete one wins over `:id` for this route whatever the order, but keeping it
  // adjacent is what stops the next reader from assuming `return-to-pool` is a folder id.
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/cv-folders/return-to-pool", permission: { resource: "candidates", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/interviews/**", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: allMethods, pattern: "/api/recruitment/files/**", permission: { resource: "candidates", action: "read" }, csrfRequired: true }),
  // One WhatsApp applicant's application as a PDF (the CV, then the sheet of every question and answer). It names a person, their phone and email and carries their CV, so it is the candidates grant AND recruitment:read for an HR authority role, exactly the page that offers the buttons.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/whatsapp-applicants/:sessionId/application", permission: { resource: "candidates", action: "read" } }),
  // Deliberately gated on the narrow `hiring_interviews` resource, not `recruitment`/
  // `candidates` (both hard-boundary-locked to HR authority roles) — so a hiring-manager-type
  // role like District Manager can view/act on only their own assigned candidate's CV,
  // interview, and outcome, without a broader recruitment grant. See
  // src/lib/recruitment/hiring-manager-view.ts for the full rationale and per-record scoping.
  // The manager's ANSWER — Interview / Not interested — is the only write on the candidates side of
  // the hiring-manager surface, so it is listed ahead of the read-only pattern below rather than
  // widening that one to allMethods: everything else a manager can reach here stays read-only.
  // `update` on the same narrow resource, and per-record scoping still applies — the route refuses
  // with 403 unless this candidate was deliberately sent to this caller.
  sessionApi({ methods: ["PATCH"], pattern: "/api/recruitment/hiring-manager/candidates/*/decision", permission: { resource: "hiring_interviews", action: "update" }, csrfRequired: true }),
  // A manager's COMMENT on a CV — the second write on this surface, and listed ahead of the
  // read-only pattern below for the same reason the decision is: everything else a manager can
  // reach here stays read-only. `hiring_interviews:update`, never `candidates:update`, which is
  // hard-boundary-locked to Super Admin and Talent Acquisition and so could never be granted to a
  // National Sales Manager even by an override. Writing a comment does NOT change the candidate's
  // status: the manager the CV was pushed to still owns that answer, and per-record scoping still
  // applies — the route refuses with 403 unless this candidate sits with the caller or with
  // somebody reporting to them.
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/hiring-manager/candidates/*/comments", permission: { resource: "hiring_interviews", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: ["DELETE"], pattern: "/api/recruitment/hiring-manager/candidates/*/comments/*", permission: { resource: "hiring_interviews", action: "update" }, csrfRequired: true }),
  // A manager filing a CV onto HIS OWN shelf. Same permission as the comment above, and the same
  // reason it cannot be `candidates:update`. What makes this safe to hand a line manager is WHERE it
  // writes: ats_candidate_manager_folders, one row per candidate per manager. The recruiter's
  // identical-looking route at /api/recruitment/candidates/*/folder updates the candidate row and
  // thereby removes the CV from the pool every recruiter works from — this one leaves Talent
  // Acquisition's screen untouched, and the manager's HR_ID comes off the session so no shape of
  // this call reaches another manager's shelf.
  sessionApi({ methods: ["PATCH", "DELETE"], pattern: "/api/recruitment/hiring-manager/candidates/*/folder", permission: { resource: "hiring_interviews", action: "update" }, csrfRequired: true }),
  // "I will call this candidate" / "Skip" — the owner's two buttons, 2026-09-09. Same permission and
  // the same reason as the three writes above, but a NARROWER per-record rule than any of them: the
  // route admits only a CV sent to this caller or sitting in one of his OWN area folders, never one
  // that belongs to a manager reporting to him. A National Sales Manager sees who reserved a CV and
  // may not take it — the 2026-08-30 rule that the answer stays with the manager it was sent to, in
  // a new shape. This is also the route that reveals a candidate's phone number, which is hidden on
  // every card until the caller holds the claim, so its scoping is the thing standing between a
  // manager and a number he has not committed to using.
  sessionApi({ methods: ["PATCH"], pattern: "/api/recruitment/hiring-manager/candidates/*/call", permission: { resource: "hiring_interviews", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/hiring-manager/candidates/**", permission: { resource: "hiring_interviews", action: "read" } }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/hiring-manager/applications/**", permission: { resource: "hiring_interviews", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/recruitment/hiring-manager/interviews/**", permission: { resource: "hiring_interviews", action: "update" }, csrfRequired: true }),
  // Reading DOWN the org chart: the managers reporting to the caller, and the CVs sitting with one
  // of them. Read-only on purpose — a manager above can look and comment, and the answer stays with
  // the manager the CV was actually sent to.
  //
  // The scoping is NOT in these entries and cannot be. `hiring_interviews:read` is the same
  // permission every district manager already holds, so the permission alone would let any of them
  // ask about any other; what separates them is the org walk inside listTeamManagerCandidates,
  // which proves the requested HR_ID is beneath the caller before a candidate row is read and
  // answers 403 — never an empty list — when it is not.
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/hiring-manager/team", permission: { resource: "hiring_interviews", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/hiring-manager/team/*/candidates", permission: { resource: "hiring_interviews", action: "read" } }),
  // The SILENT Manager CV Engagement report's OWN CV preview — deliberately NOT the hiring-manager
  // file routes above. Gated by canViewManagerCvEngagement (the report's audience: Super Admin, CEO
  // and the three NSMs), an in-route domain predicate rather than a permission resource, so the guard
  // is "domain-helper" with permission null exactly like /api/dev-auth/preview and
  // /api/admin/system-issues. Unlike the audited hiring-manager file routes, these record NOTHING: no
  // "opened" mark (which would pollute the very engagement signal the report measures) and no access
  // audit — so audit stays not-required. Read-only; no mutation, no CSRF surface. Listed as two
  // entries so the bytes route (/files/*) and the list route (/files) each resolve to their own.
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/manager-engagement/candidates/*/files", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/manager-engagement/candidates/*/files/*", permission: null, guard: "domain-helper" }),
  // The same report as an XLSX. Same audience, same gate, same silence — it reads the report and no
  // CV file, so it records no "opened" mark either. Audit IS required here where the preview routes
  // above waive it: this one leaves the building with every manager's name and numbers in a file that
  // can be forwarded, which is the thing worth having a trail of.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/manager-engagement/export", permission: null, guard: "domain-helper" }),
  // The interview calendar (owner, 2026-09-18). Gated in-route by requireCalendarAccess — the owner
  // (Super Admin), the people he shares it with as Viewer, Commenter or Editor, and whoever holds one
  // of his copy links — and NOT by a permission resource: a Viewer may hold no recruitment grant at
  // all, which is the point of sharing. So "domain-helper" with permission null, like the Manager CV
  // Engagement routes above. Every handler still starts from resolveAccessContext; a copy link
  // (`?link=` or the x-interview-calendar-link header) adds its grant on top — VIEW-only until the
  // holder signs in to Phoenix, and a link limited to one week answers for that week alone. `/me`
  // answers every caller (a null role means "no Schedule interview button"). The CV routes serve only
  // a person who is booked, and only their own files. Candidate search also asserts candidates:read
  // in the domain, and adding an outside person to Recruitment asserts candidates:create. The export
  // leaves the building with candidates' names in it, so it is audited; so are the shares and the
  // copy links. Polls, interview sessions and the Zoom report: the owner and Editors change them,
  // everyone the calendar reaches reads them, and nothing is ever messaged to a candidate.
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/me", permission: null, guard: "domain-helper" }),
  // The signed-in person's own .ics subscription: get-or-create their feed token (their own hr id only).
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/my-calendar-feed", permission: null, guard: "domain-helper" }),
  // The .ics feed itself is PUBLIC by design: a calendar app (Outlook, Google, the phone) cannot sign
  // in, so the 32-byte bearer token is the credential — the same model as the calendar's copy links.
  tokenApi({ authMode: "public-token", methods: ["GET"], pattern: "/api/recruitment/interview-calendar/ics/:token", reason: "Per-person interview subscription feed for a calendar app that cannot authenticate; the token resolves to ONE hr id and the feed carries only that person's own interviews (as interviewer or requester). An unknown or retired token returns a valid EMPTY calendar, never an error or anyone else's data. Containment is a 32-byte bearer token, read-only, and the token is redacted from the error log (CREDENTIAL_ROUTE_PREFIXES)." }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/bookings", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET", "PATCH", "DELETE"], pattern: "/api/recruitment/interview-calendar/bookings/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/interview-calendar/bookings/*/comments", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/interview-calendar/bookings/*/zoom", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["PATCH"], pattern: "/api/recruitment/interview-calendar/bookings/*/outcome", permission: null, guard: "domain-helper", csrfRequired: true }),
  // The panel's scorecards: an interviewer files their OWN rating + verdict (saveInterviewScorecard checks they are on the interview).
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/interview-calendar/bookings/*/scorecard", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Confirm/decline: the chosen interviewer answers the assignment (setInterviewerConfirmation checks they are the lead and it is still to happen).
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/interview-calendar/bookings/*/confirmation", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/bookings/*/invitations", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/zoom-due", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/candidates/*/files", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/candidates/*/files/*", permission: null, guard: "domain-helper" }),
  // Whether an interviewee has a WhatsApp application to print — a lookup that builds nothing, answering
  // null unless the caller could open the application from WhatsApp Applicants (HR authority with
  // recruitment:read and candidates:read; getInterviewCalendarCandidateApplication).
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/candidates/*/application", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/shares", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["DELETE"], pattern: "/api/recruitment/interview-calendar/shares/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/people", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/job-titles", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/recruitment/interview-calendar/export", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/bookings/*/cv", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/bookings/*/insights", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/bookings/*/invitation", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/bookings/*/polls", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/interview-calendar/sessions", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET", "PATCH", "DELETE"], pattern: "/api/recruitment/interview-calendar/sessions/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/interview-calendar/sessions/*/zoom", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/sessions/*/insights", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/sessions/*/invitation", permission: null, guard: "domain-helper" }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/sessions/*/polls", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["POST", "DELETE"], pattern: "/api/recruitment/interview-calendar/polls/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/poll-sets", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: ["PATCH", "DELETE"], pattern: "/api/recruitment/interview-calendar/poll-sets/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/links", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH", "DELETE"], pattern: "/api/recruitment/interview-calendar/links/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/candidates/search", permission: null, guard: "domain-helper" }),
  // The two-step interview request flow (owner, 2026-09-23): a District Manager and above, or HR,
  // asks for a day and attaches CVs; HR gives each CV a time. Self-gated exactly like the rest of the
  // calendar — the route resolves the caller's calendar role (mayRequestInterviews / book rights) in
  // interview-requests.ts, so no permission grant is declared here.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/recruitment/interview-calendar/requests", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "DELETE"], pattern: "/api/recruitment/interview-calendar/requests/*", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/recruitment/interview-calendar/requests/*/schedule", permission: null, guard: "domain-helper", csrfRequired: true }),
  // The CV on one request item, read-only — gated by the request itself (getInterviewRequestItemCv).
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/interview-calendar/requests/*/items/*/cv", permission: null, guard: "domain-helper" }),
  // A district manager hands a CV back to the administrator ("area not match — or any other
  // situation"), and the administrator later clears it from the Returned CVs queue. TWO DIFFERENT
  // GRANTS on purpose: returning is `hiring_interviews:update` — the same folder grant every district
  // manager already holds, so it is registered as its own entry AHEAD of the /api/recruitment/
  // candidates/** blanket (which would otherwise mis-declare it as candidates:read, a grant a DM does
  // not hold). Clearing the queue is `recruitment:update` — the recruiting-admin grant a DM does NOT
  // hold, so the person clearing a return is never the person who filed it. Both mutate and carry
  // assertSameOriginMutation. Per-record scoping (the CV is actually in the caller's district) lives
  // in the handler, exactly as the hiring-manager write routes above.
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/candidates/*/district-return", permission: { resource: "hiring_interviews", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/recruitment/district-returns/*/resolve", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  // WhatsApp message templates. THE GATE IS DELIBERATELY SPLIT BY VERB, and the split is the point:
  // SENDING a message is `recruitment:update` — the recruiting-admin grant, the same one that sends a
  // CV to a manager — while WRITING the wording is `admin:update`. The audience allowed to message a
  // candidate in the company's name is much wider than the audience allowed to rewrite what everybody
  // sends, and one entry covering both verbs would have quietly handed the second to the first.
  //
  // Registered ahead of nothing in particular — there is no /api/recruitment/** blanket — but the
  // per-verb entries must stay separate for the reason above. `/send` is longer than the `/*` entry
  // and carries a different method, so it resolves to its own row either way.
  //
  // The audit is declared on the three writes because these rows are what the company said to a
  // member of the public, and on the send because it records the message text that was prepared.
  // TWO permissions, because this route has two targets. The template list and a CANDIDATE context
  // are recruitment:update; naming an employeeHrId additionally asserts employees:read, because that
  // branch returns a staff member's name, job title and MOBILE NUMBER. Declaring only the first
  // would describe a gate narrower than the code enforces.
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/whatsapp-templates", permission: [{ resource: "recruitment", action: "update" }, { resource: "employees", action: "read" }] }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/recruitment/whatsapp-templates", permission: { resource: "admin", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH", "DELETE"], pattern: "/api/recruitment/whatsapp-templates/*", permission: { resource: "admin", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/recruitment/whatsapp-templates/send", permission: [{ resource: "recruitment", action: "update" }, { resource: "employees", action: "read" }], csrfRequired: true }),
  // Job Posts (owner, 2026-10-15) — the job titles behind the advert pictures, and the picture itself.
  // Every route asserts its recruitment clause and then canBuildJobPosts (Super Admin + Talent
  // Acquisition). The render is an EXPORT: it produces the file that is posted publicly.
  sessionApi({ methods: readOnly, pattern: "/api/recruitment/job-posts/titles", permission: { resource: "recruitment", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/recruitment/job-posts/titles", permission: { resource: "recruitment", action: "create" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/recruitment/job-posts/titles/*", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/recruitment/job-posts/render", permission: { resource: "recruitment", action: "export" }, csrfRequired: true }),
  // The WhatsApp Inbox — both company numbers, SUPER ADMIN ONLY (owner, 2026-09-15). Every route
  // passes `recruitment:update` and then refuses any role but Super Admin (`inboxForbidden`), so the
  // permission below is the floor, not the gate. Sends, links and saves write a required audit row;
  // marking a chat read does not, since opening a chat is not a decision.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/whatsapp-inbox/conversations", permission: { resource: "recruitment", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/whatsapp-inbox/conversations", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/whatsapp-inbox/conversations/*", permission: { resource: "recruitment", action: "update" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/whatsapp-inbox/conversations/*/read", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/whatsapp-inbox/conversations/*/messages", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/whatsapp-inbox/conversations/*/link", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/whatsapp-inbox/media/*", permission: { resource: "recruitment", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/whatsapp-inbox/messages/*/save-to-candidate", permission: { resource: "recruitment", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/whatsapp-inbox/templates", permission: { resource: "recruitment", action: "update" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/whatsapp-inbox/people", permission: { resource: "recruitment", action: "update" } }),
  sessionApi({ methods: readOnly, pattern: "/api/reports/vacancies", permission: { resource: "vacancies", action: "read" } }),
  // Listed AHEAD of the blanket /api/reports/** below, which would otherwise swallow it. The
  // permission is identical — this entry exists to DECLARE the audit. It is the one organogram
  // route that hands back personal contact data in bulk (the mobile numbers for the caller's
  // whole chart, for the XLSX export), so who pulled that list, and when, is worth recording.
  // The row itself is written by writeRequiredAuditLog inside the handler: this file is a
  // declarative inventory that only tests and scripts read, and declaring an audit here has
  // never caused one to be written.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/reports/organogram/contact-numbers", permission: { resource: "organogram", action: "read" } }),
  sessionApi({ methods: readOnly, pattern: "/api/reports/**", permission: { resource: "organogram", action: "read" } }),
  // The full-history workbook: every leaver the viewer can see, with salary and settlement figures.
  // Its own entry so the inventory says export, not the blanket's read, and declares the audit row
  // the handler writes before it hands the file over.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/resignations/export", permission: { resource: "resignations", action: "export" } }),
  sessionApi({ methods: allMethods, pattern: "/api/resignations/**", permission: { resource: "resignations", action: "read" }, csrfRequired: true }),
  // Turbify mailbox revocation register (Phase 6). Split GET from POST because the audit answer
  // differs: the read writes nothing, while every mutation writes a REQUIRED audit row.
  //
  // It held the `clearance` resource until 2026-09-01, when the Clearance & Offboarding module was
  // removed at the owner's instruction and this register became that grant's only consumer. It
  // took `mailbox_offboarding` rather than inherit a permission named after a deleted module.
  //
  // The POST carries two actions and the handler asserts each separately — "open" as create,
  // "record" as update — so the baseline declared here is the weaker of the two. Every write is an
  // attestation that a named admin performed a step in a system Phoenix cannot observe, so the
  // audit row is required, not best-effort.
  sessionApi({ methods: readOnly, pattern: "/api/mailbox-offboarding", permission: { resource: "mailbox_offboarding", action: "read" } }),
  // The POST branches: recording a NEW offboarding task asserts `create`, while completing or
  // re-attesting an existing one asserts `update`. Declared as `update` alone until 2026-09-03, so
  // the entry named only half of what the route enforces.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/mailbox-offboarding", permission: [{ resource: "mailbox_offboarding", action: "create" }, { resource: "mailbox_offboarding", action: "update" }], csrfRequired: true }),
  // The other end of the same job: a JOINER's mailbox. The POST connects a new hire's Turbify mailbox
  // to their My email with the app password made while creating it, or rules they need none. It
  // carries a mailbox credential in its body (sealed by the personal-mailbox service, never stored,
  // logged or audited here), so it is update-gated, same-origin only, and rate-capped per hire.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/new-hire-mailboxes", permission: { resource: "mailbox_offboarding", action: "update" }, csrfRequired: true }),
  // 🔴 ADOPTING a mailbox that already exists — the one route here that RESETS the password of a
  // mailbox somebody is reading every day, which locks them out of webmail until a human hands them
  // the new one. `guard: "domain-helper"` and `permission: null` because the gate is deliberately
  // NOT the matrix: `canReadInitialPassword` is Super Admin alone, where `mailbox_offboarding:update`
  // above is held by HR Advisory and HR Operations too. Whoever resets the mailbox is the only
  // person who can then read the hand-over password, so a wider gate would produce a lock-out
  // nobody could repair. The audit row is required and names who initiated it; a live run is also
  // rate-capped, because a retry loop here locks out one employee after another.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/new-hire-mailboxes/adopt", permission: null, guard: "domain-helper", csrfRequired: true }),
  // The invite inbox: the one mailbox Phoenix READS rather than hands to a person. Same audience
  // as adoption and for the same reason — it resets that mailbox's password — and the address is
  // never taken from the request, only compared against TURBIFY_INVITE_RECIPIENT.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/new-hire-mailboxes/invite-inbox", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Reading the invite inbox's App Passwords page, to replace the four __UNCALIBRATED__ placeholders
  // that keep a leaver's app passwords uncleareable. It changes nothing — no reset, no mint, no
  // remove press — but it SIGNS IN as that mailbox with the company password, which is why the gate
  // is the same `canReadInitialPassword` audience as adoption rather than a read-level one. Audited
  // as a mutation for the same reason: a sign-in to a live mailbox is worth a record of who asked.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/new-hire-mailboxes/app-password-controls", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/new-hire-mailboxes/app-password-rehearsal", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Company device register. The GET returns, per employee, the serial or IMEI of the machine he
  // carries and what the company values it at — a shopping list if it were readable company-wide,
  // which is why `company_devices` is its own resource rather than a corner of `sales` or `team`.
  sessionApi({ methods: readOnly, pattern: "/api/devices", permission: { resource: "company_devices", action: "read" } }),
  // The POST branches five ways and the handler asserts each: registering a device is `create`;
  // issuing, returning, marking and writing off are all `update`. A write-off is `update` and NOT
  // `delete` deliberately — it ends a debt البند (10) of the custody receipt created, and leaves
  // every record of that debt in place. Every mutation writes a REQUIRED audit row, because each is
  // an attestation that a named person physically handed over, received back, or stopped pursuing a
  // company asset, and two of them can end in money leaving somebody's wages.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices", permission: [{ resource: "company_devices", action: "create" }, { resource: "company_devices", action: "update" }], csrfRequired: true }),
  // Bulk import. All three gate on `company_devices:import` — the ACTION, matching how every other
  // import here is gated (`employees:import`) — so the bulk door can be withdrawn on its own
  // without taking single-device registration with it.
  //
  // The TEMPLATE is gated the same as the write, not as a read: it is not a report, it carries a
  // dropdown of every employee's name, and it is useful only to somebody about to import.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/devices/import/template", permission: { resource: "company_devices", action: "import" } }),
  // The DRY RUN writes nothing, and is still a POST (it carries a file) and still CSRF-guarded: it
  // reads the whole employee directory to resolve holders, which is not a payload a cross-origin
  // page should be able to make a logged-in browser fetch. Audited as a read, not a mutation.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/devices/import/dry-run", permission: { resource: "company_devices", action: "import" }, csrfRequired: true }),
  // The COMMIT. Required audit, like every other device mutation — each imported row also writes
  // its own per-device audit row, because it goes through createDevice/issueDevice rather than
  // around them.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/import/confirm", permission: { resource: "company_devices", action: "import" }, csrfRequired: true }),
  // The Action1 pull — the same two presses as the spreadsheet import, with no file in the middle,
  // so it is gated identically on `company_devices:import`. Nothing about reading a fleet from an
  // external console makes it a lighter door than reading it from an .xlsx: both end in rows in the
  // asset register, and both are refused together when the bulk door is withdrawn.
  //
  // Both are POSTs carrying no body at all, and both are still CSRF-guarded — more firmly than the
  // file pair, not less. They make an outbound call on the company's own Action1 credentials, and a
  // GET that a cross-origin page could trigger would let somebody else's page spend them.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/devices/action1/dry-run", permission: { resource: "company_devices", action: "import" }, csrfRequired: true }),
  // The COMMIT. Required audit like every other device mutation, and each registered row still
  // writes its own per-device audit row — the pull goes through createDevice, not around it. It
  // never issues custody to anybody, so no assignment audit row can come from this path.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/action1/confirm", permission: { resource: "company_devices", action: "import" }, csrfRequired: true }),
  // Managed Google Play — three doors into Google's own console, every one gated on
  // `company_devices:approve`, the only action on this resource the matrix reserves to the Super
  // Admin. Device Custody above is paperwork and HR Operations runs it; these publish software onto
  // every rep's tablet.
  //
  // NO audit clause on any of the three, deliberately. They write nothing in Phoenix: the first
  // mints a short-lived Google web token and hands back a URL, and the other two carry the one-time
  // enterprise enrolment. What is worth auditing — which app was approved for the fleet — happens
  // inside Google's iframe, where this app never sees it, and Google's own admin log is that record.
  // `required: true` here would assert a row no handler writes.
  sessionApi({ methods: ["POST"], pattern: "/api/devices/managed-play", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/devices/managed-play/signup", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Google's RETURN leg, so a GET and deliberately not CSRF-guarded: it arrives as a top-level
  // navigation from Google's domain carrying `?enterpriseToken=…`, and a same-origin assertion would
  // refuse every real callback. The permission is still asserted, and the token is single-use, so a
  // replayed one buys nothing.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/managed-play/callback", permission: { resource: "company_devices", action: "approve" } }),
  // Rep Tablets — the device policy every rep tablet follows, the enrollment codes that bring a
  // tablet under it, and the enrolled-tablet list. All three on `company_devices:approve` like
  // Managed Google Play: one policy save reaches every enrolled tablet, and even the read lists each
  // tablet's serial, IMEI and holder straight from Google.
  //
  // The READ writes nothing, so it declares no audit row. The two WRITES each write a REQUIRED audit
  // row after Google answers — the enrollment one records who made a code, for which tablet and for
  // how long, and never the code itself, which stays a live credential until it expires.
  //
  // `/imei` is the third write: the page posts it by itself after a load finds a tablet whose IMEI
  // the register lacks. It reads no body — which IMEIs go where is decided on the server from
  // Google's list and the register — writes only into an entry holding no IMEI, and each IMEI
  // written carries its own REQUIRED audit row, written before the register changes.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/tablets", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/tablets/policy", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/tablets/enrollment", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/tablets/imei", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // A tablet plugged in by USB joins the custody register under the next PHX-TAB number; the
  // register's own createDevice writes the required audit row.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/tablets/usb", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // ManageEngine bridge. GET reads the fleet, and with ?deviceId= one tablet — its position, or with
  // &view= everything ManageEngine holds about it, the apps on it, or its command history. POST issues
  // one remote command — lock, restart, reset the screen lock, report in, ring, shut down, view or
  // control the screen, kiosk mode, lost mode, or a wipe — each of which reaches a real tablet and
  // carries its own REQUIRED audit row (manageengine_device_command).
  sessionApi({ methods: ["GET"], pattern: "/api/devices/manageengine", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/manageengine", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Putting an app on a rep's tablet or taking one off reaches that tablet just as a command does, so
  // it carries the same gate and its own REQUIRED audit row (manageengine_device_app). Refreshing the
  // app list is a read wearing a POST — the service writes no row for it.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/manageengine/apps", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // GET is the company app repository — every app ManageEngine holds, which is every app a tablet can
  // be sent. A read, so no audit row.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/manageengine/apps", permission: { resource: "company_devices", action: "approve" } }),
  // Adding an APK to that repository. It reaches NO tablet — an app in the repository is one that CAN
  // be sent, and sending it is the route above — but it is still a write into the company's fleet
  // configuration, so it carries the same gate and its own REQUIRED audit row
  // (manageengine_app_repository). Its body is multipart, which is why it is a route of its own.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/manageengine/apps/upload", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // The ManageEngine enrollment template — the QR a factory-fresh tablet scans. GET returns everything
  // ABOUT the template and never the template itself; POST either saves a new one (REQUIRED audit,
  // manageengine_enrollment_template) or, with `show`, hands the saved payload to the page for the one
  // moment it draws the QR. 🔴 That payload is a credential — anyone who scans it enrolls a tablet into
  // the company fleet — so both verbs sit behind company_devices:approve, Super Admin only.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/manageengine/enrollment", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/manageengine/enrollment", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Copying the IMEI a ManageEngine-managed tablet reports into its custody-register entry, where the
  // entry holds none (2026-09-25 — the ManageEngine twin of /api/devices/tablets/imei). It reads NO
  // body: which entries are written, and with which IMEI, is decided on the server from the live fleet
  // and the register, so the browser can ask for the copy but never say what it copies. Each IMEI
  // written carries its own REQUIRED audit row (company_device).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/manageengine/imei", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // The rules a rep tablet carries — ManageEngine's profiles, the vendor's half of what the Android
  // Management policy did. GET reads the company's Android profiles, or with ?deviceId= what one tablet
  // carries. POST puts a rule set on a tablet or takes it off, which changes what that tablet is
  // ALLOWED to do in a rep's hands — same gate as a remote command, and its own REQUIRED audit row
  // (manageengine_device_profile).
  sessionApi({ methods: ["GET"], pattern: "/api/devices/manageengine/profiles", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/manageengine/profiles", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // BUILDING the company's rep tablet profile — the rules themselves, not who follows them. GET says
  // whether ManageEngine already holds it and lists every field Phoenix would write, plus the three
  // rules a profile cannot carry. POST creates it, proves its payloads attached and publishes it, so
  // it is a REQUIRED audit row (manageengine_profile) on the same Super Admin gate; it reads no body
  // and puts the profile on no tablet.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/manageengine/rep-tablet-profile", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/manageengine/rep-tablet-profile", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Headwind bridge (2026-09-25) — the company's OWN MDM server, which has no device cap and no trial.
  // GET reads the fleet, and with ?deviceNumber= one tablet: its position, or with &view= everything
  // Headwind holds about it, the apps on it, what Phoenix has done to it, or where a remote screen
  // session would connect. 🔴 The screen view hands back a TARGET, never a credential — no session
  // password and no private key ever leaves the server. POST issues one remote action, each of which
  // reaches a real tablet and carries its own REQUIRED audit row (headwind_device_command). Same Super
  // Admin gate as the ManageEngine bridge beside it: the two consoles differ, the custody rules do not.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/headwind", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Copying the IMEI a Headwind-managed tablet reports into its custody-register entry, where the entry
  // holds none — the Headwind twin of the two routes above it. It reads NO body: which entries are
  // written, and with which IMEI, is decided on the server from the live fleet and the register, so the
  // browser can ask for the copy but never say what it copies. Each IMEI written carries its own
  // REQUIRED audit row (company_device).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/imei", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Recording the RustDesk ID of one tablet — the number a screen session is aimed at, kept in Headwind's
  // `custom1` so there is no second list to keep in step. 🔴 It is typed through Phoenix because the
  // Community console CANNOT draw that field: it appears only when `settings.customPropertyName1` is
  // named, which is `null` on this server and settable from no screen in it. Same Super Admin gate as the
  // remote actions, and a REQUIRED audit row naming the tablet, the old ID and the new one
  // (headwind_device_command). An empty value clears it, which is what a re-enrolled tablet needs.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/remote-id", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Taking one app off one Headwind-managed tablet (`uninstallApp`). 🔴 The removal is SILENT on the
  // tablet — the agent is the device owner, so nothing prompts the rep — which is why it sits on the
  // same Super Admin gate as the remote actions and carries its own REQUIRED audit row naming the
  // tablet and the package (headwind_device_command). Reading what is installed is the fleet route's
  // ?view=apps; this route only removes. The management app itself is refused in the service.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/apps", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Erasing the COMPANY'S data from one tablet, leaving the tablet enrolled and working — what a
  // handover needs, where a factory reset would also take the enrolment and mean setting the tablet up
  // by hand again. GET returns the scope in plain words for the second press to print; POST does it.
  // 🔴 The scope is NOT in the body: the apps and folders are the owner's own answer, fixed in
  // src/lib/devices/headwind/wipe.ts, because a wipe that can be aimed from a request can be
  // mis-aimed. Silent on the tablet, so the same Super Admin gate and a REQUIRED audit row
  // (headwind_device_command) naming the tablet and every instruction sent.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/headwind/wipe", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/wipe", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // The tablet CONFIGURATIONS themselves — the rules a tablet follows, not the tablets. GET lists them
  // or reads one; POST attaches an app or a file to one, moves a tablet onto one, or writes the kiosk
  // branding. 🔴 Every whole-object write is an OPAQUE ROUND-TRIP (read the server's own JSON, change
  // one field, put it back), because a PUT wipes and re-inserts the app, settings and file lists — and
  // because a configuration carries a PLAINTEXT password Phoenix must carry through without reading.
  // REQUIRED audit row (headwind_configuration); Super Admin only.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/headwind/configurations", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/configurations", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Sending an APK or a file up to the Headwind server and attaching it to a configuration, which is
  // how an app installs on a tablet — there is no "install" push in Headwind at all. Multipart, so it
  // gets its own route and its own 300-second budget, the shape the ManageEngine upload already sets.
  // REQUIRED audit row (headwind_configuration); Super Admin only.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/upload", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // The custody actions a tablet can be told to take that are NOT ordinary pushes — lock, lost mode on
  // and off, factory reset, reset the screen lock, ring the alarm, and show a message on the screen.
  // GET says which of them this box can actually do right now and why, so the console never draws a
  // button it cannot honour. 🔴 Four of them need the Phoenix add-on on the Headwind box; without it
  // GET says so and POST refuses in words — it never reports an action as sent when nothing was.
  // REQUIRED audit row (headwind_device_command); Super Admin only.
  sessionApi({ methods: ["GET"], pattern: "/api/devices/headwind/actions", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/actions", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // The tablet enrolment code — the Headwind twin of the ManageEngine enrolment card. Phoenix STORES
  // and redraws the QR payload the owner pastes in; it never mints one, because the code's checksum
  // depends on the APK the box itself serves. 🔴 GET never returns the code: it returns whether one is
  // held and the facts about it. Revealing it is an explicit POST { show: true }, and the audit row
  // carries the facts and NEVER the payload. REQUIRED audit row (headwind_enrollment).
  sessionApi({ methods: ["GET"], pattern: "/api/devices/headwind/enrollment", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/enrollment", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Console logins for the team — free and uncapped on this server, unlike the seat-priced trial it
  // replaces. GET lists the people who can sign in and the roles available; POST adds one or retires
  // one. 🔴 A password is written, never read back: GET returns no credential of any kind, and the
  // audit row names the login and the role and never the password. REQUIRED audit row (headwind_user).
  sessionApi({ methods: ["GET"], pattern: "/api/devices/headwind/users", permission: { resource: "company_devices", action: "approve" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/headwind/users", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Visual Aids (owner, 2026-09-18). A rep and his DM, RM and NSM read the ACTIVE aids of their own
  // line — the line check lives in src/lib/visual-aids/service.ts, below the permission. Marketing
  // Manager, GPM and Super Admin upload (create) and retire or replace (update); nobody deletes. The
  // upload-url POST mints a one-time signed Storage URL and writes no row, so it carries no audit of
  // its own: the create or replace that records the file writes the required audit row.
  sessionApi({ methods: ["GET"], pattern: "/api/visual-aids", permission: { resource: "visual_aids", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/visual-aids", permission: { resource: "visual_aids", action: "create" }, csrfRequired: true }),
  sessionApi({ methods: ["POST"], pattern: "/api/visual-aids/upload-url", permission: { resource: "visual_aids", action: "create" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/visual-aids/:id/retire", permission: { resource: "visual_aids", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/visual-aids/:id/replace", permission: { resource: "visual_aids", action: "update" }, csrfRequired: true }),
  sessionApi({ methods: ["GET"], pattern: "/api/visual-aids/:id/file", permission: { resource: "visual_aids", action: "read" } }),
  // Production Planner (owner, 2026-10-05). Ivyronc is toll-manufactured by EGPI and Sato supplies
  // most of its raw materials, so this module answers one question: for a production order of this
  // size, how much of each material is needed, already held, still to buy and to deliver, at what
  // cost, and when does the next order have to be placed.
  // 🔴 Enforcement is the resolveProductionPlanningLevel domain helper, NOT a bare assertPermission.
  // The owner named five PEOPLE, and two of them -- Dr. Sahar Khalil the R&D Manager, who is the
  // module's main user, and Reham Elwiy the Regulatory Affairs Supervisor -- hold `Manager` and
  // `Employee`, which the matrix deliberately grants NOTHING: `Manager` also covers the QPPV, and
  // `Employee` is the whole company, so granting either role would publish every raw-material price
  // and order cost. `permission` still records the resource a matrix user is checked against, the
  // way the pharmacy-search entries above do, so this registry keeps saying what gates the route.
  // src/lib/production-planning/access.ts holds the two named lists and the reasoning.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/production-planning", permission: { resource: "production_planning", action: "read" }, guard: "domain-helper" }),
  // Computes and stores nothing. A POST only because the per-material "what I will actually deliver"
  // map does not belong in a query string, which is why its classification is access-read.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/production-planning/plan", permission: { resource: "production_planning", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/production-planning/plans", permission: { resource: "production_planning", action: "read" }, guard: "domain-helper" }),
  // The Excel model. `export` rather than `read`, which is what separates taking the costed plan out
  // of the building from looking at it on a screen — and the Finance Manager holds export for exactly
  // that. Rate-limited like every other workbook export in this app.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/production-planning/workbook", permission: { resource: "production_planning", action: "export" }, guard: "domain-helper" }),
  // A commit freezes the geometry, the overage and the exchange rate beside the plan, so a cost
  // agreed in January still reproduces in June. REQUIRED audit row (production_plan).
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/production-planning/plans", permission: { resource: "production_planning", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/production-planning/stock", permission: { resource: "production_planning", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  // 🔴 A price change moves what an order costs, so its audit row is written with
  // writeRequiredAuditLog: an unrecorded price change is a failed price change.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/production-planning/prices", permission: { resource: "production_planning", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/production-planning/runs", permission: { resource: "production_planning", action: "read" }, guard: "domain-helper" }),
  // The recorded actuals are what turn the owner's guessed 3% overage into a measured figure.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/production-planning/runs", permission: { resource: "production_planning", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  // Carries the four arming flags. Switching the reorder email on or off writes a REQUIRED audit
  // row, because it is the moment this module starts speaking to people outside it.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/production-planning/settings", permission: { resource: "production_planning", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/production-planning/materials", permission: { resource: "production_planning", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/production-planning/fx", permission: { resource: "production_planning", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  // 🔴 Who else may reach the planner. FULL CONTROL ONLY, both ways -- it names people and says what
  // each may see. It is how the owner's promise about Reham ("later on authority on her") becomes a
  // row somebody types instead of a release somebody ships, and the named lists are checked FIRST so
  // a row here can admit a sixth person and can never demote one of the five he named.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/production-planning/access-grants", permission: { resource: "production_planning", action: "update" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/production-planning/access-grants", permission: { resource: "production_planning", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  // Correcting an existing entry's serial number and IMEI — the one path that REPLACES an identity
  // somebody recorded, so it is Super Admin only (`company_devices:approve`, owner decision
  // 2026-09-18), not the `update` HR Operations issues and returns with. A written reason is
  // required, and the REQUIRED audit row — old values, new values, reason — is written BEFORE the
  // entry changes. Rep Tablets' "the register has a different IMEI" warning links here.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/devices/identity", permission: { resource: "company_devices", action: "approve" }, csrfRequired: true }),
  // Retention register (Phase 6). The GET returns stay and exit conversations, which hold what an
  // employee said in confidence about their manager and their pay — the permission is the whole
  // protection, since RLS is disabled-by-default here like every other table in this app.
  sessionApi({ methods: readOnly, pattern: "/api/retention", permission: { resource: "retention", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/retention", permission: { resource: "retention", action: "create" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/retention", permission: { resource: "retention", action: "update" }, csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans", permission: { resource: "weekly_plans", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/export", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/calendar", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  // Detailed-plans XLSX export of the shared calendar. Enforcement is the canExportPlanningCalendar
  // domain helper (SFE Manager / Super Admin only) — stricter than the weekly_plans:read baseline
  // declared here — so guard is "domain-helper", not assert-permission. Export audit is required.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/calendar/export", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/conflicts", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/prefill", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH"], pattern: "/api/weekly-plans/:id", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/decision", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/reassign", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/move-period", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/weekly-plans/:id/comments", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/comments", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/request-visit-details", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/visit-details", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/acknowledge", permission: { resource: "weekly_plans", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/cancel", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/request-edit", permission: { resource: "weekly_plans", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/:id/edit-request-decision", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/weekly-plans/decisions/batch", permission: { resource: "weekly_plans", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/private-calendar/export", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/private-calendar", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/private-calendar/disputes", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/private-calendar/disputes/pending", permission: { resource: "attendance", action: "approve" }, guard: "domain-helper" }),
  // The sidebar badge for the Calendar Disputes inbox — the LENGTH of the list above, same gate, no
  // audit row: it is polled every 30 s from every open tab and reads nobody's data but the count.
  sessionApi({ methods: ["GET"], pattern: "/api/private-calendar/disputes/pending-count", permission: { resource: "attendance", action: "approve" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/private-calendar/disputes/:id/decide", permission: { resource: "attendance", action: "approve" }, guard: "domain-helper", csrfRequired: true }),
  // The reply thread on one review request. `attendance:read` is only the matrix gate; the real
  // audience test — the employee who raised it, or a Super Admin — is resolveDisputeThreadActor in
  // the domain helper, so a manager with attendance:read reaches the route and not the conversation.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/private-calendar/disputes/:id/messages", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // THE DISPUTE CENTER — one set of routes over the three dispute modules (owner, 2026-10-09).
  //
  // `attendance:read` is the matrix gate on every one of them, and it is deliberately the WIDEST
  // thing here: who may actually read or write a case is decided per case by
  // dispute-center/participants.ts, which applies each module's own long-standing rule (the employee
  // it belongs to, the Super Admin, the named weekly-review reviewers, the company-wide deduction
  // readers). A manager holding attendance:read reaches the route and not the dispute.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/dispute-center/cases", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/dispute-center/cases/:kind/:ref", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/dispute-center/cases/:kind/:ref/messages", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // The decision. It can cancel or reduce a deduction and recommend money back into a later payroll,
  // so it is audited as a mutation and the reviewer test is inside the domain helper.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/dispute-center/cases/:kind/:ref/decide", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/dispute-center/cases/:kind/:ref/reopen", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // The case briefing. SUPER ADMIN ONLY (assertAssistActor — the owner's own answer, "only me"),
  // which is a named-role test the matrix cannot express, so it lives in the domain helper.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/dispute-center/cases/:kind/:ref/assist", permission: { resource: "attendance", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  // One picture from a dispute. Not audited: it is an image behind a conversation the reader already
  // has open, fetched once per thumbnail, and the participant check runs before a byte is read.
  sessionApi({ methods: ["GET"], pattern: "/api/dispute-center/attachments/:id", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notification-confidence", permission: { resource: "communication", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/admin/notification-confidence/pending", permission: { resource: "communication", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/notification-confidence/:id/approve", permission: { resource: "communication", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/admin/notification-confidence/:id/discard", permission: { resource: "communication", action: "update" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/calendar", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/calendar", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["PATCH", "DELETE"], pattern: "/api/calendar/:id", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/database-mapping/:master/export", permission: { resource: "sales", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/database-mapping/validation/customer-map/export", permission: { resource: "sales", action: "export" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-closing/export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: re-runs the closing matrix + distributor comparison for the requested line+period and serialises to XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-closing/premium-export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: re-reads the closing matrix, its performance review and the invoice detail rows for the requested line+period, writes them into the owner's thirteen-sheet .xlsm engine template and serialises it as XLSM with his button bar live, or as XLSX when the caller passes macros:false; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-closing/rep-ranking-export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: rebuilds the Anti Infective rep ranking workbook for the requested month — the same builder the portal export calls, scoped to the caller by loadPortalMonthlyClosing on every trend month — and serialises it to XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-closing/consolidated-export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export, Super Admin and CEO only: re-runs the closing workbook's own per-month pipeline for each selected month of one line, adds the months together and serialises one XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-closing/consolidated-premium-export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export, Super Admin and CEO only: re-reads the selected months of one line added together, with their performance review and detail rows, writes them into the owner's premium engine template and serialises it as XLSM, or XLSX when the caller passes macros:false; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-closing/premium-export/pdf", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export, and a GET because its caller is a hyperlink inside the workbook: a .xlsx cannot hold code, so a link is the only control that can carry Export PDF. Re-reads the same closing matrix, performance review and detail rows as the workbook export for the requested line+period, renders one sheet as a PDF and returns it; performs no mutation. A link carrying a valid seal (a purpose-bound HMAC under PHOENIX_AUTH_SECRET over the line, month and filters the workbook was built from, closing-pdf-link-seal.ts) is served to whoever holds the workbook, signed in or not, by owner rule 2026-09-14; its selection is read from the seal and never the query string, and its detail rows load as a company-wide non-Super-Admin viewer so El Qema stays masked. An unsealed link keeps sales:export plus company-wide scope, and sends a signed-out reader to sign in." }),
  // ── Spotlight ────────────────────────────────────────────────────────────────────────────────
  // Super Admin and CEO only. All three read the whole company with no scope narrowing, which is
  // why nothing narrower may hold the permission: the module composes other people's names and
  // achievement into a shareable document, so it is a publishing right rather than a reading one.
  sessionApi({ methods: ["GET"], pattern: "/api/spotlight/options", permission: { resource: "spotlight", action: "read" } }),
  sessionApi({ methods: ["POST"], pattern: "/api/spotlight/preview", permission: { resource: "spotlight", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/spotlight/export", permission: { resource: "spotlight", action: "export" } }),
  // The award cheque generator: a presentation cheque built from typed fields, PDF or preview. Same gate as the
  // export (spotlight:export, Super Admin and CEO), and the CEO's signature is read server-side from a private
  // bucket - the signature route holds the one mutation and checks the origin on PUT and DELETE.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/spotlight/cheques", permission: { resource: "spotlight", action: "export" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, csrfRequired: true, methods: ["GET", "PUT", "DELETE"], pattern: "/api/spotlight/cheques/signature", permission: { resource: "spotlight", action: "export" } }),
  // A MEDICAL REP's OWN spotlight — a different gate (`spotlight_self`) held by the rep, never the
  // company-wide `spotlight` above. Both routes resolve his HR id from the session and read nobody
  // else, so this scope narrowing is enforced in the loader, not by the pattern. Owner, 2026-09-30:
  // he filters his own achievement over any period, and the pic/PDF renders only at 90%+ against the
  // published closing.
  sessionApi({ methods: ["POST"], pattern: "/api/spotlight/me/preview", permission: { resource: "spotlight_self", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET", "POST"], pattern: "/api/spotlight/me/sheet", permission: { resource: "spotlight_self", action: "export" } }),
  // Phoenix Ranks certificate: self only, or any rep for the admin twin's audience (Super Admin, CEO, SFE Manager).
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/rep-ranks/certificate", permission: { resource: "early_birds", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET", "POST"], pattern: "/api/employee-portals/performance-card", permission: { resource: "performance_card_self", action: "export" } }),
  // ── Milestones ───────────────────────────────────────────────────────────────────────────────
  // The service-anniversary keepsake. SUPER ADMIN ONLY — the owner narrowed it from Super Admin +
  // CEO on 2026-09-23 ("make it only super admin. None either uh, CEO"). The due list reads every
  // active employee's hire date with no scope narrowing, and the card pulls a named person's
  // photograph out of the private `employee-photos` bucket onto a sheet built to be printed and
  // handed around. That is a publishing right.
  sessionApi({ methods: ["GET"], pattern: "/api/milestones/due", permission: { resource: "milestones", action: "read" } }),

  // Phoenix CRM Wave 2 — which rows in the four systems are the SAME doctor or the same shop.
  // Super Admin alone (`customer_identity`), by the owner's ruling of 2026-09-30: the system
  // suggests and HE confirms, in bulk or one by one. The GET reads every customer in Phoenix CRM,
  // the marketing register, the direct-order desk and the iReports360 mirror at once with no scope
  // narrowing, which is why it is not a team-scoped surface; the POST records his decision and
  // writes ONLY `customer_identity_*` — no source row is merged, renamed, re-territoried or
  // touched in any way, and no rep's board changes because of it. `not_the_same` is kept for good
  // and `withdraw_ruling` undoes it, both stamped with who and when.
  sessionApi({ methods: ["GET"], pattern: "/api/customer-identity/suggestions", permission: { resource: "customer_identity", action: "read" } }),
  sessionApi({ csrfRequired: true, methods: ["POST"], pattern: "/api/customer-identity/decide", permission: { resource: "customer_identity", action: "update" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/milestones/card", permission: { resource: "milestones", action: "export" } }),
  // The rep's OWN card, self-scoped (owner, 2026-09-30). Not the publishing right above: it builds
  // ONLY the caller's own card (access.hrId, never a hrId off the wire), so it needs no `milestones`
  // grant — it is gated by the domain helper canUseEmployeePortalMilestones (Medical Rep), which is
  // why permission is null and guard is domain-helper. It does not record a print row, so it is not a
  // mutation and needs no CSRF.
  sessionApi({ csrfExemptReason: "Self-scoped read: builds only the caller's own keepsake card (POST) or mints a public share link to it (GET); records no row, sets no cookie.", guard: "domain-helper", methods: ["GET", "POST"], pattern: "/api/milestones/my-card", permission: null }),
  // A whole window of cards as one PDF, one card per page. Same publishing right as the single card,
  // and a mutation (it records a print row per card), so csrfRequired. Prints from the record only —
  // it carries no handed-in photograph.
  sessionApi({ audit: { classification: "export", required: true }, csrfRequired: true, methods: ["POST"], pattern: "/api/milestones/batch", permission: { resource: "milestones", action: "export" } }),
  // ONE landscape picture with every ticked face on it, for people who share one occasion (owner,
  // 2026-09-30 — "I want to make a photo that has them all"). The batch's publishing right several
  // times over: it carries several named employees' photographs onto one sheet built to be SENT. A
  // mutation (it records a print row per face), so csrfRequired. From the record only — no
  // handed-in photograph travels, so no face can land beside the wrong name.
  sessionApi({ audit: { classification: "export", required: true }, csrfRequired: true, methods: ["POST"], pattern: "/api/milestones/group", permission: { resource: "milestones", action: "export" } }),
  // The acknowledgement that stops the daily reminder: opening the page marks the current window
  // seen. A mutation (it writes milestone_notice_marks), so csrfRequired; gated on read, since
  // seeing who is coming up is the same right as reading the due list.
  sessionApi({ audit: { classification: "mutation", required: true }, csrfRequired: true, methods: ["POST"], pattern: "/api/milestones/seen", permission: { resource: "milestones", action: "read" } }),
  // The print history — who was congratulated, when, by whom — as JSON for the view and as an .xlsx
  // download. A read of the append-only log (a record, not a control), so gated on read like the due
  // list; GET, so no CSRF.
  sessionApi({ methods: ["GET"], pattern: "/api/milestones/history", permission: { resource: "milestones", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-closing/performance-review", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-closing/performance-review/export", permission: [{ resource: "sales", action: "import" }, { resource: "sales", action: "export" }], csrfExemptReason: "Read-only export for the Super Admin and SFE Manager, plus each sales manager bounded to their own territory and published months (resolved from the caller's own access, never from the body): re-reads the closing for the requested line+period and serialises the rep ranking, family, by-product and by-area views to XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/customer-directory/export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: re-runs the directory query under the caller's filters and serialises it to a styled XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/customer-mapping/export", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: re-runs the customer-mapping consolidation under the caller's filters and serialises it to XLSX; performs no mutation." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/preview", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Read-only: normalizes the uploaded raw distributor sheet in memory against the alias crosswalks and returns a coverage preview; persists nothing." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/download", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: normalizes the uploaded raw sheet and serialises the coded rows to XLSX; persists nothing." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/ai-suggest", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Suggestion-only JSON request: uses submitted unknown labels to suggest Phoenix matches and persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/bootstrap", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: learns source-of-sales aliases from a cleaned distributor workbook." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/learn", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: learns source-of-sales aliases from a completed unmapped-list workbook." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/save", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON-only mapping save: writes selected product, territory, and customer aliases after server-side permission checks." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/template", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Read-only export: lists the distinct unmapped codes from the uploaded raw sheet as a fill-in XLSX; persists nothing." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/normalizer/phoenix-template", permission: { resource: "sales", action: "export" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/import-validated", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: normalizes the uploaded raw sheet, builds the coded workbook in memory, and persists ONLY when it passes the Source-of-Sales validator." }),
  // The held changes as a workbook he answers and uploads back. The export and the preview write
  // nothing; the apply goes through the same guard decision the screen's buttons do.
  // A brick move ("Correct in database") and the rebuild of the files it re-stamped. Both write
  // sales rows or their totals, so each has its own entry rather than the /api/sales/** blanket
  // below, which declares sales:read and carries no audit classification.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/database-mapping/bricks/:key/relocate", permission: { resource: "sales", action: "update" }, csrfExemptReason: "Authenticated admin JSON-only move, Super Admin only: one database transaction (sos_relocate_brick) makes the brick in its right block, keeps the old one as history and carries its pharmacies and its open-month sales; a published month is never changed." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["GET", "POST"], pattern: "/api/sales/brick-moves/refresh", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON-only request, Super Admin only: rebuilds the totals of sales files a brick move already re-stamped inside the database, one claimed file at a time; it moves no row itself. GET only counts the files still waiting." }),
  // The five below had no entry of their own and fell through to the /api/sales/** blanket at the
  // end of this block, which declares sales:read and carries NO audit classification — so four
  // routes that WRITE to the source-of-sales alias and import tables left no audit row, and the
  // registry understated their real gate to anyone reading it. Nothing was reachable that should
  // not have been: every handler under /api/sales/normalizer opens with its own
  // `role !== "Super Admin" && scope !== "system"` check, which is far stricter than the blanket
  // (and `scopeForRole` never returns "system" for any role, so that half is unreachable from a
  // request). Confirmed 2026-08-21 by a 16-role dev-auth sweep: Super Admin through on all 13
  // routes, every other role 403 on all 13 — the CEO included.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/import", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: normalizes the uploaded raw sheet and persists the coded rows; the unvalidated sibling of import-validated." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/auto-map", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON-only auto-mapping: applies the AI's confident customer→brick matches to the alias tables and parks the rest for review." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/learn-from-history", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin backfill: mines every source_of_sales_import_rows row for product_name→product_code and client_code→brick_id pairs and upserts them into the alias tables. Idempotent, but it writes on EVERY call — the handler has no input to bail on." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/mappings/clusters", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Read-only JSON request: clusters the submitted unknown labels in memory so near-duplicates can be mapped in one go; persists nothing." }),
  // Split by method on purpose: GET reports centroid coverage, POST rebuilds every brick centroid.
  // One entry each, so the rebuild is classified as the mutation it is instead of inheriting a read.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/sales/normalizer/unmapped-customers", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/sales/normalizer/brick-centroids", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/normalizer/brick-centroids", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin rebuild: recomputes and persists the geographic centroid of every brick from its customer coordinates. Writes on EVERY call — the handler has no input to bail on." }),
  // Had no entry of its own and fell through to the /api/sales/** blanket below, which carries no
  // audit classification — so this download escaped the export-audit guard twice over (the guard's
  // own regex also required a slash-delimited "template", missing the hyphenated name). The file is
  // a BLANK per-distributor layout with no customer data, but download routes are audited here as a
  // rule. Guarded on sales:import, matching the route's own assertPermission.
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/source-of-sales/raw-template", permission: { resource: "sales", action: "import" } }),
  // Territory Management — read-only geographic view of brick allocation per line.
  // The four Territory Management reads moved from `sales:read` to `territory:read` on 2026-09-07,
  // when the owner asked for the module on the HR Business Partner's sidebar. Not a narrowing of
  // intent: every role the nav offers the module to holds the new key. It IS a narrowing of the raw
  // URL surface — `Employee` carries sales:read, so any signed-in person could call these four and
  // get a fail-closed empty scope back. The writes below still key on sales (import/export).
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/filters", permission: { resource: "territory", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/scope", permission: { resource: "territory", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/map", permission: { resource: "territory", action: "read" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/search", permission: { resource: "territory", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/territory-management/pin", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated Super-Admin-only JSON write: stores one hand-placed brick coordinate after a server-side role check and an Egypt bounding-box validation." }),
  // Area Consolidation — the Super Admin folds a legacy area's live rows onto a current one, and
  // can put them back. The gate is assertAreaConsolidationAccess INSIDE
  // src/lib/territory-management/area-consolidation.ts, not in the handlers: the routes are
  // transport and the service is the boundary, so these carry guard: "domain-helper" like
  // /api/admin/pm-products, rather than naming a permission resource they do not check.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/area-consolidation", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: readOnly, pattern: "/api/territory-management/area-consolidation/:areaId", permission: null, guard: "domain-helper" }),
  // The two writes. Both rewrite area_id on live current-assignment rows, so both are mutations —
  // never reads — and both declare CSRF required, which the handlers already satisfy with
  // assertSameOriginMutation(request) rather than claiming the blanket session exemption.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/territory-management/area-consolidation/:areaId/apply", permission: null, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/territory-management/area-consolidation/reverts/:consolidationId", permission: null, guard: "domain-helper", csrfRequired: true }),
  // Mints and revokes the passwordless preview links below. Gated on EXPORT, never on read:
  // publishing territory past the login wall is the strongest export there is, so a reader who may
  // not download the map must not be able to hand out a public link to it instead. The domain adds
  // a Super Admin check on top — this module's own bar for a privileged act.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET", "POST"], pattern: "/api/territory-management/preview-links", permission: { resource: "sales", action: "export" }, csrfExemptReason: "Authenticated same-origin JSON write guarded by assertSameOriginMutation before the session is resolved." }),
  // Source of Sales — mapping templates + AI-assisted onboarding surfaced inside /sales/import.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-import/product-mapping/template", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-import/territory-mapping/template", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/product-mapping", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: validates the filled product-mapping XLSX against the product master and upserts product aliases." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-import/customer-mapping/template", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/customer-mapping/add", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON add: maps one customer code to a brick after server-side validation." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/customer-mapping", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: validates the filled customer->brick XLSX against the brick master and upserts the customer map." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/bootstrap", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: learns product + customer->brick aliases from a previously coded distributor workbook." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/missing", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Read-only: normalizes the uploaded raw sheet in memory and returns coverage + distinct unknowns; persists nothing." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/ai-suggest", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Suggestion-only JSON request: uses submitted unknown labels to suggest Phoenix matches and persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/save-mappings", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON mapping save: writes selected product/territory aliases after server-side permission checks." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/sales/monthly-import/import-coverage", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/detect", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Read-only distributor detection: parses only the uploaded sheet's header row to suggest the matching distributor; persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/accept-mappings", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON write: persists confirmed customer→brick suggestions to the mapping sheet via the audited addCustomerMapRow." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/preview", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Dry-run preview: validates the uploaded sheet in memory and returns the import-preview diff; persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/commit", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin import: persists the previewed Source of Sales upload after server-side validation." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/monthly-import/cancel", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Discards an abandoned large-file preview by deleting its temporary Storage object; persists no business data." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/master-workbook/export", permission: { resource: "sales", action: "export" } }),
  // Monthly sales batch approvals (/sales/import?tab=approvals) — separate module from
  // Source of Sales and Weekly Sales above; its own upload template only.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/import/template", permission: { resource: "sales", action: "import" } }),
  // Monthly Sales (Achievement) Dashboard detailed workbook — available to everyone who can
  // already read the dashboard (no extra CEO/Super Admin gate, unlike the SoS BI workbook below).
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/sales/monthly-dashboard/export", permission: { resource: "sales", action: "export" } }),
  // Flagship SoS BI workbook — the route additionally hard-gates to CEO / Super Admin via
  // canExportSosDashboard() on top of the sales:export permission asserted here.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/sos-dashboard/export", permission: { resource: "sales", action: "export" } }),
  // Manual on-demand trigger that emails the same workbook to CEO / Super Admin — same hard
  // role gate as the export route above.
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/sos-dashboard/email-report", permission: { resource: "sales", action: "export" }, csrfRequired: true }),
  sessionApi({
    audit: { classification: "mutation", required: true },
    methods: ["POST"],
    pattern: "/api/sales/weekly/validate",
    permission: { resource: "weekly_sales", action: "import" },
    csrfExemptReason: "Authenticated weekly sales upload endpoint; validates file content and persists only when accepted.",
  }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/batches", permission: { resource: "weekly_sales", action: "import" } }),
  sessionApi({ methods: ["DELETE"], pattern: "/api/sales/weekly/batches", permission: { resource: "weekly_sales", action: "import" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/dashboard", permission: { resource: "weekly_sales", action: "read" } }),
  // Weekly Stock — admin-shell feed and export, plus the employee-portal pair (sales:read plus a role gate,
  // like portal Weekly Sales). Scope is resolved from the session (resolveWeeklyAccessScope), so query
  // params only narrow what the caller may already see.
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/stock", permission: { resource: "weekly_sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/stock/export", permission: { resource: "weekly_sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/weekly-stock", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/weekly-stock/export", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/source-of-sales", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/source-of-sales/actions", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/territory-drilldown", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/territory-drilldown/area/:areaCode", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/territory-drilldown/sync", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/employee-portals/territory-drilldown/sync", permission: { resource: "sales", action: "read" }, csrfExemptReason: "Authenticated drilldown-role JSON action: re-stamps Source-of-Sales import rows to today's geography and rebuilds the rollups after server-side permission checks; no cross-site form semantics." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/source-of-sales/export", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/weekly-sales", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/weekly-sales/export", permission: { resource: "sales", action: "read" } }),
  // Weekly Sales Depot Detail. The managers' pair keeps the managers' Weekly Sales gate (a Medical Rep is
  // refused); the rep's pair admits a Medical Rep only and returns his own area's share and nothing wider.
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/weekly-sales/depot-detail", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/weekly-sales/depot-detail/export", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/weekly-sales/rep-depot-detail", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/employee-portals/weekly-sales/rep-depot-detail/export", permission: { resource: "sales", action: "read" } }),
  // Weekly Sales per-product units. Read-only feed for the review's Products by Month tab; the
  // month window is the only query input and the scope comes from the session, so the managers'
  // Weekly Sales gate is the whole check.
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/weekly-sales/product-units", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: readOnly, pattern: "/api/employee-portals/double-visit-report/export", permission: { resource: "double_visit_analytics", action: "export" }, guard: "domain-helper" }),
  // Team Calendar rep-day visits drill-down. Role-checked in the handler (National Sales
  // Manager only) plus a per-line scope guard (isHrIdInNsmTeamScope) rather than a matrix
  // resource, so it registers as a domain-helper guard with no matrix permission.
  sessionApi({ methods: ["GET"], pattern: "/api/employee-portals/team-calendar/visits", permission: null, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/export", permission: { resource: "weekly_sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/summary-export", permission: { resource: "weekly_sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/nsm-dsm-export", permission: { resource: "weekly_sales", action: "read" } }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/sales/weekly/product-scope", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/branch-mapping/template", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/branch-mapping", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/branch-mapping", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Authenticated weekly branch->region mapping upsert/import; server validates distributor + master region before write." }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/product-mapping/template", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/sales/weekly/product-mapping", permission: { resource: "weekly_sales", action: "update" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/product-mapping", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Authenticated weekly product alias upsert/import; server validates each product_code against the Source-of-Sales master before write." }),
  // `/api/sales/weekly/mapping`, `/mapping/export` and `/mapping/import` stood here until
  // 2026-10-08. They were the API half of the old mapping/missing pages, which the current
  // /sales/weekly/mapping page replaced — that page loads server-side through
  // loadWeeklyBranchRegionAdmin/loadWeeklyProductAliasAdmin and its workspace calls
  // branch-mapping and product-mapping above. No route.ts has existed at any of the three for as
  // long as this registry has named them, so they declared guards over nothing.
  // Both declared `weekly_sales:update` until 2026-09-03; both handlers assert `weekly_sales:import`.
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/sales/weekly/pos-region-mappings", permission: { resource: "weekly_sales", action: "import" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/weekly/pos-region-mappings/template", permission: { resource: "weekly_sales", action: "import" } }),
  // Weekly Normalizer — the weekly twin of /api/sales/normalizer/**, and registered the same way:
  // one explicit entry each, never falling through to the /api/sales/** blanket, which carries no
  // audit requirement. The template route is the one that MUST be classified `export` — it hands
  // back a workbook naming every unmapped distributor item and depot, which is disclosure.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/normalizer/preview", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Read-only: parses the uploaded raw weekly sheet in memory against the alias + branch-region crosswalks and returns a coverage preview; persists nothing, and never touches weekly_sales_batches/_rows." }),
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/normalizer/mappings/ai-suggest", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Suggestion-only JSON request: uses submitted unknown item/branch labels to suggest Phoenix matches and persists nothing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/normalizer/mappings/save", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Authenticated admin JSON-only mapping save: writes selected weekly product aliases and branch->region rows after server-side permission checks." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/normalizer/mappings/learn", permission: { resource: "weekly_sales", action: "update" }, csrfExemptReason: "Authenticated admin import: learns weekly product aliases and branch->region rows from a completed unmapped-list workbook." }),
  // `update`, not `export`: the workbook embeds the unscoped master product/region/area catalogue
  // (incl. the confidential Head Office line), so it belongs to the mapping audience, not the
  // read+export audience that reaches down to Medical Rep.
  // guard: "domain-helper" — gated via assertWeeklyMappingTemplatePermission, which is `update` PLUS
  // a route-scoped CEO exception (the CEO is already cleared for the Head Office line but holds
  // read+export only; see src/lib/auth/permissions.ts). Same shape as the fingerprint report.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/weekly/normalizer/mappings/template", permission: { resource: "weekly_sales", action: "update" }, guard: "domain-helper", csrfExemptReason: "Read-only export: lists the distinct unmapped item codes and branches from the uploaded raw weekly sheet as a fill-in XLSX; persists nothing." }),
  // Sales Targets (au monthly targets/achievement) — Super Admin + SFE Manager via sales:import.
  // The per-area drill-down READ is sales:read so the scoped read-only Targets view can expand a
  // row, but it additionally enforces assertTargetsAreaInScope on the caller-supplied `area` — the
  // permission alone would let any DM enumerate another area's distributor/brick/customer detail.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/sales/targets/breakdown", permission: { resource: "sales", action: "read" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/targets/breakdown/export", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "export", required: true }, methods: ["GET"], pattern: "/api/sales/targets/template", permission: { resource: "sales", action: "import" } }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/targets/save", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON-only targets upsert (sales:import); map-or-reject validated server-side, rejects confidential products." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/targets/drop", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin JSON-only drop of one line's targets for one month (sales:import AND Super Admin only); archives the rows first, refuses a published or locked closing." }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/sales/targets/upload", permission: { resource: "sales", action: "import" }, csrfExemptReason: "Authenticated admin targets XLSX import (sales:import); parsed + map-or-reject validated server-side before persist." }),
  // Sales Truth Check — reconciles every sales surface against Monthly Closing, area by area.
  // An explicit entry rather than the /api/sales/** blanket below, which carries no audit
  // classification: the response names every area of every line with its month's sales value, so
  // it is the same disclosure shape as the territory-management reads above and is audited like
  // them. Read-only and GET-only — it recomputes nothing and persists nothing.
  sessionApi({ audit: { classification: "access-read", required: true }, methods: ["GET"], pattern: "/api/sales/truth-check", permission: { resource: "sales", action: "read" } }),
  // Make It Happen forecast download (XLSX or PDF). Its own entry because it is an export and must be
  // audited: the file carries target, sales and forecast value for the caller's plan scope. It needs
  // only sales:read because it holds nothing the planner screen does not already show that caller —
  // the route rebuilds the workspace in the caller's own scope before writing a byte.
  sessionApi({ audit: { classification: "export", required: true }, methods: ["POST"], pattern: "/api/sales/make-it-happen/export", permission: { resource: "sales", action: "read" }, csrfRequired: true }),
  sessionApi({ methods: allMethods, pattern: "/api/sales/**", permission: { resource: "sales", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/report-it/list", permission: { resource: "report_it", action: "read" }, guard: "domain-helper" }),
  sessionApi({ audit: { classification: "mutation", required: true }, methods: ["POST"], pattern: "/api/report-it/submit", permission: { resource: "report_it", action: "create" }, guard: "domain-helper", csrfExemptReason: "JSON-only employee ADR submission; all authenticated roles can submit their own reports." }),
  sessionApi({ methods: ["GET"], pattern: "/api/report-it/:id", permission: { resource: "report_it", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: allMethods, pattern: "/api/support/**", permission: { resource: "support_requests", action: "read" }, guard: "domain-helper" }),
  sessionApi({ methods: ["GET", "POST"], pattern: "/api/business-card-requests", permission: { resource: "business_card_requests", action: "create" }, guard: "domain-helper", csrfRequired: true }),
  sessionApi({ audit: { classification: "export", required: true }, methods: allMethods, pattern: "/api/vacations/**", permission: { resource: "leave", action: "read" }, csrfRequired: true, guard: "domain-helper" }),
  sessionApi({ methods: ["POST"], pattern: "/api/activity/track", permission: null, guard: "domain-helper", csrfExemptReason: "Fire-and-forget activity beacon: records ONLY the authenticated caller's own page view. Identity is taken from the session cookie, never the request body, so there is no cross-site mutation surface." }),
  // Self-hosted crash-report beacon (Error Monitor). Must also accept guests
  // (e.g. a crash on the login page before any session exists) — identity is
  // read from the session cookie when present, never trusted from the body.
  sessionApi({ methods: ["POST"], pattern: "/api/errors/client", permission: null, guard: "domain-helper", csrfExemptReason: "Fire-and-forget crash-report beacon, open to guests too. Identity comes only from the session cookie (or is absent for guests), never the request body; writes only a truncated error message/stack to app_error_events, so there is no state-changing or cross-site mutation surface." }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/pending-count", permission: { resource: "leave", action: "read" } }),
  // Batched replacement for the pending-count polls below plus
  // /api/marketing-requests/pending-count (covered by the /api/marketing-requests/** entry, whose
  // domain-helper guard is the same model its sibling /inbox already uses — marketing has no
  // permission resource, so the badge is scoped by the caller's own assigned_hr_id instead). They
  // all stay registered and live for other consumers; each sub-count enforces its own domain guard.
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/badge-counts", permission: [{ resource: "leave", action: "read" }, { resource: "weekly_plans", action: "read" }, { resource: "direct_orders", action: "read" }] }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/vacation/pending-count", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/excuse/pending-count", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/plan/pending-count", permission: { resource: "weekly_plans", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals/direct-orders/pending-count", permission: { resource: "direct_orders", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/employee-context", permission: { resource: "leave", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/hub-data", permission: { resource: "employees", action: "read" } }),
  sessionApi({ methods: ["GET"], pattern: "/api/approvals-hub/managers", permission: { resource: "employees", action: "read" } }),
  // Removed 2026-10-08, five entries that declared guards over routes with no route.ts:
  //   /api/approvals-hub/historical — never built.
  //   /api/action-center/{pending-count,employee-context,hub-data,managers} — carried the comment
  //   "kept for backwards compat (old bookmarks)", but the handlers themselves are gone, so an old
  //   bookmark 404s whatever this file says. The live surface is /api/approvals-hub/** above.
  // Declaring a pattern here cannot create, route or protect anything — the registry is a
  // declarative inventory — so an entry for a missing route only misinforms whoever reads it to
  // learn what is callable.

  { ...sessionApi({ methods: readOnly, pattern: "/admin/weekly-plans", permission: { resource: "weekly_plans", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/weekly-plans/calendar", permission: { resource: "weekly_plans", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/private-calendars", permission: { resource: "attendance", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/marketing-requests/control", permission: null, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/double-visit-analytics", permission: { resource: "double_visit_analytics", action: "read" }, guard: "domain-helper" }), surface: "page" },
  // Employee 360 — consolidated per-employee profile (visits/check-ins in v1). Gated by
  // employee_profile:read; the page enforces per-row visibility via canSeeEmployee. Lives at
  // /employee-360 (the (admin) route group adds no URL segment), so it matches neither the
  // /admin/** nor /employee-portals/** catch-alls and needs its own explicit entries.
  { ...sessionApi({ methods: readOnly, pattern: "/employee-360", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/employee-360/**", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/workspace/**", permission: { resource: "employee_profile", action: "read" }, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/**", permission: { resource: "admin", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/employee-portals/**", permission: { resource: "employee_profile", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/attendance/exceptions", permission: null, guard: "domain-helper" }), surface: "page" },
  // Approvals Hub › Vacation & Excuse approval pages — gated by leave:read so the confirmed
  // approver set (incl. CEO / Finance Manager / Financial Advisor) is not blocked by the
  // /admin/** admin:read catch-all. (Replaces the removed Vacation Action Center page.)
  { ...sessionApi({ methods: readOnly, pattern: "/admin/approvals/**", permission: { resource: "leave", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/employee-portals/approvals/**", permission: { resource: "leave", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/outstation/expenses", permission: null, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/admin/outstation/expenses/dashboard", permission: null, guard: "domain-helper" }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/payroll/**", permission: { resource: "payroll", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/assignments", permission: { resource: "weekly_sales", action: "update" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/dashboard", permission: { resource: "weekly_sales", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/stock", permission: { resource: "weekly_sales", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/mapping", permission: { resource: "weekly_sales", action: "update" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/branch-mapping", permission: { resource: "weekly_sales", action: "update" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly/product-mapping", permission: { resource: "weekly_sales", action: "update" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/weekly", permission: { resource: "weekly_sales", action: "import" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/sales/**", permission: { resource: "sales", action: "read" } }), surface: "page" },
  { ...sessionApi({ methods: readOnly, pattern: "/reports/**", permission: { resource: "vacancies", action: "read" } }), surface: "page" },
] as const satisfies readonly AccessRegistryEntry[];

export function normalizeRoutePattern(input: string) {
  return input
    .replace(/\\/g, "/")
    .replace(/^app\/api/, "/api")
    .replace(/\/route\.ts$/, "")
    .replace(/\[([^\]]+)\]/g, ":$1");
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function registryPatternToRegex(pattern: string) {
  const segments = pattern.split("/").map((segment) => {
    if (segment === "**") return ".*";
    if (segment === "*") return "[^/]+";
    if (segment.startsWith(":")) return "[^/]+";
    return escapeRegex(segment);
  });
  return new RegExp(`^${segments.join("/")}$`);
}

function routeMatchesPattern(route: string, pattern: string) {
  if (pattern.endsWith("/**") && route === pattern.slice(0, -3)) return true;
  return registryPatternToRegex(pattern).test(route);
}

export function findAccessRegistryEntry(route: string, method?: HttpMethod) {
  const matches = accessRegistry.filter((entry) => {
    if (entry.surface !== "api") return false;
    if (method && !(entry.methods as readonly HttpMethod[]).includes(method)) return false;
    return routeMatchesPattern(route, entry.pattern);
  });
  return matches.sort((left, right) => right.pattern.length - left.pattern.length)[0] ?? null;
}

export function createSecurityPreflightResult(input: Omit<SecurityPreflightResult, "checkedAt" | "passed">): SecurityPreflightResult {
  return {
    ...input,
    checkedAt: new Date().toISOString(),
    passed: input.failures.length === 0,
  };
}
