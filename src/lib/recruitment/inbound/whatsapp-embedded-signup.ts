/**
 * Public identifiers for the WhatsApp Embedded Signup "coexistence" flow served at /whatsapp-connect.
 *
 * Coexistence links the owner's existing WhatsApp Business *app* number into the same WhatsApp
 * Business Account the recruitment intake webhook already listens on, so CVs sent to that handset
 * flow into intake automatically — WITHOUT migrating the number to Cloud API (which would sign the
 * phone out of WhatsApp). The webhook (app/api/webhooks/whatsapp/route.ts) is account-scoped, not
 * number-scoped, so once the handset joins the account its messages arrive through the existing
 * pipeline with no further wiring.
 *
 * The app id and configuration id are NOT secrets — the Facebook JS SDK sends both to the browser as
 * part of the login dialog. They are hardcoded rather than environment variables on purpose: they are
 * permanent, version-controlled and reviewed, whereas an env var here could silently drift from the
 * code that depends on it (the same reasoning whatsapp-health.ts uses to read the app id back from
 * debug_token instead of adding a variable). The app SECRET stays in WHATSAPP_APP_SECRET, server-only.
 */

// Meta app "Phoenix HR Workforce".
export const WHATSAPP_EMBEDDED_SIGNUP_APP_ID = "1725159208692148";

// Facebook Login for Business configuration created from Meta's "WhatsApp embedded sign-up
// configuration" template: login variation = WhatsApp Embedded Signup, asset = WhatsApp accounts,
// permissions = whatsapp_business_management + whatsapp_business_messaging.
export const WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID = "2089438105259208";

// The FB.login extras flag that turns the standard Embedded Signup into the coexistence flow —
// onboarding an existing WhatsApp Business app number rather than creating a fresh Cloud API number.
// Meta retired the older value "coexistence"; this is the current, required value.
export const WHATSAPP_EMBEDDED_SIGNUP_FEATURE_TYPE = "whatsapp_business_app_onboarding";

// Graph API version the Facebook JS SDK initialises with (FB.init) on the client. A fixed public
// constant; the server-side code exchange picks its Graph version the same way the rest of the
// integration does (WHATSAPP_GRAPH_API_VERSION, default v23.0 — see the exchange route).
export const WHATSAPP_EMBEDDED_SIGNUP_SDK_VERSION = "v23.0";
