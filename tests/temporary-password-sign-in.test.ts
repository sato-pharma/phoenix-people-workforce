import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  composeTemporaryPasswordMessage,
  passwordSetupWhatsAppUrl,
} from "@/lib/auth/password-setup-whatsapp.ts";
import {
  createReadableTemporaryPassword,
  TEMPORARY_PASSWORD_METRIC_LABEL,
  TEMPORARY_PASSWORD_PATTERN,
  TEMPORARY_PASSWORD_SIGN_IN_LABEL,
  TEMPORARY_PASSWORD_USERNAME_LABEL,
  temporaryPasswordSetupPath,
  temporaryPasswordSignInGate,
} from "@/lib/auth/temporary-password.ts";
import { CREDENTIAL_REMOVED, redactCredentialEmailBody } from "@/lib/email/credential-redaction.ts";
import { isCredentialEmailKind, shouldMirrorEmailToAdminTelegram } from "@/lib/email/transactional-types.ts";
import { emailTemplateKeys } from "@/lib/email-templates/key-resolution.ts";
import { contextVariables, htmlBlockTokens, interpolate } from "@/lib/email-templates/render-core.ts";
import { migratedTemplateKeyForNotification } from "@/lib/notifications/email.ts";

/**
 * THE ACCOUNT MESSAGE CARRIES A USERNAME, A TEMPORARY PASSWORD AND THE SIGN-IN LINK (owner, 12 Nov 2026).
 *
 * His words: send the username, a password and the production link; the person copies them into the
 * sign-in page and is taken inside to change the password, which stays their current password until
 * they choose their own. By email, as a WhatsApp message, and on Telegram.
 *
 * Each section pins one link of the chain, and the chain fails SILENTLY at every link:
 *  1. the password's shape — readable, strong, and matched by the redaction pattern;
 *  2. the sign-in decision — a temporary password opens the choose-your-password screen and NOTHING
 *     else; any other pending password (a reset link leaves the OLD password in place) is refused;
 *  3. the email reaches its own template, whose body renders {{detailsTable}} — on the shared link
 *     bodies the password renders into nothing (the reset-code defect of 2026-10-07, twice);
 *  4. the stored copies are sealed and redacted, and the admin Telegram never gets a copy;
 *  5. the WhatsApp/Telegram message is in the owner's order;
 *  6. the sign-in route decides BEFORE any session exists, and answers 403, never 200.
 */

const TEMPLATE_KEY = "account_temporary_password";
// Generated per run, so no password-shaped literal sits in the repository (the pre-push secret scan reads one as a key).
const SAMPLE_PASSWORD = createReadableTemporaryPassword();

function templateDefaultBlock(source: string, key: string) {
  const start = source.indexOf(`\n  ${key}: {\n`);
  assert.notEqual(start, -1, `templateDefaults is missing an entry for ${key}`);
  const end = source.indexOf("\n  },\n", start);
  assert.notEqual(end, -1, `templateDefaults entry for ${key} is not terminated`);
  return source.slice(start, end);
}

