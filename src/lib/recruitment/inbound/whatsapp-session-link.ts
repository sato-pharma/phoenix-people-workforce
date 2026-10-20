// Recruitment / ATS — whose WhatsApp conversation is this? The three safe links, shared.
//
// A conversation is keyed by a phone number, and a phone number is not a person: two forwarders carry
// most of the WhatsApp CVs for other people. So a conversation is joined to a candidate by the surest
// link that still points at a real candidate, in this order:
//
//   1. The candidate the bot wrote its answers onto (`applied_candidate_id`).
//   2. The candidate made from the CV that opened the conversation: the intake row whose message id
//      is the conversation's `cv_wamid`.
//   3. The sender's candidate, but ONLY when every CV that number ever sent became the same one
//      person. A forwarder's number points at dozens of people, and guessing one of them would put a
//      stranger's answers on somebody's row.
//
// WHY THIS IS ITS OWN FILE. The WhatsApp Applicants page joined conversations this way first
// (whatsapp-applicants-loader.ts). Since 20 Oct 2026 the bot writes every answer onto the candidate
// the moment it is given (owner: answers are "saved as given", not only when the conversation
// finishes), and the newest-CV-from-this-number lookup it used before would hand a forwarder's
// applicant's answers to whoever the forwarder sent last. One set of rules, used by the page and by
// the bot, so the two can never disagree about whose answers these are.

import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { chunkIds } from "@/lib/recruitment/db-batch";

const INTAKE_TABLE = "ats_cv_intake_events";

/** Supabase serves at most 1000 rows a request, whatever `.limit()` asks for. */
export const PAGE_SIZE = 1000;
/** 50,000 rows. Far past anything this reads, and a list with people silently missing is worse than an error. */
export const PAGE_LIMIT = 50;
/**
 * A WhatsApp message id is about 60 characters, against 36 for the ids `chunkIds` is sized for. A
 * phone number is shorter, and 50 keeps both well inside the request-size limit db-batch.ts describes.
 */
export const MESSAGE_ID_BATCH = 50;

/**
 * Every row a read returns, page by page. `readPage` must order on something unique: `.range()`
 * over an unordered read can repeat one page's rows and skip another's without an error.
 */
