// Recruitment / ATS — the short code that ties an arriving CV back to the advert that produced it.
//
// Pure (no I/O) so the two halves can share one definition: the composer that BUILDS an apply link
// out of a code, and the intake path that READS that code back out of whatever the applicant
// actually sent us.
//
// Why a code travels inside the message at all, rather than a per-group number or mailbox: there is
// one WhatsApp number and one recruitment inbox, and there will only ever be one of each. So the
// channel cannot be inferred from where a message landed — it has to ride along inside it.

/**
 * The literal prefix every channel code carries.
 *
 * This prefix is the whole reason the extractor is safe to run across free text. The codes are
 * pulled out of an applicant's own words — a WhatsApp greeting, an email subject line — so a
 * pattern like "3 letters and a digit" would match employer names, degree abbreviations and half
 * the acronyms in a covering message. "PX-" followed by an alphanumeric run appears in none of it.
 */
export const CHANNEL_CODE_PREFIX = "PX-";

const CODE_BODY = "[A-Z0-9]{2,10}";

/** Anchored, for validating a code we already hold. */
const EXACT_CODE = new RegExp(`^${CHANNEL_CODE_PREFIX}${CODE_BODY}$`);

// Whole-token, for finding a code inside prose. The leading group refuses a code glued to the end
// of another word ("XPX-MRE" is not a code), and the trailing lookahead refuses a partial read of
// an over-long token — "PX-ABCDEFGHIJK" is rejected outright rather than silently truncated to its
// first ten characters, which would attribute the CV to a channel nobody created.
const CODE_IN_TEXT = new RegExp(
  `(?:^|[^A-Za-z0-9])(${CHANNEL_CODE_PREFIX}${CODE_BODY})(?![A-Za-z0-9])`,
  "i",
);

/** Upper-cases and trims a code. Applicants retype these, and they retype them in lower case. */
export function normalizeChannelCode(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function isValidChannelCode(value: string | null | undefined): boolean {
  const normalized = normalizeChannelCode(value);
  return normalized !== null && EXACT_CODE.test(normalized);
}

/**
 * Finds the first channel code in a list of strings the applicant sent — oldest first, so the
 * covering message wins over anything quoted later in the thread.
 *
 * Returns null when there is no code, which is the ordinary case and not a fault: every CV that
 * arrived before this feature existed, and everyone who typed their own message instead of tapping
 * the link, legitimately carries nothing.
 */
export function extractChannelCode(texts: ReadonlyArray<string | null | undefined>): string | null {
  for (const text of texts) {
    const value = String(text ?? "");
    if (value.length === 0) continue;
    const match = CODE_IN_TEXT.exec(value);
    if (match) return normalizeChannelCode(match[1]);
  }
  return null;
}

/**
 * Proposes a code for a newly added channel, from its name.
 *
 * Initials where the name gives them ("Medical Reps Egypt" produces PX-MRE), otherwise the opening
 * letters of the single word. Arabic-named groups yield no ASCII initials at all, so those fall
 * back to a plain sequence rather than an empty code — the code is an internal handle, and a group
 * named in Arabic still needs one.
 *
 * `taken` is every code already in use; a collision gets a numeric suffix rather than an error,
 * because two groups genuinely can share initials.
 */
export function deriveChannelCode(name: string, taken: ReadonlyArray<string> = []): string {
  const used = new Set(taken.map((code) => normalizeChannelCode(code)).filter((code): code is string => code !== null));
  const words = String(name ?? "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word.length > 0);

  let body = "";
  if (words.length >= 2) body = words.map((word) => word[0]).join("");
  else if (words.length === 1) body = words[0];

  body = body.replace(/[^A-Z0-9]/g, "").slice(0, 10);
  // Under two usable characters means the name carried no ASCII at all (an Arabic group name, or
  // punctuation only). "CH" is a deliberate non-word so the suffix loop below does the real work.
  if (body.length < 2) body = "CH";

  const base = `${CHANNEL_CODE_PREFIX}${body}`;
  if (!used.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    // Trim the body, never the prefix, so a long name plus a suffix still fits the 10-char body.
    const room = 10 - String(suffix).length;
    const candidate = `${CHANNEL_CODE_PREFIX}${body.slice(0, room)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`Could not derive a free channel code for "${name}".`);
}