export function runTemporaryPasswordSignInTests() {
  // --- 1. the password itself ----------------------------------------------------------------
  const seen = new Set<string>();
  for (let index = 0; index < 300; index += 1) {
    const password = createReadableTemporaryPassword();
    assert.match(password, /^Phx-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/, `unexpected temporary password shape: ${password}`);
    assert.doesNotMatch(password.slice(4), /[0O1lI]/, "a temporary password must not use characters people misread (0 O 1 l I)");
    const body = password.slice(4).replace(/-/g, "");
    assert.ok(/[A-Z]/.test(body) && /[a-z]/.test(body) && /[0-9]/.test(body), "a temporary password carries an upper, a lower and a digit");
    TEMPORARY_PASSWORD_PATTERN.lastIndex = 0;
    assert.ok(TEMPORARY_PASSWORD_PATTERN.test(password), "the redaction pattern must match every generated temporary password");
    seen.add(password);
  }
  assert.equal(seen.size, 300, "300 temporary passwords must all differ");

  // --- 2. the sign-in decision ---------------------------------------------------------------
  const now = new Date("2026-11-12T10:00:00Z");
  const future = "2026-11-19T10:00:00Z";
  const past = "2026-11-12T09:59:59Z";
  assert.equal(temporaryPasswordSignInGate({ forcePasswordReset: false, temporaryPasswordExpiresAt: null }, now), "sign_in");
  assert.equal(
    temporaryPasswordSignInGate({ forcePasswordReset: false, temporaryPasswordExpiresAt: future }, now),
    "sign_in",
    "once the person has chosen their own password the marker means nothing",
  );
  assert.equal(temporaryPasswordSignInGate({ forcePasswordReset: true, temporaryPasswordExpiresAt: future }, now), "choose_password");
  assert.equal(temporaryPasswordSignInGate({ forcePasswordReset: true, temporaryPasswordExpiresAt: past }, now), "temporary_password_expired");
  assert.equal(
    temporaryPasswordSignInGate({ forcePasswordReset: true, temporaryPasswordExpiresAt: null }, now),
    "setup_required",
    "a pending reset LINK leaves the old password in place — the old password must keep being refused, never open the set-a-new-one screen",
  );
  assert.equal(
    temporaryPasswordSignInGate({ forcePasswordReset: true, temporaryPasswordExpiresAt: "not a date" }, now),
    "temporary_password_expired",
    "an unreadable marker opens nothing",
  );
  assert.equal(temporaryPasswordSetupPath("abc_DEF-123"), "/password-setup/abc_DEF-123?then=sign-in");

  // --- 3. the email reaches its own template, and the template renders the password ----------
  assert.ok((emailTemplateKeys as readonly string[]).includes(TEMPLATE_KEY), `${TEMPLATE_KEY} must be a known template key`);
  const metrics = [
    { label: TEMPORARY_PASSWORD_USERNAME_LABEL, value: "B-77" },
    { label: TEMPORARY_PASSWORD_METRIC_LABEL, value: SAMPLE_PASSWORD },
    { label: TEMPORARY_PASSWORD_SIGN_IN_LABEL, value: "https://phoenix-hr.satopharma.com/login" },
  ];
  for (const notificationType of ["user_created", "password_reset"] as const) {
    const resolved = migratedTemplateKeyForNotification({
      ctaHref: "/login",
      metrics,
      notificationType,
      summary: "s",
      title: "t",
      // A sender's pinned auth key is vetoed by design; routing must come from the content's shape.
      templateKey: "password_setup",
    } as Parameters<typeof migratedTemplateKeyForNotification>[0]);
    assert.equal(resolved, TEMPLATE_KEY, `${notificationType} carrying a temporary password must render on ${TEMPLATE_KEY}, not a link body that drops the metrics`);
  }
  assert.equal(
    migratedTemplateKeyForNotification({
      ctaHref: "/password-setup/tok",
      metrics: [{ label: "Login ID", value: "B-77" }],
      notificationType: "user_created",
      summary: "s",
      title: "Create your Phoenix Workforce password",
    } as Parameters<typeof migratedTemplateKeyForNotification>[0]),
    "password_setup",
    "the copy-mode setup link keeps its own template",
  );

  const service = readFileSync("src/lib/email-templates/service.ts", "utf8");
  const block = templateDefaultBlock(service, TEMPLATE_KEY);
  const bodyHtml = /bodyHtml:\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
  const bodyText = /bodyText:\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
  assert.ok(bodyHtml && bodyText, `${TEMPLATE_KEY} must define bodyHtml and bodyText`);
  const detailsTable = metrics.map((metric) => `<tr><td>${metric.label}</td><td>${metric.value}</td></tr>`).join("");
  const variables = contextVariables(
    {
      detailsTable: `<table>${detailsTable}</table>`,
      detailsTableText: metrics.map((metric) => `${metric.label}: ${metric.value}`).join("\n"),
      summary: "Copy your username and temporary password below into the sign-in page.",
    },
    "Mona Adel",
  );
  const renderedHtml = interpolate(bodyHtml!.replace(/\\n/g, "\n"), variables, true, htmlBlockTokens);
  const renderedText = interpolate(bodyText!.replace(/\\n/g, "\n"), variables, false);
  for (const metric of metrics) {
    assert.ok(renderedHtml.includes(metric.value), `the rendered HTML account email must contain ${metric.label}`);
    assert.ok(renderedText.includes(metric.value), `the rendered text account email must contain ${metric.label}`);
  }
  assert.match(service, /EMAIL_TEMPLATE_KEYS\.ACCOUNT_TEMPORARY_PASSWORD,/, "the account email carries no List-Unsubscribe (authTemplateKeys)");

  // --- 4. sealed, redacted, never mirrored ----------------------------------------------------
  assert.ok(isCredentialEmailKind("temporary_password"), "temporary_password must be a credential kind, so the outbox seals it");
  assert.equal(shouldMirrorEmailToAdminTelegram({ credentialEmail: "temporary_password", testingRedirectActive: false }), false);
  const stored = redactCredentialEmailBody(`<td>Temporary password</td><td>${SAMPLE_PASSWORD}</td> colour #003366`, "temporary_password");
  assert.ok(!stored.includes(SAMPLE_PASSWORD), "a stored copy of the rendered email must not keep the temporary password");
  assert.ok(stored.includes(CREDENTIAL_REMOVED) && stored.includes("#003366"));
  assert.equal(redactCredentialEmailBody(SAMPLE_PASSWORD, null), SAMPLE_PASSWORD, "only stamped credential emails are rewritten");
  const sender = stripComments(readFileSync("src/lib/auth/password-setup.ts", "utf8"));
  assert.match(sender, /credentialEmail:\s*"temporary_password"/, "the account email must be stamped temporary_password");

  // --- 5. the WhatsApp / Telegram message, in the owner's order -------------------------------
  const message = composeTemporaryPasswordMessage({
    expiresAt: "2026-11-19T10:00:00Z",
    loginId: "B-77",
    name: "Mona Adel",
    purpose: "setup",
    signInUrl: "https://phoenix-hr.satopharma.com/login",
    temporaryPassword: SAMPLE_PASSWORD,
  });
  const usernameAt = message.indexOf("Username: B-77");
  const passwordAt = message.indexOf(`Temporary password: ${SAMPLE_PASSWORD}`);
  const linkAt = message.indexOf("Sign in at: https://phoenix-hr.satopharma.com/login");
  assert.ok(usernameAt > 0 && passwordAt > usernameAt && linkAt > passwordAt, "the message reads username, then password, then the production link");
  assert.ok(message.startsWith("Dear Mona Adel,"), "greets the person by name");
  assert.ok(!message.includes("…") && !message.includes("..."), "no ellipsis");
  assert.match(message, /\(Cairo\)/, "the expiry reads in Cairo time");
  assert.ok(
    passwordSetupWhatsAppUrl("201012345678", message).startsWith("https://wa.me/201012345678?text="),
    "the WhatsApp chat opens on that person's number",
  );

  // --- 6. the sign-in route decides before any session exists ---------------------------------
  const login = stripComments(readFileSync("app/api/auth/login/route.ts", "utf8"));
  const gateAt = login.indexOf("temporaryPasswordSignInGate(user)");
  assert.ok(gateAt > 0, "the sign-in route must ask temporaryPasswordSignInGate");
  assert.ok(gateAt < login.indexOf("createAppSession("), "the temporary-password decision must come before any session is created");
  assert.ok(gateAt < login.indexOf("createSessionToken("), "the temporary-password decision must come before any session token is minted");
  const branch = login.slice(gateAt, login.indexOf('pendingPassword === "temporary_password_expired"'));
  assert.match(branch, /status:\s*403/, "a temporary-password sign-in answers 403 to a JSON caller, so nothing treats it as signed in");
  assert.doesNotMatch(branch, /phoenixSessionCookieName/, "a temporary-password sign-in sets no session cookie");

  const page = stripComments(readFileSync("src/components/auth/premium-login-page.tsx", "utf8"));
  assert.match(page, /redirectTo\?\.startsWith\("\/password-setup\/"\)/, "the sign-in page follows only the server's own /password-setup path");
}