export async function readEveryPage<TRow>(
  what: string,
  readPage: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<TRow[]> {
  const rows: TRow[] = [];
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await readPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as TRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(`${what} paging stopped at ${PAGE_LIMIT * PAGE_SIZE} rows. Refusing to show a list with people missing.`);
}

/** The four columns the links read. Every session shape in recruitment carries them. */
export type LinkableSession = {
  id: string;
  wa_id: string | null;
  cv_wamid?: string | null;
  applied_candidate_id: string | null;
};

/** Rule 1: the candidate the bot itself wrote the answers onto. */
export function byBotLink(sessions: readonly LinkableSession[]): Map<string, string> {
  const proposed = new Map<string, string>();
  for (const session of sessions) {
    const candidateId = textOrNull(session.applied_candidate_id);
    if (candidateId) proposed.set(session.id, candidateId);
  }
  return proposed;
}

/**
 * Rule 2: the candidate made from the CV that opened the conversation. The message id is unique per
 * channel, so each id matches one intake row at most and a batch can never pass the page limit.
 */
export async function byOpeningCv(sessions: readonly LinkableSession[]): Promise<Map<string, string>> {
  const sessionsByMessage = new Map<string, string[]>();
  for (const session of sessions) {
    const messageId = textOrNull(session.cv_wamid);
    if (!messageId) continue;
    sessionsByMessage.set(messageId, [...(sessionsByMessage.get(messageId) ?? []), session.id]);
  }

  const proposed = new Map<string, string>();
  const supabase = recruitmentDb();
  for (const batch of chunkIds([...sessionsByMessage.keys()], MESSAGE_ID_BATCH)) {
    const { data, error } = await supabase
      .from(INTAKE_TABLE)
      .select("provider_message_id,candidate_id")
      .eq("channel", "whatsapp")
      .in("provider_message_id", batch)
      .not("candidate_id", "is", null);
    if (error) throw error;
    for (const row of (data ?? []) as { provider_message_id: string | null; candidate_id: string | null }[]) {
      const messageId = textOrNull(row.provider_message_id);
      const candidateId = textOrNull(row.candidate_id);
      if (!messageId || !candidateId) continue;
      for (const sessionId of sessionsByMessage.get(messageId) ?? []) proposed.set(sessionId, candidateId);
    }
  }
  return proposed;
}

/**
 * Rule 3: the sender's candidate, only when every CV the number sent became that one candidate. A
 * number whose CVs became two or more people is a forwarder, and its conversation stays unjoined.
 */
export async function bySendersOnlyCandidate(sessions: readonly LinkableSession[]): Promise<Map<string, string>> {
  const senders = [...new Set(sessions.map((session) => textOrNull(session.wa_id)).filter((waId): waId is string => Boolean(waId)))];
  const candidatesBySender = new Map<string, Set<string>>();
  const supabase = recruitmentDb();
  for (const batch of chunkIds(senders, MESSAGE_ID_BATCH)) {
    const rows = await readEveryPage<{ sender_identifier: string | null; candidate_id: string | null }>(
      "WhatsApp intake",
      (from, to) =>
        supabase
          .from(INTAKE_TABLE)
          .select("id,sender_identifier,candidate_id")
          .in("sender_identifier", batch.map((waId) => `+${waId}`))
          .not("candidate_id", "is", null)
          .order("id", { ascending: true })
          .range(from, to),
    );
    for (const row of rows) {
      const sender = textOrNull(row.sender_identifier);
      const candidateId = textOrNull(row.candidate_id);
      if (!sender || !candidateId) continue;
      const found = candidatesBySender.get(sender) ?? new Set<string>();
      found.add(candidateId);
      candidatesBySender.set(sender, found);
    }
  }

  const proposed = new Map<string, string>();
  for (const session of sessions) {
    const found = candidatesBySender.get(`+${session.wa_id}`);
    if (found && found.size === 1) proposed.set(session.id, [...found][0]);
  }
  return proposed;
}

/** The three rules, surest first. One list, so the page and the bot walk them in the same order. */
export const SESSION_LINK_RULES = [byBotLink, byOpeningCv, bySendersOnlyCandidate] as const;

/** Which of these candidate ids exist. A merge can leave rule 1 pointing at a deleted row. */
async function existingCandidateIds(ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const wanted = [...new Set(ids)];
  for (const batch of chunkIds(wanted)) {
    const { data, error } = await recruitmentDb().from("ats_candidates").select("id").in("id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as { id: string }[]) found.add(row.id);
  }
  return found;
}

/**
 * The candidate each conversation belongs to, by the three rules, surest first. A conversation no
 * rule reaches — a forwarder's, or one whose CV is not a candidate yet — is absent. Throws on a failed
 * read; the bot's callers catch it and simply wait for the next answer or the intake backfill.
 */
export async function linkSessionsToCandidates(sessions: readonly LinkableSession[]): Promise<Map<string, string>> {
  const joined = new Map<string, string>();
  for (const rule of SESSION_LINK_RULES) {
    const open = sessions.filter((session) => !joined.has(session.id));
    if (open.length === 0) break;
    const proposed = await rule(open);
    const exists = await existingCandidateIds([...proposed.values()]);
    for (const [sessionId, candidateId] of proposed) {
      if (exists.has(candidateId)) joined.set(sessionId, candidateId);
    }
  }
  return joined;
}

/** The one conversation's candidate, or null when no safe link reaches one. */
export async function safeCandidateForSession(session: LinkableSession): Promise<string | null> {
  return (await linkSessionsToCandidates([session])).get(session.id) ?? null;
}
