// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ADDITIONS AND DELETIONS EMAIL TO LIBANO-SUISSE (owner, 27 Nov 2026: "instead of taking the Excel
// sheet you make for additions and deletions and sending it by hand, we make a Send button").
//
// One press sends the ticked people's Additions or Deletions workbook — the very file the Export button
// builds — to the insurer, the way the owner has always sent it by hand:
//   * To the insurer's policy administration (Policy.Admin@Libano-suisse-takaful.com).
//   * CC the account manager (Ahmed Elshazly) and the owner's own mailbox, so he holds a copy and sees
//     the insurer's "Deletion done" reply in the thread.
//   * Subject "Addition 27/11/2026" or "Deletion 27/11/2026" — the kind, then the day, in Cairo.
//
// 🔴 IT GOES OUT AS PHOENIX, ON THE OWNER'S BEHALF, AND SAYS SO. The mail server is cleared only for
// send.satopharma.com: a From of omar.anwar@satopharma.com would be refused or filed as spam (owner chose
// "Phoenix, replies to me" and "put omar.anwar@satopharma.com in the CC"). The From reads "Omar Gawish via
// Phoenix Workforce", the Reply-To is his mailbox, and the letter says it is an automated email from the
// system. The recipients are fixed here and never typed on the page.
//
// PURE apart from the `send` it is handed, so the tests drive it with a fake and nothing real is sent.
// The read and the workbook are sendLibanoMovementEmail in ./service.ts.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { renderSatoEmail } from "@/lib/sato-email/render";

import {
  LIBANO_ACCOUNT_MANAGER_EMAIL,
  LIBANO_EMAIL_OWNER_COPY,
  LIBANO_MOVEMENT_EMAIL_CC,
  LIBANO_MOVEMENT_EMAIL_TO,
  LIBANO_MOVEMENT_TEST_TO,
  LIBANO_POLICY_ADMIN_EMAIL,
} from "./libano-movement-recipients";
import { MEMBER_TYPE_WORDS } from "./view";
import type { LibanoMemberLine } from "./workbooks";

export { LIBANO_ACCOUNT_MANAGER_EMAIL, LIBANO_EMAIL_OWNER_COPY, LIBANO_POLICY_ADMIN_EMAIL };

/** The person the email is sent for, as the From's display name says it. */
export const LIBANO_EMAIL_SENDER_NAME = "Omar Gawish";

export const LIBANO_MOVEMENT_EMAIL_EVENT = "medical_insurance_libano_movement_email";

export type LibanoMovementEmailKind = "additions" | "deletions";

const SUBJECT_WORD: Record<LibanoMovementEmailKind, string> = { additions: "Addition", deletions: "Deletion" };

/** "27/11/2026": the day, in Cairo, as the owner writes it in the subject. */
export function libanoEmailDay(atIso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).formatToParts(new Date(atIso));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")}`;
}

/** "Addition 27/11/2026" or "Deletion 27/11/2026". */
export function libanoMovementSubject(kind: LibanoMovementEmailKind, atIso: string): string {
  return `${SUBJECT_WORD[kind]} ${libanoEmailDay(atIso)}`;
}

/** "Omar Gawish via Phoenix Workforce <phoenix@send.satopharma.com>": the system's own cleared address, named for him. */
export function libanoMovementFrom(systemAddress: string): string {
  const match = systemAddress.match(/<([^>]+)>/);
  const address = (match ? match[1] : systemAddress).trim();
  return `${LIBANO_EMAIL_SENDER_NAME} via Phoenix Workforce <${address}>`;
}

