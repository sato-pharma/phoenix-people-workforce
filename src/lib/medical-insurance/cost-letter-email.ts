// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MEDICAL COVER STATEMENT AS AN EMAIL (owner, 2026-11-21: "add a button beside everyone … to send him
// email … and make an option to multiple select and send", then "it doesn't have to be sent as an email
// attachment … send it as an email with no attachment, but add all details in it").
//
// The email IS the statement: the same figures as the PDF (`buildCostLetter`), laid out in the house
// letter the Sato Email Composer sends (`renderSatoEmail`, SATO-DIS-2026-01) — his grade, what he and each
// family member cost him a month, the total, his grade at a glance and his whole table of benefits. No file
// is attached.
//
// 🔴 THE SAME TWO RULES AS THE PAPER: amounts only, never the split's percentages; and a statement that
// cannot be priced to the piastre is not sent (`CostLetterError` becomes that person's "not sent" line).
//
// 🔴 ONE PERSON, ONE EMAIL, TO THAT PERSON'S OWN WORK EMAIL ON THE EMPLOYEE MASTER. Never a family member,
// never a fan-out: each statement names one employee's money and is addressed to that employee alone.
// Someone with no work email on file is reported, never guessed at.
//
// THE CC IS THE SUPER ADMIN'S CHOICE, MADE ON EVERY SEND (owner, 2026-11-21: "add a CC option", then "Both",
// "Visible CC"). Two parts, both off unless he sets them on the confirm panel: a tick that copies EACH
// employee's own direct manager (the Employee Master's manager, never anyone else's), and a box of extra
// addresses that go on every email in that send. A visible CC, never BCC. The addresses he typed are declared
// as intended outside recipients, because he typed them; the manager's comes from the Employee Master. Every automated email is also mirrored
// to the owner's Telegram by sendPhoenixEmail itself; nothing here turns that off.
//
// PURE apart from the `send` it is handed, so the tests drive it with a fake and nothing real is sent.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

import { systemLegalEntity } from "@/config/system-settings";
import type { SendPhoenixEmailInput, SendPhoenixEmailResult } from "@/lib/email/send-phoenix-email";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { renderSatoEmail } from "@/lib/sato-email/render";

import { LIBANO_TABLE_OF_BENEFITS, type BenefitText } from "./benefits";
import { buildCostLetter, CostLetterError, costLetterMoney, type CostLetter, type CostLetterPolicy } from "./cost-letter";
import type { MedicalInsuranceMemberType } from "./cost";
import type { MonthlySplitRow } from "./monthly-split";

/** How many statements one press may send. The screen sends a longer selection in batches of this size. */
export const COST_LETTER_EMAIL_BATCH = 20;

export const COST_LETTER_EMAIL_EVENT = "medical_cover_statement";

const RELATION_WORDS: Record<MedicalInsuranceMemberType, string> = { child: "Child", employee: "You", spouse: "Spouse" };

function longDay(key: string): string {
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC", year: "numeric" }).format(date);
}

/** English, with the signed Arabic beneath it when the table writes it differently. */
function both(text: BenefitText, strong = false): string {
  const english = strong ? `<strong>${escapeHtml(text.en)}</strong>` : escapeHtml(text.en);
  if (text.ar.trim() === text.en.trim() || !/[؀-ۿ]/.test(text.ar)) return english;
  return `${english}<br><span dir="rtl" lang="ar" style="color:#5A6B7C">${escapeHtml(text.ar)}</span>`;
}

/** A section head in the house letter: `prepareSatoEmailBody` turns this exact paragraph into a ruled micro label. */
function head(words: string): string {
  return `<p style="font-size:18px;font-weight:bold">${escapeHtml(words)}</p>`;
}

export function costLetterEmailSubject(letter: Pick<CostLetter, "plan">): string {
  return `Your Medical Cover Statement · Grade ${letter.plan}`;
}

