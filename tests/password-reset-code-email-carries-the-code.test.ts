import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { passwordResetCodeMetricLabel } from "@/lib/auth/password-reset-code.ts";
import { emailTemplateKeys } from "@/lib/email-templates/key-resolution.ts";
import { contextVariables, htmlBlockTokens, interpolate } from "@/lib/email-templates/render-core.ts";
import { migratedTemplateKeyForNotification } from "@/lib/notifications/email.ts";

/**
 * THE SELF-SERVICE RESET EMAIL MUST CONTAIN THE SIX DIGITS.
 *
 * What happened. The code sign-in / self-service reset shipped on 2026-10-07 (#5418). The code
 * itself travels one way only: requestPasswordResetCode puts it in the notification `metrics` as
 * "Your code", and `metrics` reaches the email through exactly ONE token — {{detailsTable}}. The
 * send was routed to the SHARED `password_reset` template, whose stored production body (edited
 * 2026-08-19, months before the feature) is a link email: "To create a new password, please click
 * the link below… {{ctaUrl}} … {{expiryText}}". It has no {{detailsTable}}, and the repo default
 * for that key has none either. So every code rendered into NOTHING.
 *
 * It failed silently and completely: the code row was written, the outbox row went `sent`, Resend
 * reported `delivered` to the Sato mailbox — and the employee opened an email with no code in it.
 * Measured on production: three codes delivered 2026-10-07, `attempts = 0` on all three, not one
 * ever entered. Nothing in the app was red.
 *
 * The fix is a template of its own, `password_reset_code`, whose body renders the metrics table.
 * A brand-new key has no stored row, so the repo default below is what production renders.
 *
 * Each assertion here pins one link of that single chain. Break any one and the email goes out
 * looking perfectly healthy with no code inside it.
 *
 * THEN IT HAPPENED A SECOND TIME, AND THIS FILE IS WHY. The fix above pinned the template key on
 * the sender; sections 1-5 all passed; and the email STILL had no code — because the resolver
 * vetoes an explicitly pinned AUTH key on purpose, and section 3 had just added the code key to
 * that very auth set. Every assertion in the PR read SOURCE TEXT, so not one of them could see
 * that the routing discarded the pin. Section 6 EXECUTES the resolver, which is the lesson:
 * assert the behaviour, not the line of code that intends it.
 *
 * Section 7 pins the owner's 2026-10-08 instruction - this one email carries no standing admin
 * BCC, because its body is a live credential rather than a record of a workflow.
 */

const CODE_TEMPLATE_KEY = "password_reset_code";

function templateDefaultBlock(source: string, key: string) {
  const start = source.indexOf(`\n  ${key}: {\n`);
  assert.notEqual(start, -1, `templateDefaults is missing an entry for ${key}`);
  const end = source.indexOf("\n  },\n", start);
  assert.notEqual(end, -1, `templateDefaults entry for ${key} is not terminated`);
  return source.slice(start, end);
}

