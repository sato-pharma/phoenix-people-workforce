// Recruitment / ATS — owner-editable wording for the automatic WhatsApp replies the bot sends BY
// ITSELF, as opposed to the six screening questions (whatsapp-question-prompts.ts).
//
// WHY THIS EXISTS. Asked on 2026-10-03 which of the WhatsApp messages he wanted reworded, the owner
// answered: "i want to be in control to freely edit them through phoenix anytime". The six questions
// already were. These six messages were not — they sat in three source files, so every rewording of
// a sentence a member of the public reads was a pull request, a CI round and a deploy. They are now
// one table and one screen, beside the questions, in the order an applicant meets them.
//
// ── THE BOUNDARY, same shape as the questions' one ──────────────────────────────────────────────
//
//   EDITABLE:     every word an applicant reads in these six messages.
//   NOT EDITABLE: WHEN each one is sent, and the summary lines the closing message prints between
//                 its intro and its outro (Role:, Region:, Area: …). Those are written from what the
//                 applicant actually answered, and a free-typed copy of them could tell somebody
//                 their application was recorded against a role they never chose.
//
// ABSENT ROW = CODE DEFAULT. There are no seed rows and no copy of the default text in the database:
// a key with no row falls back to the constant in the sender module, so "reset to default" is a
// DELETE, and improving a default in code still reaches every message nobody has reworded.
//
// This module is PURE — no I/O, no imports from the senders — so the admin client component can
// import its validators for live feedback, and the test can assert the whole contract with no
// database. The defaults themselves stay in the three sender modules that own each message; the
// catalogue that pairs them with these keys is whatsapp-auto-replies-catalogue.ts, which is
// server-side because it imports those senders.

/**
 * The six automatic replies, in the order an applicant meets them.
 *
 * Spelled exactly as the table's CHECK constraint spells them — one vocabulary, two places. A typo'd
 * key would otherwise sit in the table overriding nothing at all, which on screen reads exactly like
 * a saved edit that does not work.
 */
export const AUTO_REPLY_KEYS = [
  "text_only_plain",
  "text_only_job_enquiry",
  "unreadable_photo",
  "unreadable_too_large",
  "closing_intro",
  "closing_outro",
] as const;

export type AutoReplyKey = (typeof AUTO_REPLY_KEYS)[number];

export function isAutoReplyKey(value: unknown): value is AutoReplyKey {
  return typeof value === "string" && (AUTO_REPLY_KEYS as readonly string[]).includes(value);
}

/**
 * How long one editable message may be.
 *
 * Meta refuses a text message over 4,096 characters outright — it is not truncated, the send simply
 * fails — and the closing message is assembled from TWO editable blocks plus up to six generated
 * answer lines. 1,500 each leaves 4,096 - (1,500 + 1,500 + ~250) of headroom with every block at its
 * maximum, and the longest default today is under 500. Mirrored by the table's own CHECK so no path
 * can write a longer one.
 */
export const AUTO_REPLY_BODY_MAX = 1_500;

/** The file-size token. Written in the message; replaced at send time with the limit in force. */
export const MAX_MB_TOKEN = "{maxMb}";

/**
 * Tokens a message MUST keep.
 *
 * Only the too-large reply has one, and it is required rather than optional on purpose: the size
 * ceiling is env-overridable (RECRUITMENT_INBOUND_CV_MAX_BYTES), and a message quoting a number the
 * system no longer enforces sends a real applicant away to shrink a file that would have been
 * accepted. The token keeps the sentence true whatever the limit becomes.
 */
export const AUTO_REPLY_REQUIRED_TOKENS: Record<AutoReplyKey, readonly string[]> = {
  closing_intro: [],
  closing_outro: [],
  text_only_job_enquiry: [],
  text_only_plain: [],
  unreadable_photo: [],
  unreadable_too_large: [MAX_MB_TOKEN],
};

/** What the owner reads on the screen: which message this is, and when the bot sends it. */
export type AutoReplyMeta = { label: string; note: string };

