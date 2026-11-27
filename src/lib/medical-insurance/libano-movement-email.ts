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

import { systemDeployment } from "@/config/system-settings";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";

import { renderLibanoMovementLetter } from "./libano-movement-letter";

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

/** The insurer, as the signed broker letter names it. */
export const LIBANO_INSURER_NAME = "Libano-Suisse Takaful Egypt";

/** The production site the letter's two marks are read from (a mail client needs an absolute address). */
function letterAssetBase(): string {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || systemDeployment.productionUrl;
  return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
}

function cairoDate(iso: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", ...options }).format(new Date(iso));
}

/** "30 Nov 2026" for a plain calendar day ("2026-11-30"), read as that day and never shifted by a time zone. */
function plainDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" }).format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))),
  );
}

/**
 * The letter itself, in the signed Beyond authorisation's gold identity (./libano-movement-letter.ts): the
 * kicker, the two-weight title, the facts, the figures, the people, and the HR Manager's sign-off block.
 */
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
  const additions = input.kind === "additions";
  const count = input.rows.length;
  const people = count === 1 ? "1 person" : `${count} people`;
  const policyWords = input.policyNumber ? `policy ${input.policyNumber}` : "our group medical policy";
  const what = additions ? `add ${people} to` : `delete ${people} from`;
  const sheet = additions ? "Additions" : "Deletions";
  const dayWord = additions ? "Cover starts" : "Last covered day";
  const longDate = cairoDate(input.atIso, { day: "numeric", month: "long", year: "numeric" });
  const automatedNote = `This is an automated email from Phoenix Workforce, Sato Pharma's HR system, sent on behalf of ${LIBANO_EMAIL_SENDER_NAME}, HR Manager. Replies go straight to the HR Manager.`;
  const signer = { line: "Sato Pharma · Human Resources", name: "Omar Anwar Gawish", replyTo: LIBANO_EMAIL_OWNER_COPY, title: "HR Manager, Human Resources" };

  const testNoticeHtml = input.test
    ? `<b>TEST SEND. This went to you alone, not to Libano-Suisse.</b> Open the attached file and check it. When it is right, press Send to Libano-Suisse on the Medical Insurance page. The email below is exactly what they will receive.`
    : null;

  const rows = input.rows.map((row) => [
    escapeHtml(row.fullName),
    escapeHtml(MEMBER_TYPE_WORDS[row.memberType]),
    ...(additions ? [escapeHtml(row.category)] : []),
    escapeHtml(plainDay(row.day)),
  ]);

  const textLines = [
    ...(input.test ? ["TEST SEND. This went to you alone, not to Libano-Suisse. Open the attached file and check it first.", ""] : []),
    `Medical insurance ${sheet.toLowerCase()}`,
    `${longDate} · ${people} · ${input.policyNumber ? `Policy ${input.policyNumber}` : "Group medical policy"}`,
    "",
    "Dear Libano-Suisse team,",
    "",
    `Please ${what} Sato Pharma's ${policyWords}. They are on the attached ${sheet} sheet, ${input.fileName}, on your own workbook:`,
    "",
    ...input.rows.map((row) => `- ${row.fullName} (${MEMBER_TYPE_WORDS[row.memberType]}${additions ? `, plan ${row.category}` : ""}), ${dayWord.toLowerCase()} ${plainDay(row.day)}`),
    "",
    "Please reply to confirm once it is done.",
    "",
    "For Sato Pharma",
    signer.name,
    signer.title,
    `Replies: ${signer.replyTo}`,
    "",
    automatedNote,
  ];

  const rendered = renderLibanoMovementLetter({
    assetBaseUrl: letterAssetBase(),
    automatedNote,
    closing: "Please reply to confirm once it is done.",
    facts: [
      { label: "Issued by", value: "Human Resources, Sato Pharma" },
      { label: "To", value: `${LIBANO_INSURER_NAME}, policy administration` },
      { label: "Date", value: longDate },
    ],
    figures: [
      { label: "Date", note: cairoDate(input.atIso, { month: "short", year: "numeric" }), value: cairoDate(input.atIso, { day: "2-digit" }) },
      { label: "People", value: String(count) },
      { label: "Policy number", strong: true, value: input.policyNumber ?? "Group policy" },
    ],
    kicker: "Medical and life insurance",
    law: `${sheet} to Sato Pharma's group medical policy with ${LIBANO_INSURER_NAME}`,
    paragraphsHtml: [
      `Please ${escapeHtml(what)} Sato Pharma's ${escapeHtml(policyWords)}. They are on the attached ${sheet} sheet, <b>${escapeHtml(input.fileName)}</b>, on your own workbook.`,
    ],
    placeLine: `Head Office · Cairo · ${cairoDate(input.atIso, { month: "long", year: "numeric" })}`,
    purpose: `The people below are on the attached sheet, one row each, in ${LIBANO_INSURER_NAME}'s own layout.`,
    salutation: "Dear Libano-Suisse team,",
    signer,
    subject,
    table: { head: ["Name", "Member", ...(additions ? ["Plan"] : []), dayWord], rows },
    testNoticeHtml,
    text: textLines.join("\n"),
    titleBold: additions ? "additions" : "deletions",
    titleLight: "Medical insurance",
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
  workbook: ArrayBuffer | Uint8Array;
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
      attachments: [{ content: Buffer.from(new Uint8Array(input.workbook)).toString("base64"), contentType: XLSX_TYPE, filename: input.fileName }],
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