export function runPasswordResetCodeEmailCarriesTheCodeTests() {
  const service = readFileSync("src/lib/email-templates/service.ts", "utf8");
  const sender = readFileSync("src/lib/auth/password-setup.ts", "utf8");

  // --- 1. the sender routes the code email to its OWN template ------------------------------
  // Without this it falls back to the notificationType mapping, which is `password_reset` — the
  // admin LINK template that dropped the digits.
  assert.match(
    sender,
    /templateKey:\s*EMAIL_TEMPLATE_KEYS\.PASSWORD_RESET_CODE/,
    "requestPasswordResetCode must send with templateKey PASSWORD_RESET_CODE — the notificationType mapping resolves to the link template, which renders no code",
  );

  // --- 2. the digits are carried under the shared label ------------------------------------
  assert.match(
    sender,
    /label:\s*passwordResetCodeMetricLabel,\s*value:\s*code/,
    "the code must be passed as the passwordResetCodeMetricLabel metric — that constant is what ties the sender to the rendered table",
  );

  // --- 3. the key is real and fully registered ---------------------------------------------
  assert.ok(
    (emailTemplateKeys as readonly string[]).includes(CODE_TEMPLATE_KEY),
    `${CODE_TEMPLATE_KEY} must be in emailTemplateKeys or normalizeTemplateKey drops it and the mapping silently applies instead`,
  );
  assert.match(
    service,
    new RegExp(`^  ${CODE_TEMPLATE_KEY}: "`, "m"),
    `${CODE_TEMPLATE_KEY} needs a templateCategories entry`,
  );
  assert.match(
    service,
    new RegExp(`^  ${CODE_TEMPLATE_KEY}: emptyRules\\(`, "m"),
    `${CODE_TEMPLATE_KEY} needs a defaultRules entry so its routing is visible in /admin/email-templates`,
  );
  assert.match(
    service,
    /EMAIL_TEMPLATE_KEYS\.PASSWORD_RESET_CODE,/,
    "password_reset_code must be in the authTemplateKeys set — a one-time credential email carries no List-Unsubscribe",
  );

  // --- 4. THE HEADLINE: the body actually renders the code ---------------------------------
  const block = templateDefaultBlock(service, CODE_TEMPLATE_KEY);
  const bodyHtml = /bodyHtml:\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
  const bodyText = /bodyText:\s*"((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
  assert.ok(bodyHtml, `${CODE_TEMPLATE_KEY} must define bodyHtml`);
  assert.ok(bodyText, `${CODE_TEMPLATE_KEY} must define bodyText`);

  // Rendered through the REAL engine, with a details table shaped like the one the pipeline
  // builds from the "Your code" metric.
  const code = "408913";
  const detailsTable = `<table><tr><td>${passwordResetCodeMetricLabel}</td><td>${code}</td></tr></table>`;
  const variables = contextVariables(
    {
      detailsTable,
      detailsTableText: `${passwordResetCodeMetricLabel}: ${code}`,
      summary: "Enter this 6-digit code on the Phoenix password page.",
    },
    "Omar Anwar",
  );

  const renderedHtml = interpolate(bodyHtml!.replace(/\\n/g, "\n"), variables, true, htmlBlockTokens);
  const renderedText = interpolate(bodyText!.replace(/\\n/g, "\n"), variables, false);

  assert.ok(
    renderedHtml.includes(code),
    `the rendered ${CODE_TEMPLATE_KEY} HTML body must contain the 6-digit code — it does not, so the employee receives an email with no code in it (the 2026-10-07 production defect)`,
  );
  assert.ok(
    renderedText.includes(code),
    `the rendered ${CODE_TEMPLATE_KEY} text body must contain the 6-digit code — a plain-text mail client would show no code`,
  );

  // --- 5. and the table arrives as HTML, not escaped markup --------------------------------
  assert.ok(
    htmlBlockTokens.has("detailsTable"),
    "detailsTable must stay an HTML-block token, or the metrics table is escaped and the code arrives inside visible <table> markup",
  );
  assert.ok(
    renderedHtml.includes("<table>"),
    "the details table must render as real HTML in the code email",
  );

  // --- 6. THE SECOND HEADLINE: the real resolver, executed ----------------------------------
  // Not the sender's source line — the function that decides. It vetoes every explicitly pinned
  // auth key (so a wording override cannot move account-recovery mail onto another template's
  // recipient expansion), and section 3 above put the code key INTO that auth set. So the pin was
  // silently dropped and the send fell through to `password_reset`, the link body, exactly as
  // before. The resolver reads the notification's own shape instead, which a template editor
  // cannot change.
  const codeNotification = {
    metrics: [{ label: passwordResetCodeMetricLabel, value: "408913" }],
    notificationType: "password_reset" as const,
    recipients: ["employee@satopharma.com"],
    subject: "Your Phoenix password reset code",
    summary: "Enter this code.",
    templateKey: CODE_TEMPLATE_KEY,
    title: "Password reset",
  };

  assert.equal(
    migratedTemplateKeyForNotification(codeNotification as never),
    CODE_TEMPLATE_KEY,
    `the resolver must route the self-service code notification to ${CODE_TEMPLATE_KEY} — it resolved to the shared link template instead, which renders no {{detailsTable}}, so the employee gets an email with no code (the 2026-10-08 repeat of the same defect)`,
  );

  // The metric alone is enough: the pin is intent, the shape is the fact.
  assert.equal(
    migratedTemplateKeyForNotification({ ...codeNotification, templateKey: undefined } as never),
    CODE_TEMPLATE_KEY,
    "a code notification must resolve by its own shape even with no templateKey pinned — the pin is discarded by the auth-key veto anyway",
  );

  // And the admin-minted reset LINK keeps the link template: it has no code metric, and its body
  // is the {{ctaUrl}} one. Routing it to the code template would send a link email with an empty
  // details table and no link.
  assert.equal(
    migratedTemplateKeyForNotification({
      ctaHref: "/password-reset/token-abc",
      metrics: [],
      notificationType: "password_reset" as const,
      recipients: ["employee@satopharma.com"],
      subject: "Reset your password",
      summary: "Click the link.",
      title: "Password reset",
    } as never),
    "password_reset",
    "the admin-minted reset LINK must stay on the password_reset template — it carries no code metric",
  );

  // --- 7. the code email carries NO admin BCC -----------------------------------------------
  // Owner, 2026-10-08: "stop bcc-ing the reset code email to my mailbox" — the first exemption
  // from the standing admin BCC. On 2026-11-06 he stopped the standing BCC on EVERY automated
  // email ("Stop the BCC copies"), so the code email is covered by the general rule: the send
  // path adds no BCC at all, and the per-template suppression flag is gone with it. Executed
  // end to end in tests/offer-email-via-turbify.test.ts.
  const send = stripComments(readFileSync("src/lib/email/send-phoenix-email.ts", "utf8"));
  assert.doesNotMatch(send, /ADMIN_STANDING_EMAIL/, "no automated email — the reset code included — is blind-copied to the admin mailbox");
  assert.doesNotMatch(
    stripComments(service),
    /suppressAdminStandingBcc/,
    "the templated path no longer needs a suppression flag, because there is no standing copy to suppress",
  );
}