export const AUTO_REPLY_META: Record<AutoReplyKey, AutoReplyMeta> = {
  closing_intro: {
    label: "Closing summary — opening line",
    note: "Sent when the applicant has answered the questions. The lines under it (Role, Region, Area, Experience, Expected salary) are printed from their own answers and are not editable.",
  },
  closing_outro: {
    label: "Closing summary — last line",
    note: "The last line of that same message, after the summary of what they told us.",
  },
  text_only_job_enquiry: {
    label: "They wrote asking about the job, with no CV",
    note: "Sent when somebody messages the line asking what the job is, or about salary or location, without attaching a CV. States only what is true — never invent a salary, a deadline or a requirement here.",
  },
  text_only_plain: {
    label: "They wrote a message with no CV",
    note: "Sent when somebody messages the line without attaching a CV and without asking about the job.",
  },
  unreadable_photo: {
    label: "They sent a photo instead of a file",
    note: "Sent when a picture arrives that no CV can be read from. The instruction to tap the paperclip and choose Document is what recovers a photographed CV.",
  },
  unreadable_too_large: {
    label: "Their CV file was too large to open",
    note: `Sent when the file is over the size limit. Write ${MAX_MB_TOKEN} where the limit should appear — the bot fills in the limit actually in force, so the sentence stays true if that setting changes.`,
  },
};

/** The saved wording, keyed by reply. Sparse: an absent key means the code default. */
export type AutoReplyOverrides = ReadonlyMap<string, string>;

/** Values a message may interpolate. Only the too-large reply uses one today. */
export type AutoReplyTokens = { maxMb?: number };

/**
 * Fills the tokens in a message. Applied to the DEFAULT and to an OVERRIDE through the same path, so
 * a reworded message cannot behave differently from the one it replaced.
 *
 * A token with no value is left standing rather than blanked: `{maxMb}` on screen is a visible fault
 * somebody reports, while a sentence reading "under  MB" looks like sloppy copy nobody owns.
 */
export function applyAutoReplyTokens(text: string, tokens: AutoReplyTokens = {}): string {
  let out = text;
  if (typeof tokens.maxMb === "number" && Number.isFinite(tokens.maxMb)) {
    out = out.split(MAX_MB_TOKEN).join(String(tokens.maxMb));
  }
  return out;
}

/**
 * The words to send for one reply: what the owner saved, else the sender's own default — tokens
 * filled either way.
 *
 * `fallback` is passed IN rather than looked up here so this module stays pure and the default text
 * keeps living next to the code that sends it. A blank or whitespace-only override is treated as
 * absent, which is the same direction every other fallback in this feature takes: a message that
 * must reach a real applicant is never allowed to come out empty.
 */
export function resolveAutoReply(input: {
  key: AutoReplyKey;
  fallback: string;
  overrides?: AutoReplyOverrides | null;
  tokens?: AutoReplyTokens;
}): string {
  const saved = input.overrides?.get(input.key);
  const body = typeof saved === "string" && saved.trim().length > 0 ? saved.trim() : input.fallback;
  return applyAutoReplyTokens(body, input.tokens ?? {});
}

/**
 * Everything wrong with a proposed wording, in sentences the owner can act on. Run by the client for
 * live feedback AND by the store before any write, so a message that would fail for a real applicant
 * can never be persisted in the first place.
 *
 * An empty body is NOT a violation here: blank is the reset gesture, handled by the store, which
 * drops the row and brings the code default back.
 */
export function autoReplyViolations(input: { key: string; bodyText: string }): string[] {
  const problems: string[] = [];
  if (!isAutoReplyKey(input.key)) {
    return [`"${input.key}" is not one of the automatic replies.`];
  }

  const body = input.bodyText.trim();
  if (body.length === 0) return problems;

  if (body.length > AUTO_REPLY_BODY_MAX) {
    problems.push(
      `This message is ${body.length} characters. WhatsApp refuses the whole message over ${AUTO_REPLY_BODY_MAX}, so it would not be shortened — it would not be sent at all.`,
    );
  }

  for (const token of AUTO_REPLY_REQUIRED_TOKENS[input.key]) {
    if (!body.includes(token)) {
      problems.push(
        `Keep ${token} in this message — the bot replaces it with the size limit actually in force, and a fixed number would send applicants away to shrink a file Phoenix would have accepted.`,
      );
    }
  }

  return problems;
}
