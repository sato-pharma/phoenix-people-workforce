// Campaign/Prospection visits are the one CRM visit type iReports360 sends with NO account:
// measured live 2026-08-08, 0 of 30,367 campaign rows carry either `contact_name` or
// `customer_name`, while 100% of them carry a free-text `comment`. That comment sometimes names
// the customer the rep actually saw ("مستشفى الهلال", "Karma hospital", "مخزن القادسية") and
// sometimes does not ("Sales day", "prospiction", a list of product names, "."). This module reads
// the account out of the comment when there is one there, and returns null when there is not.
//
// Owner rule (ai-assist-invisible-to-users): the assist must be INVISIBLE. Nothing here surfaces
// model wording, badges, or attribution — the board renders the resolved name exactly like a
// vendor-supplied one. Internal metrics still record the call (recordAiCall), because hiding it is
// for users, not for the audit trail.

import { createOpenAiResponseText, hasAiApiKey, PhoenixOpenAiError } from "@/lib/ai/openai-client";
import { logError } from "@/lib/observability/log";

/** A model answer longer than this is the whole note back, not a name. */
const MAX_ACCOUNT_LENGTH = 80;
/** Shorter than this cannot identify a customer ("د.", "مخ", "hi"). */
const MIN_ACCOUNT_LENGTH = 3;
/** One call per board render covers a district's day; this bounds a pathological one. */
const MAX_COMMENTS_PER_CALL = 60;

const ARABIC_DIACRITICS = /[ً-ٰٟـ]/g;

/**
 * Fold the orthographic variation that makes Arabic text disagree with itself — harakat, tatweel,
 * the alef and ya families, ta-marbuta — so a containment check is about the WORDS rather than
 * which hamza the rep happened to type. Mirrors the normalization the pharmacy matcher already
 * applies for the same reason.
 */