/** The statement as the house letter: every figure the PDF prints, and the whole table of benefits. */
export function renderCostLetterEmail(letter: CostLetter, preparedOn: string): { subject: string; html: string; text: string } {
  const benefits = LIBANO_TABLE_OF_BENEFITS[letter.plan];
  const hasFamily = letter.people.length > 1;
  const firstName = letter.employeeName.trim().split(/\s+/)[0] || letter.employeeName;
  const policyWords = letter.policy.policyNumber ? `Policy ${escapeHtml(letter.policy.policyNumber)}` : "Group policy";

  const summary = [
    ["Your grade", `Grade ${letter.plan}`],
    ["You, a month", costLetterMoney(letter.own)],
    ...(hasFamily ? [["Your family, a month", costLetterMoney(letter.family)]] : []),
    ["Total you pay each month", costLetterMoney(letter.total)],
  ]
    .map(([label, value], index, all) => {
      const last = index === all.length - 1;
      return `<tr><td><strong>${escapeHtml(label)}</strong></td><td style="text-align:right;white-space:nowrap">${last ? `<strong>${escapeHtml(value)}</strong>` : escapeHtml(value)}</td></tr>`;
    })
    .join("");

  const people = letter.people
    .map((person) => {
      const from = person.startsOn ? `<br><span style="color:#5A6B7C">Cover from ${escapeHtml(longDay(person.startsOn))}</span>` : "";
      // Four columns, not the paper's six: a phone is 375px wide, and the medical and life parts read under the name.
      const parts = `<br><span style="color:#5A6B7C">Medical cover ${costLetterMoney(person.medical)} · Life insurance ${costLetterMoney(person.life)}</span>`;
      return (
        `<tr><td><strong>${escapeHtml(person.name)}</strong>${parts}${from}</td><td>${RELATION_WORDS[person.memberType]}</td>` +
        `<td style="text-align:center">${person.plan}</td><td style="text-align:right;white-space:nowrap"><strong>${costLetterMoney(person.monthly)}</strong></td></tr>`
      );
    })
    .join("");

  const facts = benefits.facts.map((fact) => `<tr><td><strong>${escapeHtml(fact.label.en)}</strong></td><td>${both(fact.value)}</td></tr>`).join("");

  const sections = benefits.sections
    .map(
      (section) =>
        head(section.title.en) +
        "<table><thead><tr><th>Benefit</th><th>Cover</th><th>Co-payment</th></tr></thead><tbody>" +
        section.lines
          .map((line) => {
            const name = both(line.benefit, true) + (line.part ? `<br>${both(line.part)}` : "");
            return `<tr><td>${name}</td><td>${both(line.coverage)}</td><td style="text-align:center">${line.memberShare ? escapeHtml(line.memberShare) : "&mdash;"}</td></tr>`;
          })
          .join("") +
        "</tbody></table>",
    )
    .join("");

  const bodyHtml =
    `<p>Dear ${escapeHtml(firstName)},</p>` +
    `<p>You are covered under ${escapeHtml(systemLegalEntity.legalNameEn)}'s group medical policy with ${escapeHtml(letter.policy.insurer)}. ` +
    `This is your Medical Cover Statement, prepared on ${escapeHtml(preparedOn)}: your grade, the amount you pay each month${hasFamily ? " for you and your family" : ""}, and the benefits your grade gives you.</p>` +
    head("Your monthly cost") +
    `<table><tbody>${summary}</tbody></table>` +
    head("What you pay each month") +
    "<table><thead><tr><th>Covered</th><th>As</th><th>Grade</th><th>A month</th></tr></thead>" +
    `<tbody>${people}<tr><td colspan="3"><strong>Total you pay each month</strong></td><td style="text-align:right;white-space:nowrap"><strong>${costLetterMoney(letter.total)}</strong></td></tr></tbody></table>` +
    head(`Grade ${letter.plan} at a glance`) +
    `<table><tbody>${facts}</tbody></table>` +
    head(`Table of Benefits · Grade ${letter.plan}`) +
    sections +
    `<p><strong>${policyWords}</strong> with ${escapeHtml(letter.policy.insurer)}, from ${escapeHtml(longDay(letter.policy.startsOn))} to ${escapeHtml(longDay(letter.policy.endsOn))}.</p>` +
    "<p>Questions about your cover or this statement go to Human Resources at Head Office.</p>";

  const subject = costLetterEmailSubject(letter);
  const rendered = renderSatoEmail({
    bodyHtml,
    footnote: "This statement was sent to you personally by Sato Pharma Human Resources.",
    kicker: "Medical Cover Statement",
    signOff: "Human Resources",
    subject,
  });
  return { html: rendered.html, subject, text: rendered.text };
}

export type CostLetterEmailOutcome = {
  memberId: string;
  name: string;
  email: string | null;
  /** Who was copied on this employee's email. */
  cc: string[];
  status: "sent" | "not_sent";
  reason: string | null;
  /** Something the Super Admin should know about a SENT email, e.g. the manager could not be copied. */
  note: string | null;
};

