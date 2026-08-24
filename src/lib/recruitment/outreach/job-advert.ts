// Recruitment / ATS — building the advert text, and the per-channel apply link inside it.
//
// Pure (no I/O). The apply link is the only part that differs between one group and the next: same
// advert, same wording, a different code on the end. That difference is the entire mechanism by
// which "which group is worth posting in" becomes answerable.

import { isValidChannelCode, normalizeChannelCode } from "@/lib/recruitment/outreach/channel-code";

export type ApplyChannelKind = "whatsapp" | "email";

export type ApplyLinkInput = {
  kind: ApplyChannelKind;
  /** A phone number in any human format for WhatsApp, or an email address. */
  destination: string;
  jobTitle: string;
  location?: string | null;
  /** The channel's tracking code, e.g. PX-MRE. */
  code: string;
};

/**
 * Normalises a phone number for a wa.me link: digits only, no leading zeros or plus.
 *
 * wa.me wants the full international number with no punctuation and no leading +. Egyptian numbers
 * are handed around as "+20 10 …", "0020 10 …" and "010 …" interchangeably, so all three have to
 * land on the same string or the link silently opens a chat with nobody.
 */
export function normalizeWhatsAppNumber(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  if (digits.length === 0) return null;
  // 00 is the international prefix written out; 20 is Egypt. A bare local number starting 01 is
  // assumed Egyptian, which is the only country this company recruits in.
  let normalized = digits;
  if (normalized.startsWith("00")) normalized = normalized.slice(2);
  if (normalized.startsWith("01") && normalized.length === 11) normalized = `20${normalized.slice(1)}`;
  return normalized.length >= 8 ? normalized : null;
}

/**
 * The message the APPLICANT sends back to us, pre-filled into their WhatsApp or mail client.
 *
 * They can see and edit this before sending, so it has to read like something a person would
 * actually write. "Ref: PX-MRE" reads as an ordinary reference number, which is what it is.
 */
export function buildApplyMessage(input: Pick<ApplyLinkInput, "jobTitle" | "location" | "code">): string {
  const code = normalizeChannelCode(input.code);
  const where = String(input.location ?? "").trim();
  const title = String(input.jobTitle ?? "").trim() || "the advertised role";
  const role = where.length > 0 ? `${title} (${where})` : title;
  const opening = `Hello, I would like to apply for ${role}.`;
  return code ? `${opening} Ref: ${code}` : opening;
}

/**
 * Builds the tap-to-apply link that goes at the bottom of the advert.
 *
 * Returns null rather than a broken link when the destination or the code is unusable — a link
 * that opens an empty chat costs a real applicant, so an absent link (and a visible reason in the
 * UI) is strictly better than a wrong one.
 */
export function buildApplyLink(input: ApplyLinkInput): string | null {
  if (!isValidChannelCode(input.code)) return null;
  const message = buildApplyMessage(input);

  if (input.kind === "whatsapp") {
    const number = normalizeWhatsAppNumber(input.destination);
    if (!number) return null;
    return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  }

  const address = String(input.destination ?? "").trim();
  // Deliberately shallow: an address is either obviously shaped like one or it is a typo we should
  // not paste in front of hundreds of applicants.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  const subject = normalizeChannelCode(input.code)
    ? `Application: ${String(input.jobTitle ?? "").trim()} — Ref: ${normalizeChannelCode(input.code)}`
    : `Application: ${String(input.jobTitle ?? "").trim()}`;
  return `mailto:${address}?subject=${encodeURIComponent(subject)}`;
}

export type JobAdvertInput = {
  companyName: string;
  jobTitle: string;
  location?: string | null;
  /** Free-text lines the recruiter wants under the title — requirements, experience, whatever. */
  bulletPoints?: ReadonlyArray<string>;
  closingLine?: string | null;
};

/**
 * The default advert body, seeded into an editable box.
 *
 * Deliberately plain and deliberately incomplete: no salary (the band on a requisition is internal),
 * and no eligibility wording. Both are the recruiter's call to add, not something a template should
 * put in front of the public on his behalf.
 */
export function composeJobAdvert(input: JobAdvertInput): string {
  const company = String(input.companyName ?? "").trim() || "We";
  const title = String(input.jobTitle ?? "").trim() || "a new role";
  const where = String(input.location ?? "").trim();

  const lines: string[] = [`${company} is hiring: ${title}`];
  if (where.length > 0) lines.push(`Location: ${where}`);

  const bullets = (input.bulletPoints ?? [])
    .map((line) => String(line ?? "").trim())
    .filter((line) => line.length > 0);
  if (bullets.length > 0) {
    lines.push("");
    for (const bullet of bullets) lines.push(`- ${bullet}`);
  }

  const closing = String(input.closingLine ?? "").trim() || "To apply, send your CV here:";
  lines.push("");
  lines.push(closing);
  return lines.join("\n");
}

/**
 * Stitches one channel's link onto the advert body — the per-group step, done at copy time.
 *
 * The body is whatever the recruiter last typed, so it is appended to verbatim; nothing rewrites
 * his wording behind his back.
 */
export function renderAdvertForChannel(body: string, applyLink: string | null): string {
  const text = String(body ?? "").trimEnd();
  if (!applyLink) return text;
  return `${text}\n${applyLink}`;
}