export function buildLibanoMovementEmail(input: {
  atIso: string;
  fileName: string;
  kind: LibanoMovementEmailKind;
  policyNumber: string | null;
  rows: readonly LibanoMemberLine[];
  /** A TEST send: the same email, marked as a test, to the owner alone. */
  test?: boolean;
}): { html: string; subject: string; text: string } {
  const subject = `${input.test ? "TEST - " : ""}${libanoMovementSubject(input.kind, input.atIso)}`;
  const count = input.rows.length;
  const people = count === 1 ? "1 person" : `${count} people`;
  const policy = input.policyNumber ? `policy ${escapeHtml(input.policyNumber)}` : "our group medical policy";
  const what = input.kind === "additions" ? `add ${people} to` : `delete ${people} from`;
  const list = input.rows
    .map((row) => `<li>${escapeHtml(row.fullName)} (${MEMBER_TYPE_WORDS[row.memberType]}${input.kind === "additions" ? `, plan ${row.category}` : ""})</li>`)
    .join("");

  const testBanner = input.test
    ? `<p><strong>TEST SEND. This went to you alone, not to Libano-Suisse.</strong> Open the attached file and check it. When it is right, press Send to Libano-Suisse on the Medical Insurance page. The email below is exactly what they will receive.</p>`
    : "";
  const bodyHtml =
    testBanner +
    `<p>Dear Libano-Suisse team,</p>` +
    `<p>Please ${what} Sato Pharma's ${policy}. They are on the attached ${input.kind === "additions" ? "Additions" : "Deletions"} sheet, <strong>${escapeHtml(input.fileName)}</strong>, on your own workbook:</p>` +
    `<ul>${list}</ul>` +
    `<p>Please reply to confirm once it is done.</p>` +
    `<p><em>This is an automated email from Phoenix Workforce, Sato Pharma's HR system, sent on behalf of ${LIBANO_EMAIL_SENDER_NAME}, HR Manager. Replies go straight to the HR Manager.</em></p>`;

  const rendered = renderSatoEmail({
    bodyHtml,
    footnote: `Sent automatically from Phoenix Workforce on behalf of ${LIBANO_EMAIL_SENDER_NAME}, Sato Pharma Human Resources.`,
    kicker: input.kind === "additions" ? "Medical insurance additions" : "Medical insurance deletions",
    signOff: `${LIBANO_EMAIL_SENDER_NAME}, HR Manager, Sato Pharma`,
    subject,
  });
  return { html: rendered.html, subject, text: rendered.text };
}

/** The recipients, fixed: never typed on the page. A test goes to the owner alone, with no copies. */
export function libanoMovementRecipients(test = false): { cc: string[]; external: string[]; replyTo: string; to: string[] } {
  if (test) return { cc: [], external: [...LIBANO_MOVEMENT_TEST_TO], replyTo: LIBANO_EMAIL_OWNER_COPY, to: [...LIBANO_MOVEMENT_TEST_TO] };
  return {
    cc: [...LIBANO_MOVEMENT_EMAIL_CC],
    // The insurer belongs to nobody in the employee directory, so the Recipient Assurance Guard is told so.
    external: [LIBANO_POLICY_ADMIN_EMAIL, LIBANO_ACCOUNT_MANAGER_EMAIL, LIBANO_EMAIL_OWNER_COPY],
    replyTo: LIBANO_EMAIL_OWNER_COPY,
    to: [...LIBANO_MOVEMENT_EMAIL_TO],
  };
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The whole email, ready for the durable outbox: who, what, the workbook attached, and the key that stops a
 * double press sending it twice. The same people, the same kind, the same Cairo day → the same key, so the
 * outbox answers the second press with the first one's result instead of a second email to the insurer.
 */
export function planLibanoMovementEmail(input: {
  atIso: string;
  fileName: string;
  kind: LibanoMovementEmailKind;
  policyNumber: string | null;
  rows: readonly LibanoMemberLine[];
  systemFromAddress: string;
  /** A TEST send (see buildLibanoMovementEmail). */
  test?: boolean;
  workbook: Uint8Array;
}): {
  dedupeKey: string;
  input: {
    attachments: Array<{ content: string; contentType: string; filename: string }>;
    cc: string[];
    externalRecipients: string[];
    from: string;
    html: string;
    idempotencyKey: string;
    origin: { eventType: string; module: string; notificationType: string };
    replyTo: string;
    subject: string;
    text: string;
    to: string[];
  };
} {
  if (input.rows.length === 0) throw new Error("Nobody is on the file, so there is nothing to send.");
  const email = buildLibanoMovementEmail(input);
  const recipients = libanoMovementRecipients(input.test === true);
  const people = input.rows.map((row) => `${row.memberType}:${row.staffNumber ?? ""}:${row.fullName}`).sort().join("|");
  const digest = createHash("sha256").update(people).digest("hex").slice(0, 32);
  // A test may be pressed again and again while the file is checked, so its key carries the minute; the real
  // send's key is the Cairo day, so a double press never reaches the insurer twice.
  const dedupeKey = input.test
    ? `medical-insurance:libano-test-${input.kind}:${Math.floor(new Date(input.atIso).getTime() / 60_000)}:${digest}`
    : `medical-insurance:libano-${input.kind}:${libanoEmailDay(input.atIso)}:${digest}`;
  return {
    dedupeKey,
    input: {
      attachments: [{ content: Buffer.from(input.workbook).toString("base64"), contentType: XLSX_TYPE, filename: input.fileName }],
      cc: recipients.cc,
      externalRecipients: recipients.external,
      from: libanoMovementFrom(input.systemFromAddress),
      html: email.html,
      idempotencyKey: dedupeKey,
      origin: { eventType: LIBANO_MOVEMENT_EMAIL_EVENT, module: "medical_insurance", notificationType: LIBANO_MOVEMENT_EMAIL_EVENT },
      replyTo: recipients.replyTo,
      subject: email.subject,
      text: email.text,
      to: recipients.to,
    },
  };
}