export type CostLetterEmailInput = {
  memberIds: readonly string[];
  rows: readonly MonthlySplitRow[];
  policy: CostLetterPolicy;
  /** Work email by HR id, from the Employee Master. */
  workEmails: ReadonlyMap<string, string | null>;
  /** Direct manager's HR id by employee HR id, from the Employee Master. */
  managers: ReadonlyMap<string, string | null>;
  /** Copy each employee's own direct manager. */
  ccManager: boolean;
  /** Extra addresses copied on every email in this send, already cleaned by `cleanCostLetterCc`. */
  cc: readonly string[];
  preparedOn: string;
  from: string;
  replyTo: string;
  /** The minute this press happened in: a double press is one email, a deliberate resend later is another. */
  minute: number;
  send: (input: SendPhoenixEmailInput) => Promise<SendPhoenixEmailResult>;
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** At most this many extra addresses in the CC box. */
export const COST_LETTER_CC_MAX = 10;

/** The CC box, cleaned: lower-cased, no repeats, every one a real address; a bad one is refused by name. */
export function cleanCostLetterCc(raw: unknown): string[] {
  const parts = (Array.isArray(raw) ? raw.map((item) => String(item ?? "")) : String(raw ?? "").split(/[\s,;]+/))
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(parts)];
  const bad = unique.filter((address) => !EMAIL_SHAPE.test(address));
  if (bad.length > 0) throw new CostLetterError(`${bad.join(", ")} ${bad.length === 1 ? "is not an email address" : "are not email addresses"}, so nothing was sent.`);
  if (unique.length > COST_LETTER_CC_MAX) throw new CostLetterError(`CC at most ${COST_LETTER_CC_MAX} addresses.`);
  return unique;
}

/** Sends each chosen employee their own statement, one email each, and says what happened to every one. */
export async function sendCostLetterEmails(input: CostLetterEmailInput): Promise<CostLetterEmailOutcome[]> {
  const outcomes: CostLetterEmailOutcome[] = [];
  const seen = new Set<string>();
  for (const rawId of input.memberIds) {
    const memberId = String(rawId ?? "").trim();
    if (!memberId || seen.has(memberId)) continue;
    seen.add(memberId);

    const row = input.rows.find((candidate) => candidate.employee?.memberId === memberId);
    if (!row?.employee) {
      outcomes.push({ cc: [], email: null, memberId, name: "This person", note: null, reason: "Not covered on the policy today, so there is no monthly cost to send.", status: "not_sent" });
      continue;
    }
    const name = row.employee.name;
    const email = (row.hrId ? input.workEmails.get(row.hrId) ?? "" : "").trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) {
      outcomes.push({ cc: [], email: null, memberId, name, note: null, reason: "No work email on the Employee Master.", status: "not_sent" });
      continue;
    }

    let letter: CostLetter;
    try {
      letter = buildCostLetter(row, input.policy);
    } catch (error) {
      if (!(error instanceof CostLetterError)) throw error;
      outcomes.push({ cc: [], email, memberId, name, note: null, reason: error.message, status: "not_sent" });
      continue;
    }

    // The manager first, then the typed addresses; never the employee himself twice.
    let note: string | null = null;
    const managerHrId = input.ccManager && row.hrId ? input.managers.get(row.hrId) ?? null : null;
    const managerEmail = managerHrId ? (input.workEmails.get(managerHrId) ?? "").trim().toLowerCase() : "";
    if (input.ccManager && !EMAIL_SHAPE.test(managerEmail)) {
      note = managerHrId ? "Their manager has no work email on the Employee Master, so the manager was not copied." : "No direct manager on the Employee Master, so no manager was copied.";
    }
    const cc = [...new Set([...(EMAIL_SHAPE.test(managerEmail) ? [managerEmail] : []), ...input.cc])].filter((address) => address !== email);
    const typed = input.cc.filter((address) => cc.includes(address) && address !== managerEmail);

    const rendered = renderCostLetterEmail(letter, input.preparedOn);
    const key = createHash("sha256").update(`${memberId}|${email}|${cc.join(",")}|${Math.round(letter.total * 100)}|${input.minute}`).digest("hex").slice(0, 40);
    try {
      const result = await input.send({
        ...(cc.length > 0 ? { cc } : {}),
        // Only what the Super Admin typed himself; the employee and the manager come from the Employee Master.
        ...(typed.length > 0 ? { externalRecipients: typed } : {}),
        from: input.from,
        html: rendered.html,
        idempotencyKey: `${COST_LETTER_EMAIL_EVENT}:${key}`,
        notificationType: COST_LETTER_EMAIL_EVENT,
        origin: { employeeHrId: row.hrId, eventType: COST_LETTER_EMAIL_EVENT, module: "medical_insurance", recipientHrId: row.hrId },
        replyTo: input.replyTo,
        subject: rendered.subject,
        text: rendered.text,
        to: [email],
      });
      outcomes.push(result.skipped ? { cc, email, memberId, name, note: null, reason: result.reason, status: "not_sent" } : { cc, email, memberId, name, note, reason: null, status: "sent" });
    } catch (error) {
      outcomes.push({ cc, email, memberId, name, note: null, reason: (error instanceof Error ? error.message : String(error)).slice(0, 300), status: "not_sent" });
    }
  }
  return outcomes;
}