export function normalizeAccountText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(ARABIC_DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The anti-fabrication gate, and the reason this feature is safe to put in front of a manager.
 *
 * A model asked to "find the customer in this note" will, on a note that has none, happily invent a
 * plausible Egyptian hospital. That would put an account a rep never visited into a District
 * Manager's compliance board — worse than the dash it replaces, because it looks like evidence.
 * So a candidate is accepted ONLY if it actually occurs inside the rep's own comment. The model may
 * choose and delimit the name; it may not author one.
 *
 * Pure and exported so the guarantee is tested directly, without a network call.
 */
export function acceptExtractedAccount(
  comment: string | null | undefined,
  candidate: string | null | undefined,
): string | null {
  const note = typeof comment === "string" ? comment.trim() : "";
  const answer = typeof candidate === "string" ? candidate.trim() : "";
  if (note.length === 0 || answer.length === 0) return null;
  // Models spell a null answer several ways depending on how the schema round-trips.
  if (["null", "none", "n/a", "na", "-", "unknown"].includes(answer.toLowerCase())) return null;
  if (answer.length < MIN_ACCOUNT_LENGTH || answer.length > MAX_ACCOUNT_LENGTH) return null;
  // Handing back the entire note is not an extraction, it is a copy — and the note is usually an
  // activity remark, so this would fill the board with sentences.
  if (normalizeAccountText(answer) === normalizeAccountText(note)) return null;
  if (!normalizeAccountText(note).includes(normalizeAccountText(answer))) return null;
  return answer;
}

const INSTRUCTIONS =
  "You are reading short free-text notes written by pharmaceutical sales representatives in Egypt, " +
  "each about one field visit. Some notes name the customer the representative actually saw — a " +
  "doctor by name, or a place such as a hospital, clinic, pharmacy, medical centre, warehouse, or " +
  "company. Many notes do not. " +
  "For each note, return that customer name COPIED EXACTLY as it appears in the note, character for " +
  "character, in its own script. Arabic stays Arabic. Do not translate, transliterate, correct " +
  "spelling, expand abbreviations, or add a word that is not already in the note. " +
  "Return null when the note is an activity remark (for example 'Sales day', 'prospiction', " +
  "'follow up', 'took a promise to prescribe'), a list of medicine or product names, punctuation " +
  "or filler only, or when you are simply not confident. " +
  "Most notes have no customer name in them, so null is the expected answer and a useful one. A " +
  "confident wrong answer is far worse than null: a manager reads this as the account the " +
  "representative visited that morning, and will act on it. " +
  "The input is a JSON array of {index, note}. Answer for every index you were given, reusing that " +
  "same index. A note may span several lines and may name more than one customer; in that case " +
  "return only the first one it names.";

const TEXT_FORMAT = {
  format: {
    name: "phoenix_campaign_accounts",
    schema: {
      additionalProperties: false,
      properties: {
        accounts: {
          items: {
            additionalProperties: false,
            properties: {
              account: { type: ["string", "null"] as const },
              index: { type: "integer" as const },
            },
            required: ["index", "account"],
            type: "object" as const,
          },
          type: "array" as const,
        },
      },
      required: ["accounts"],
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

/**
 * Process-local memo. Comments are mostly unique across history (25,046 distinct in 30,365 rows),
 * so this is not a dedup win across the corpus — it exists because ONE district's board is
 * re-rendered many times a day over the same handful of that morning's notes, and every repeat
 * would otherwise be another paid round trip. Cleared on deploy, which is fine: it is a cache, not
 * a store. A durable cache belongs in the mirror, keyed by visit, and is deliberately not built
 * here — see the module note in the PR.
 */
const memo = new Map<string, string | null>();

function parseAccounts(outputText: string): Map<number, string | null> {
  const byIndex = new Map<number, string | null>();
  if (!outputText.trim()) return byIndex;
  const parsed: unknown = JSON.parse(outputText);
  const rows = (parsed as { accounts?: unknown }).accounts;
  if (!Array.isArray(rows)) return byIndex;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { index, account } = row as { index?: unknown; account?: unknown };
    if (typeof index !== "number" || !Number.isInteger(index)) continue;
    byIndex.set(index, typeof account === "string" ? account : null);
  }
  return byIndex;
}

/**
 * Resolve the account for each distinct campaign comment. Returns a map from the ORIGINAL comment
 * string to the account, or to null when the note names none.
 *
 * Never throws and never rejects: this runs inside a portal landing-page render, so a missing API
 * key, a timeout, a rate limit, or a malformed answer must all degrade to "no account" (a dash on
 * the board) rather than take the District Manager's dashboard down with them.
 */
export async function extractCampaignAccounts(comments: readonly string[]): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  const pending: string[] = [];

  for (const comment of comments) {
    const note = comment.trim();
    if (!note) continue;
    if (resolved.has(note)) continue;
    const cached = memo.get(note);
    if (cached !== undefined) {
      resolved.set(note, cached);
      continue;
    }
    if (!pending.includes(note)) pending.push(note);
  }

  if (pending.length === 0 || !hasAiApiKey()) return resolved;

  const batch = pending.slice(0, MAX_COMMENTS_PER_CALL);

  try {
    const { outputText } = await createOpenAiResponseText({
      // JSON, not a numbered list. Real notes are multi-line — reps paste several lines into one
      // comment ("Sales day\r\nمخزن الفرسان\r\nمخزن الهنا") — and a "0. …\n1. …" list silently
      // loses its index alignment the moment one entry wraps, which would attribute one rep's
      // account to another rep on the board.
      input: JSON.stringify(batch.map((note, index) => ({ index, note }))),
      instructions: INSTRUCTIONS,
      purpose: "crm_campaign_account_extraction",
      text: TEXT_FORMAT,
    });

    const byIndex = parseAccounts(outputText);
    for (const [index, note] of batch.entries()) {
      // acceptExtractedAccount is what makes an unanswered index and a hallucinated one behave
      // identically: both become null.
      const account = acceptExtractedAccount(note, byIndex.get(index) ?? null);
      memo.set(note, account);
      resolved.set(note, account);
    }
  } catch (error) {
    // Logged, not thrown. A board that quietly shows a dash is correct; a board that 500s is not.
    logError("Campaign account extraction failed; the board falls back to no account", {
      labels: {
        event: "crm_campaign_account_extraction_failed",
        code: error instanceof PhoenixOpenAiError ? error.code : "unknown",
        comments: batch.length,
      },
    });
  }

  return resolved;
}
