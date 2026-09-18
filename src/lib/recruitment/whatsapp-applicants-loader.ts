// Recruitment / ATS — WhatsApp Applicants: the database half. Reads every conversation that got past
// question one, works out whose it is, and hands everything to `buildWhatsAppApplicantsView`, which
// decides what the page says. Nothing here decides anything a test would want to pin.
//
// WHOSE CONVERSATION IS IT. A conversation is keyed by a phone number, and a phone number is not a
// person: two forwarders carry most of the WhatsApp CVs for other people. So a conversation is joined
// to a candidate by the surest link that still points at a real candidate, in this order:
//
//   1. The candidate the bot wrote its answers onto (`applied_candidate_id`). 552 of 591 on
//      2026-09-18.
//   2. The candidate made from the CV that opened the conversation: the intake row whose message id
//      is the conversation's `cv_wamid`. 33 more, mostly conversations the bot never closed.
//   3. The sender's candidate, but ONLY when every CV that number ever sent became the same one
//      person. 3 more. A forwarder's number points at dozens of people, and guessing one of them
//      would put a stranger's answers on somebody's row.
//
// Anything still unjoined is counted under its title rather than listed (3 on 2026-09-18: two from a
// forwarder, one whose CV is not a candidate yet). Rule 1 has no foreign key behind it, so a merge can
// leave it pointing at a candidate that no longer exists. When it does, the next rule is tried
// instead of the conversation being lost.

import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { loadSavedAudiences } from "@/lib/recruitment/inbound/whatsapp-classify-session";
import { loadAllQuestions } from "@/lib/recruitment/inbound/whatsapp-screening-questions-session";
import type { WhatsAppApplicantsView } from "@/lib/recruitment/whatsapp-applicant-filters";
import {
  buildWhatsAppApplicantsView,
  type WhatsAppApplicantCandidate,
  type WhatsAppApplicantSession,
} from "@/lib/recruitment/whatsapp-applicants";

const SESSIONS_TABLE = "ats_whatsapp_classification_sessions";
const INTAKE_TABLE = "ats_cv_intake_events";

const SESSION_COLUMNS = [
  "id",
  "wa_id",
  "step",
  "job_title_family",
  "job_title_other_text",
  "background",
  "background_other_text",
  "region_code",
  "region_other_text",
  "area_name",
  "area_other_text",
  "experience",
  "expected_salary",
  "extra_current_question_key",
  "extra_answers",
  "started_at",
  "completed_at",
  "cv_wamid",
  "applied_candidate_id",
].join(",");

type SessionDbRow = Omit<WhatsAppApplicantSession, "candidate_id"> & {
  cv_wamid: string | null;
  applied_candidate_id: string | null;
};

/** Supabase serves at most 1000 rows a request, whatever `.limit()` asks for. */
const PAGE_SIZE = 1000;
/** 50,000 rows. Far past anything this reads, and a list with people silently missing is worse than an error. */
const PAGE_LIMIT = 50;

/**
 * A WhatsApp message id is about 60 characters, against 36 for the ids `chunkIds` is sized for. A
 * phone number is shorter, and 50 keeps both well inside the request-size limit db-batch.ts describes.
 */
const MESSAGE_ID_BATCH = 50;

/**
 * Every row a read returns, page by page. `readPage` must order on something unique: `.range()`
 * over an unordered read can repeat one page's rows and skip another's without an error.
 */
async function readEveryPage<TRow>(
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

/** Every conversation where the job title was tapped: the people the page is about. */
async function loadStartedSessions(): Promise<SessionDbRow[]> {
  const supabase = recruitmentDb();
  return readEveryPage<SessionDbRow>("WhatsApp conversation", (from, to) =>
    supabase
      .from(SESSIONS_TABLE)
      .select(SESSION_COLUMNS)
      .not("job_title_family", "is", null)
      .order("started_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );
}

/** Rule 1: the candidate the bot itself wrote the answers onto. */
function byBotLink(sessions: readonly SessionDbRow[]): Map<string, string> {
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
async function byOpeningCv(sessions: readonly SessionDbRow[]): Promise<Map<string, string>> {
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
async function bySendersOnlyCandidate(sessions: readonly SessionDbRow[]): Promise<Map<string, string>> {
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

type CandidateDbRow = { id: string; full_name: string | null; status: string | null; governorate: string | null };

/** Reads the candidates not already held. An id with no row simply stays absent. */
async function loadCandidates(ids: readonly string[], into: Map<string, WhatsAppApplicantCandidate>): Promise<void> {
  const wanted = [...new Set(ids)].filter((id) => !into.has(id));
  const supabase = recruitmentDb();
  for (const batch of chunkIds(wanted)) {
    const { data, error } = await supabase
      .from("ats_candidates")
      .select("id,full_name,status,governorate")
      .in("id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as CandidateDbRow[]) {
      into.set(row.id, {
        cv_unconfirmed_governorate: null,
        full_name: row.full_name,
        governorate: row.governorate,
        id: row.id,
        status: row.status,
      });
    }
  }
}

/**
 * The governorate the CV reader proposed without being sure, for the candidates with none on file.
 * Taken from the NEWEST reading, the same one the candidate pool shows, so the Region column here
 * and on the screening page come from the same reading of the same CV.
 */
async function attachUnconfirmedGovernorates(candidates: Map<string, WhatsAppApplicantCandidate>): Promise<void> {
  const needing = [...candidates.values()].filter((candidate) => !textOrNull(candidate.governorate)).map((candidate) => candidate.id);
  const supabase = recruitmentDb();
  const seen = new Set<string>();
  for (const batch of chunkIds(needing)) {
    const rows = await readEveryPage<{ candidate_id: string | null; governorate: unknown }>("CV reading", (from, to) =>
      supabase
        .from("ats_candidate_cv_extractions")
        .select("id,candidate_id,created_at,governorate:extracted_fields->governorate")
        .in("candidate_id", batch)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to),
    );
    for (const row of rows) {
      const candidateId = textOrNull(row.candidate_id);
      if (!candidateId || seen.has(candidateId)) continue;
      seen.add(candidateId);
      const proposal = row.governorate as { confidence?: unknown; value?: unknown } | null;
      // A sure reading is already on the column. Only a hedged one belongs here.
      const governorate = proposal && typeof proposal === "object" && proposal.confidence === "low" ? textOrNull(proposal.value) : null;
      const candidate = candidates.get(candidateId);
      if (candidate) candidate.cv_unconfirmed_governorate = governorate;
    }
  }
}

/** Everything the WhatsApp Applicants page shows, read once per visit. */
export async function loadWhatsAppApplicantsView(): Promise<WhatsAppApplicantsView> {
  const [sessions, questions, audiences] = await Promise.all([
    loadStartedSessions(),
    loadAllQuestions(),
    loadSavedAudiences(),
  ]);

  const candidates = new Map<string, WhatsAppApplicantCandidate>();
  const joined = new Map<string, string>();
  for (const rule of [byBotLink, byOpeningCv, bySendersOnlyCandidate]) {
    const open = sessions.filter((session) => !joined.has(session.id));
    if (open.length === 0) break;
    const proposed = await rule(open);
    await loadCandidates([...proposed.values()], candidates);
    for (const [sessionId, candidateId] of proposed) {
      if (candidates.has(candidateId)) joined.set(sessionId, candidateId);
    }
  }
  await attachUnconfirmedGovernorates(candidates);

  return buildWhatsAppApplicantsView({
    audiences,
    candidates,
    questions,
    sessions: sessions.map((session) => ({ ...session, candidate_id: joined.get(session.id) ?? null })),
  });
}
