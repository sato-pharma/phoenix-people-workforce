// Recruitment / ATS — who this is and how to reach them.
//
// Contact details are where the rule engine simply wins: measured over the 126 readable CVs in the
// careers inbox (2026-08-19) these rules find an email on 98% and an Egyptian mobile on 93% — and
// 7 of the 9 mobile misses are candidates who live abroad and print a foreign number, so among
// Egyptian applicants it is effectively 117/119. There is nothing for a language model to add to a
// regex that already reads an address exactly.
//
// The name is the one genuinely hard field in this file, and it is treated accordingly — see
// findFullName.

import { JOB_TITLE_KEYWORDS } from "@/lib/recruitment/rule-extraction/dictionaries";
import {
  containsPhrase,
  findEgyptianMobiles,
  findEmails,
  findLinkedInUrl,
  findNationalId,
} from "@/lib/recruitment/rule-extraction/patterns";
import { high, low } from "@/lib/recruitment/rule-extraction/result";
import type { CvSection } from "@/lib/recruitment/rule-extraction/sections";
import { classifyHeading, linesOfKinds } from "@/lib/recruitment/rule-extraction/sections";
import type { NormalizedCvText } from "@/lib/recruitment/rule-extraction/normalize";
import type { ExtractedField } from "@/lib/recruitment/cv-extraction-fields";

/** What the intake knows independently of the document — the covering email, essentially. */
export type CvRuleContext = {
  /** Display name on the email/WhatsApp the CV arrived on. */
  readonly senderName?: string | null;
  readonly senderEmail?: string | null;
  /** Subject line — in this inbox it is nearly always the job applied for. */
  readonly subject?: string | null;
  readonly coverMessage?: string | null;
};

// ---------------------------------------------------------------------------
// Name
// ---------------------------------------------------------------------------

const NAME_STOPWORDS: readonly string[] = [
  "curriculum vitae", "cv", "resume", "personal information", "contact", "profile",
  "objective", "summary", "address", "mobile", "phone", "email", "e-mail", "linkedin",
  "date of birth", "nationality", "السيرة الذاتية",
];

/**
 * Whether a line could be the candidate's printed name.
 *
 * A CV almost always opens with the name on its own line, so the test is structural rather than
 * lexical: two to five words, letters only, no contact punctuation, not a section heading, and not
 * a job title. The job-title exclusion is the one that matters — the second line of a modern CV is
 * "Human Resources Operations Specialist", which passes every other test easily.
 */
