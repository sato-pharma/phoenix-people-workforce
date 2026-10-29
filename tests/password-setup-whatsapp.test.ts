import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseBulkPasswordSetupRequest, parsePasswordSetupRequest } from "../src/lib/admin/access-validation.ts";
import {
  composePasswordSetupWhatsAppMessage,
  passwordSetupExpiryLabel,
  passwordSetupWhatsAppUrl,
} from "../src/lib/auth/password-setup-whatsapp.ts";
import { toWhatsAppNumber } from "../src/lib/reports/organogram-whatsapp.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Sending the password setup/reset link over WhatsApp — the owner's ask, 29 October 2026, because an
 * employee who has never signed in reads WhatsApp long before he reads a mailbox he cannot open yet.
 *
 * WHAT THIS PINS, and none of it is a formatting preference:
 *
 *   1. 🔴 THE CHAT URL CARRIES THE PERSON'S OWN NUMBER. The CRM forecast share sheet deliberately uses
 *      `wa.me/?text=` so the rep lands on WhatsApp's PICKER and can choose a group. The opposite is
 *      required here: a setup link sets ONE person's password, and a picker invites the admin to hand a
 *      live credential to whichever chat he taps. A number falling OUT of this URL is the defect.
 *   2. 🔴 THE NUMBER IS RESOLVED BEFORE THE TOKEN IS MINTED. Every delivery mode invalidates the
 *      person's outstanding tokens, bumps `session_version` and sets `force_password_reset`. Refusing
 *      after that point would sign someone out in order to produce an error message.
 *   3. 🔴 THE EXPIRY IS CAIRO, assembled from numeric parts with our own month names — a locale-formatted
 *      whole string moves with the engine's ICU build, which is the standing trap here. The Cairo OFFSET
 *      still comes from Intl, never a hand-written +2, because Egypt observes DST again.
 *   4. 🔴 BULK STAYS copy/email. `wa.me` opens exactly one chat, so a batch would be a queue of tabs.
 *   5. 🔴 A REAL ANCHOR, never a scripted `window.open` after an await — a popup blocker swallows that,
 *      and the admin would be told the message was prepared with nothing on screen.
 */