function looksLikeName(line: string): boolean {
  const trimmed = line.trim().replace(/^[•\-–—]\s*/, "");
  if (trimmed.length < 4 || trimmed.length > 45) return false;
  if (/[@\d_/\\|]/.test(trimmed)) return false;
  if (classifyHeading(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  if (NAME_STOPWORDS.some((word) => lower === word || lower.startsWith(`${word} `))) return false;
  if (JOB_TITLE_KEYWORDS.some((keyword) => containsPhrase(lower, keyword))) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  // Latin names must be alphabetic; Arabic names are matched by script instead.
  return words.every((word) => /^[A-Za-z][A-Za-z'.-]*$/.test(word) || /^[؀-ۿ]+$/.test(word));
}

/** Title-cases a name that was printed in block capitals, leaving mixed-case names alone. */
function tidyName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .split(" ")
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** The letters of a name, lowercased — for comparing "Hamdy Ahmed" against "hamdyahmedhamdy97". */
function nameFingerprint(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Does the email's local part corroborate this name? "hamdyahmedhamdy97@gmail.com" contains
 * "hamdy" and "ahmed", which is strong evidence the line above really was the name.
 */
function emailSupportsName(name: string, emails: readonly string[]): boolean {
  const parts = name.toLowerCase().split(/\s+/).filter((word) => /^[a-z]{3,}$/.test(word));
  if (parts.length === 0) return false;
  return emails.some((email) => {
    const local = nameFingerprint(email.slice(0, email.indexOf("@")));
    const matched = parts.filter((part) => local.includes(part)).length;
    // Two name parts inside the local part is conclusive. One is enough only when it is a long,
    // distinctive word — "abanoub" in "abanoubemadeskander" proves the line above was the name,
    // whereas "ali" inside "khalid.ali.mansour" would prove nothing about a line reading "Ali Hassan".
    if (matched >= 2) return true;
    return parts.some((part) => part.length >= 6 && local.includes(part));
  });
}

/**
 * Does the SENDER's display name corroborate this line?
 *
 * Weaker evidence than the email — a forwarded CV carries the forwarder's name — so it only ever
 * confirms a line the document already produced, and never supplies the name by itself.
 */
function senderSupportsName(name: string, senderName: string | null | undefined): boolean {
  if (!senderName) return false;
  const sender = nameFingerprint(senderName);
  if (sender.length < 5) return false;
  const parts = name.toLowerCase().split(/\s+/).filter((word) => /^[a-z]{3,}$/.test(word));
  return parts.filter((part) => sender.includes(part)).length >= 2;
}

/**
 * The candidate's own name.
 *
 * Order of preference, and the reason for it:
 *   1. A name-shaped line near the top of the document that the EMAIL corroborates — read from the
 *      CV and independently confirmed, so "high".
 *   2. The first name-shaped line in the header block — read from the CV but not confirmed, "low".
 *   3. The sender's display name — "low", and deliberately last.
 *
 * Step 3 is last because of a real, repeated failure in this system: a CV forwarded by a recruiter
 * or by the WhatsApp forwarder carries the FORWARDER's name, and candidates created that way ended
 * up named after the sender. The document's own name must always win when it exists.
 */
export function findFullName(
  normalized: NormalizedCvText,
  sections: readonly CvSection[],
  emails: readonly string[],
  context: CvRuleContext,
): ExtractedField<string> | null {
  // The header block, plus the first handful of lines overall as a safety net for a CV whose very
  // first line is already a recognised heading.
  const headerLines = linesOfKinds(sections, ["header", "contact", "personal"]).slice(0, 12);
  const candidates = [...new Set([...headerLines, ...normalized.lines.slice(0, 6)])].filter(looksLikeName);

  const corroborated = candidates.find(
    (line) => emailSupportsName(line, emails) || senderSupportsName(line, context.senderName),
  );
  if (corroborated) return high(tidyName(corroborated));

  if (candidates.length > 0) return low(tidyName(candidates[0]!));

  const sender = context.senderName?.trim();
  if (sender && looksLikeName(sender)) return low(tidyName(sender));
  return null;
}

// ---------------------------------------------------------------------------
// Contact details
// ---------------------------------------------------------------------------

/**
 * The candidate's email.
 *
 * When the CV states an address, that is the answer, at high confidence. When it states none, the
 * address the message ARRIVED from is offered at low confidence — better than nothing for a CV that
 * simply omits it, which is common.
 *
 * THE CALLER DECIDES WHETHER THAT FALLBACK IS SAFE, by passing senderEmail or not. This function
 * cannot make that judgement: it has no idea whether the message came from the candidate or from
 * somebody forwarding a stack of other people's CVs, and on a forward-import the sender address is
 * the same for every single document. Stamping it onto each one collapses the whole import into one
 * candidate — the WhatsApp forwarder incident. cv-intake-service.ts therefore passes senderEmail
 * only when the intake's identitySource is "sender", and passes null for a bulk import.
 *
 * An earlier version of this comment claimed the check for "one of the forwarding accounts the
 * intake already knows about" happened here. It never did, and no such list is reachable from this
 * module.
 */
export function findEmail(normalized: NormalizedCvText, context: CvRuleContext): {
  readonly field: ExtractedField<string> | null;
  readonly all: string[];
} {
  const emails = findEmails(normalized.text);
  if (emails.length > 0) return { all: emails, field: high(emails[0]!) };
  const sender = context.senderEmail?.trim().toLowerCase();
  return { all: [], field: sender ? low(sender) : null };
}

export function findPhone(normalized: NormalizedCvText): {
  readonly phone: ExtractedField<string> | null;
  readonly whatsapp: ExtractedField<string> | null;
} {
  const numbers = findEgyptianMobiles(normalized.text);
  if (numbers.length === 0) return { phone: null, whatsapp: null };

  // A number printed beside the word "whatsapp" is the WhatsApp number; otherwise the field stays
  // empty rather than assuming the mobile is on WhatsApp (it usually is, but "usually" is not a
  // fact about this candidate).
  let whatsapp: string | null = null;
  for (const line of normalized.lines) {
    if (!/whats\s?app|واتس/i.test(line)) continue;
    const onLine = findEgyptianMobiles(line);
    if (onLine.length > 0) {
      whatsapp = onLine[0]!;
      break;
    }
  }

  return {
    phone: high(numbers[0]!),
    whatsapp: whatsapp ? high(whatsapp) : null,
  };
}

export function findLinkedIn(normalized: NormalizedCvText): ExtractedField<string> | null {
  // Search the raw link annotations too: on 13% of CVs the profile exists only as a PDF hyperlink
  // behind an icon, with no visible URL anywhere in the text.
  const fromLinks = normalized.links.map((link) => link.url).join("\n");
  const url = findLinkedInUrl(`${normalized.text}\n${fromLinks}`);
  return url ? high(url) : null;
}

export function findNationalIdField(normalized: NormalizedCvText) {
  return findNationalId(normalized.text);
}

// ---------------------------------------------------------------------------
// What they applied for
// ---------------------------------------------------------------------------

/** Subject-line noise that is not part of a job title. */
const SUBJECT_NOISE = /^(re|fwd|fw|رد|إعادة توجيه)\s*[:،-]\s*/i;

/**
 * The role applied for, taken from the covering email's SUBJECT.
 *
 * This is the cheapest high-value field in the module and it does not come from the CV at all. In
 * this inbox the subject is the vacancy name 87% of the time ("Personnel & Recruitment Specialist",
 * "أخصائي شؤون أفراد و توظيف") because that is what the job ad tells applicants to write. Asking a
 * model to infer the same thing from the CV body is both slower and worse.
 */
export function findAppliedForJobTitle(context: CvRuleContext): {
  readonly title: ExtractedField<string> | null;
  readonly evidence: ExtractedField<string> | null;
} {
  const raw = context.subject?.trim();
  if (!raw) return { evidence: null, title: null };

  const cleaned = raw.replace(SUBJECT_NOISE, "").replace(/\s+/g, " ").trim();
  // A subject that is just a filename, a greeting or the word "CV" says nothing about the role.
  if (cleaned.length < 4 || cleaned.length > 90) return { evidence: null, title: null };
  if (/^(cv|resume|my cv|application|job application|السيرة الذاتية)$/i.test(cleaned)) {
    return { evidence: low(`Email subject: ${cleaned}`), title: null };
  }

  const withoutFiller = cleaned
    .replace(/^(application (for|to)|applying (for|to)|apply (for|to)|job application[:\s-]*|vacancy[:\s-]*|for the position of|position of|تقديم على|وظيفة)\s*/i, "")
    .replace(/\s*[-–|]\s*(cv|resume|السيرة الذاتية).*$/i, "")
    .trim();

  const title = withoutFiller.length >= 3 ? withoutFiller : cleaned;
  return { evidence: high(`Email subject: ${cleaned}`), title: low(title) };
}