export function runPasswordSetupWhatsAppTests() {
  // ── The expiry label ────────────────────────────────────────────────────────────────────
  // Winter: Cairo is UTC+2, so 17:45Z is a quarter to eight in the evening.
  assert.equal(
    passwordSetupExpiryLabel("2026-10-31T17:45:00.000Z"),
    "31 October 2026, 7:45 PM (Cairo)",
    "the expiry reads in Cairo local time, with the month spelled from our own table",
  );
  // Summer: Egypt observes DST, so the SAME UTC clock time is +3. This is why the offset comes from
  // Intl and is never written as a constant.
  assert.equal(
    passwordSetupExpiryLabel("2026-07-15T17:45:00.000Z"),
    "15 July 2026, 8:45 PM (Cairo)",
    "Cairo's summer offset is +3 — a hand-rolled +2 would print an hour early for half the year",
  );
  assert.equal(
    passwordSetupExpiryLabel("not a date"),
    "not a date",
    "an unreadable expiry is passed through, never printed to the recipient as Invalid Date",
  );

  // ── The message ─────────────────────────────────────────────────────────────────────────
  const setupUrl = "https://phoenix-hr.satopharma.com/password-setup/abc123";
  const message = composePasswordSetupWhatsAppMessage({
    expiresAt: "2026-10-31T17:45:00.000Z",
    loginId: "AI-0030",
    name: "Mohamed Saad",
    purpose: "setup",
    setupUrl,
  });

  assert.equal(
    message,
    [
      "Dear Mohamed Saad,",
      "",
      "Your Phoenix Workforce account is ready. Open this link to set your password:",
      setupUrl,
      "",
      "Your login ID is AI-0030.",
      "The link can be used once, and it works until 31 October 2026, 7:45 PM (Cairo).",
    ].join("\n"),
    "the whole message, exactly: greeting by NAME, the link alone on its own line, the login id, the Cairo expiry",
  );
  assert.doesNotMatch(message, /…|\.\.\./u, "no ellipsis anywhere (house rule) — a truncated link is a dead link");

  const reset = composePasswordSetupWhatsAppMessage({
    expiresAt: "2026-10-31T17:45:00.000Z",
    loginId: "B-10",
    name: "Omar Gawish",
    purpose: "reset",
    setupUrl,
  });
  assert.match(
    reset,
    /reset your Phoenix Workforce password/,
    "a reset says reset — telling someone who already has an account that it is 'ready' reads as a second account",
  );
  assert.doesNotMatch(reset, /account is ready/, "the setup wording never leaks into a reset");

  // A person whose auth record carries no name is still addressed by something, never "Dear ,".
  assert.match(
    composePasswordSetupWhatsAppMessage({
      expiresAt: "2026-10-31T17:45:00.000Z",
      loginId: "OF-0004",
      name: "   ",
      purpose: "setup",
      setupUrl,
    }),
    /^Dear OF-0004,/,
    "a blank name falls back to the login id rather than greeting nobody",
  );

  // ── The chat URL ────────────────────────────────────────────────────────────────────────
  // The stored shape most register rows actually hold: the leading zero lost to a spreadsheet import.
  // The repair is the organogram's one implementation, not a second copy of the Egyptian prefix rules.
  const repaired = toWhatsAppNumber("1012345678");
  assert.equal(
    repaired,
    "201012345678",
    "the stored 10-digit mobile is repaired to its international form before it ever reaches a URL",
  );

  const chatUrl = passwordSetupWhatsAppUrl(repaired ?? "", message);
  assert.match(
    chatUrl,
    /^https:\/\/wa\.me\/201012345678\?text=/u,
    "🔴 the chat opens on THAT person's number — never wa.me/?text=, which is the group picker",
  );
  assert.doesNotMatch(
    chatUrl,
    /^https:\/\/wa\.me\/\?/u,
    "🔴 the picker form would invite the admin to send a live credential to whichever chat he taps",
  );
  assert.equal(
    decodeURIComponent(chatUrl.slice(chatUrl.indexOf("?text=") + "?text=".length)),
    message,
    "the message survives the URL intact — an unencoded newline or & truncates it inside WhatsApp",
  );
  // 🔴 THE ROUND TRIP ALONE DOES NOT PROVE THE ENCODING, and that is measured, not theoretical: with
  // encodeURIComponent removed, literal newlines sit in the URL and decodeURIComponent hands them
  // straight back, so the assertion above passed on a URL a browser would cut at the first line break.
  assert.doesNotMatch(
    chatUrl,
    /[\n\r ]/u,
    "the URL carries no raw newline or space — a browser cuts the query there and the message arrives in pieces",
  );
  assert.match(chatUrl, /%0A/u, "the line breaks are percent-encoded, which is what keeps the message whole");

  // ── The validators ──────────────────────────────────────────────────────────────────────
  // Caught rather than left to throw, so a parser that refuses the mode again names the RULE in the
  // run output instead of printing a bare ApiError stack.
  let singleDeliveryMode: string;
  try {
    singleDeliveryMode = parsePasswordSetupRequest({ deliveryMode: "whatsapp", loginId: "AI-0030", purpose: "setup" }).deliveryMode;
  } catch (error) {
    throw new Error(`the single-user setup-link route must accept the WhatsApp mode: ${(error as Error).message}`);
  }
  assert.equal(singleDeliveryMode, "whatsapp", "the single-user setup-link route must accept the WhatsApp mode");
  assert.throws(
    () => parsePasswordSetupRequest({ deliveryMode: "sms", loginId: "AI-0030" }),
    /deliveryMode must be 'copy', 'email' or 'whatsapp'\./,
    "delivery stays strictly enumerated — a third channel is a code change, never a payload",
  );
  assert.throws(
    () => parseBulkPasswordSetupRequest({ deliveryMode: "whatsapp", loginIds: ["AI-0030", "PD-0031"] }),
    /deliveryMode must be 'copy' or 'email'\./,
    "🔴 bulk refuses WhatsApp: wa.me opens ONE chat, so a batch would be a queue of tabs to press in turn",
  );

  // ── The service ─────────────────────────────────────────────────────────────────────────
  const service = stripComments(readFileSync("src/lib/auth/password-setup.ts", "utf8"));
  const resolvedAt = service.indexOf("await resolveWhatsAppNumber(user)");
  const mintedAt = service.indexOf("const token = createToken()");
  assert.ok(resolvedAt > 0, "the number resolution must still be in the service");
  assert.ok(mintedAt > 0, "the token mint must still be in the service");
  assert.ok(
    resolvedAt < mintedAt,
    "🔴 the number is resolved BEFORE the token is minted — refusing afterwards would already have "
      + "invalidated the person's sessions and forced a reset, to show him an error",
  );
  assert.match(
    service,
    /\.select\("mobile_number"\)/,
    "the number comes from the employee register, the only place Phoenix holds it",
  );

  const auditStart = service.indexOf("await writeRequiredAuditLog({");
  const auditEnd = service.indexOf("});", auditStart);
  assert.ok(auditStart > 0 && auditEnd > auditStart, "the audit write must still be in the service");
  const auditBlock = service.slice(auditStart, auditEnd);
  assert.match(auditBlock, /sentToWhatsApp: whatsAppLocalNumber/, "the audit records which handset the link was prepared for");
  assert.match(auditBlock, /token: "\[redacted\]"/, "the audit never stores the token");
  assert.match(auditBlock, /url: "\[redacted\]"/, "the audit never stores the link");
  assert.doesNotMatch(
    auditBlock,
    /whatsAppUrl/,
    "🔴 the prepared chat URL carries the live link — it is handed to the admin and recorded nowhere",
  );

  // ── The screen ──────────────────────────────────────────────────────────────────────────
  const manager = stripComments(readFileSync("src/components/admin/access-control-manager.tsx", "utf8"));
  assert.match(manager, /user\.hasWhatsApp && \(/, "the button renders only when the register holds a reachable number");
  assert.match(
    manager,
    /sendSetupLink\(user, "whatsapp"\)/,
    "the press goes through the same governed send path as the email and copy buttons",
  );
  assert.match(manager, /href=\{setupLinkWhatsApp\.url\}/, "🔴 a real anchor carries the prepared chat");
  assert.doesNotMatch(
    manager,
    /window\.open/,
    "🔴 never a scripted window.open after an await — a popup blocker swallows it and the admin is told it was prepared",
  );
}
