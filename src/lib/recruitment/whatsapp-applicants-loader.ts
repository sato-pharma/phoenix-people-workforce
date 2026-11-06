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
//
// The three rules live in inbound/whatsapp-session-link.ts since 20 Oct 2026, because the bot now
// writes each answer onto the candidate as it is given and must find the person the same way.
//
// THE TALENT ACQUISITION FENCE. Handed the viewer, the list and one application drop every HR
// applicant for the Talent Acquisition seat (workspace/fence.ts): a conversation whose tapped role is
// an HR one, and a conversation joined to a person the fence hides. Gone, never counted.

import type { AccessContext } from "@/lib/auth/permissions";
import { mapCandidate, recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { loadSavedAudiences } from "@/lib/recruitment/inbound/whatsapp-classify-session";
import { loadAllQuestions } from "@/lib/recruitment/inbound/whatsapp-screening-questions-session";
import {
  MESSAGE_ID_BATCH,
  readEveryPage,
  SESSION_LINK_RULES,
} from "@/lib/recruitment/inbound/whatsapp-session-link";
import type { WhatsAppApplicantRow, WhatsAppApplicantsView } from "@/lib/recruitment/whatsapp-applicant-filters";
import type { Candidate } from "@/lib/recruitment/types";
import { fetchAllRows } from "@/lib/supabase/paginated";
import {
  applicantTitleLabel,
  buildWhatsAppApplicantsView,
  type WhatsAppApplicantCandidate,
  type WhatsAppApplicantSession,
} from "@/lib/recruitment/whatsapp-applicants";
import { countsOnWhatsAppApplicants } from "@/lib/recruitment/whatsapp-cv-archive";
import { fenceApplies, fenceCandidateIds } from "@/lib/recruitment/workspace/fence";
import { HR_ROLE_FAMILIES } from "@/lib/recruitment/workspace/role-tabs";

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
        in_cv_folder: false,
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

/**
 * Marks the candidates filed in one of the owner's own folders, which this page leaves off.
 *
 * BEST-EFFORT, the way the candidate pool reads the same table (`attachCvFolderMemberships`): a read
 * that fails part-way leaves every CV listed, never a half-read set that hides some of them. The
 * table is small (one row per filed CV), so it is read whole rather than asked about by id.
 */
async function markCvFolderMembers(candidates: Map<string, WhatsAppApplicantCandidate>): Promise<void> {
  if (candidates.size === 0) return;
  const supabase = recruitmentDb();
  const filed = new Set<string>();
  try {
    // Every row, paged to a short page by the unique `id`. No page ceiling: a silent one would stop
    // marking the rest of the filed CVs and list them as if they were in no folder.
    const items = await fetchAllRows<{ candidate_id: string | null }>(
      () => supabase.from("ats_cv_folder_items").select("id,candidate_id"),
      "id",
    );
    for (const row of items) {
      const candidateId = textOrNull(row.candidate_id);
      if (candidateId) filed.add(candidateId);
    }
  } catch {
    // Best-effort, as the header says: a failed read marks nothing, so every CV stays listed.
    return;
  }
  for (const candidate of candidates.values()) candidate.in_cv_folder = filed.has(candidate.id);
}

/**
 * Joins every conversation to a candidate by the rules in the header, surest first, loading each
 * candidate it lands on into `candidates`. A conversation no rule reaches is simply absent from the
 * result. One place, so the list and a single application cannot disagree about whose chat it is.
 */
async function joinToCandidates(
  sessions: readonly SessionDbRow[],
  candidates: Map<string, WhatsAppApplicantCandidate>,
): Promise<Map<string, string>> {
  const joined = new Map<string, string>();
  for (const rule of SESSION_LINK_RULES) {
    const open = sessions.filter((session) => !joined.has(session.id));
    if (open.length === 0) break;
    const proposed = await rule(open);
    await loadCandidates([...proposed.values()], candidates);
    for (const [sessionId, candidateId] of proposed) {
      if (candidates.has(candidateId)) joined.set(sessionId, candidateId);
    }
  }
  return joined;
}

/** Who is looking. Optional so the scripts and tests that read the whole list keep working. */
export type WhatsAppApplicantsViewer = { access?: Pick<AccessContext, "role" | "scope"> | null };

/** A conversation whose own tapped role is an HR one: hidden from the Talent Acquisition seat. */
function isHrConversation(session: { job_title_family: string | null }): boolean {
  return Boolean(session.job_title_family && HR_ROLE_FAMILIES.includes(session.job_title_family));
}

/**
 * The conversations this viewer may see, and the joins that survive. Free for everyone the fence does
 * not apply to; for the Talent Acquisition seat one batched read of the joined people.
 */
async function fenceConversations<TSession extends { id: string; job_title_family: string | null }>(
  viewer: WhatsAppApplicantsViewer | undefined,
  sessions: readonly TSession[],
  joined: Map<string, string>,
): Promise<TSession[]> {
  const access = viewer?.access ?? null;
  if (!access || !fenceApplies(access)) return [...sessions];
  const visible = await fenceCandidateIds(access, [...joined.values()]);
  return sessions.filter((session) => {
    if (isHrConversation(session)) return false;
    const candidateId = joined.get(session.id);
    return !candidateId || visible.has(candidateId);
  });
}

/** Everything the WhatsApp Applicants page shows, read once per visit. */
export async function loadWhatsAppApplicantsView(viewer?: WhatsAppApplicantsViewer): Promise<WhatsAppApplicantsView> {
  const [allSessions, questions, audiences] = await Promise.all([
    loadStartedSessions(),
    loadAllQuestions(),
    loadSavedAudiences(),
  ]);

  const candidates = new Map<string, WhatsAppApplicantCandidate>();
  const joined = await joinToCandidates(allSessions, candidates);
  const sessions = await fenceConversations(viewer, allSessions, joined);
  await Promise.all([attachUnconfirmedGovernorates(candidates), markCvFolderMembers(candidates)]);

  return buildWhatsAppApplicantsView({
    audiences,
    candidates,
    questions,
    // A conversation from before the 2026-10-18 clean-up that joins to nobody is a person he had taken
    // out, not an unmatched applicant (whatsapp-cv-archive.ts, countsOnWhatsAppApplicants).
    sessions: sessions
      .filter((session) => countsOnWhatsAppApplicants(session.started_at, joined.has(session.id)))
      .map((session) => ({ ...session, candidate_id: joined.get(session.id) ?? null })),
  });
}

/**
 * One applicant's application: their row as the list shows it, the title in words, how to reach them, and
 * the candidate's record, which the old paper form's fields (address, birthday, education, jobs, skills)
 * are read from. The record is null only when the candidate row could not be read back.
 */
export type WhatsAppApplication = {
  row: WhatsAppApplicantRow;
  titleLabel: string;
  contact: { email: string | null; phone: string | null };
  candidate: Candidate | null;
};

/**
 * One conversation as an application, or null when it is not one: no such conversation, the job
 * title never tapped, or no candidate it can be joined to.
 *
 * Built by the SAME builder as the list, from that one conversation alone, so the sheet says exactly
 * what the row said. A candidate the owner has since filed into a folder still prints: the person
 * pressing Print is looking at the row, and `markCvFolderMembers` is left out on purpose because it is
 * the only step that would drop them.
 */
export async function loadWhatsAppApplication(
  sessionId: string,
  viewer?: WhatsAppApplicantsViewer,
): Promise<WhatsAppApplication | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select(SESSION_COLUMNS)
    .eq("id", sessionId)
    .not("job_title_family", "is", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const session = data as unknown as SessionDbRow;

  const candidates = new Map<string, WhatsAppApplicantCandidate>();
  const joinedOne = await joinToCandidates([session], candidates);
  const candidateId = joinedOne.get(session.id);
  if (!candidateId) return null;
  // Hidden from this viewer reads exactly like no such application.
  if ((await fenceConversations(viewer, [session], joinedOne)).length === 0) return null;

  // The fourth read fills a map the builder below reads, so it is awaited with the rest and answers nothing.
  const [questions, audiences, candidate] = await Promise.all([
    loadAllQuestions(),
    loadSavedAudiences(),
    loadRecord(candidateId),
    attachUnconfirmedGovernorates(candidates),
  ]);
  const contact = { email: textOrNull(candidate?.email), phone: textOrNull(candidate?.phone) };
  const view = buildWhatsAppApplicantsView({
    audiences,
    candidates,
    questions,
    sessions: [{ ...session, candidate_id: candidateId }],
  });
  const row = view.rows[0];
  if (!row) return null;
  return {
    candidate,
    contact,
    row,
    titleLabel: view.titles.find((title) => title.value === row.titleValue)?.label ?? applicantTitleLabel(row.titleValue),
  };
}

/**
 * The conversations that COULD be this candidate's, read by the three links `joinToCandidates` follows
 * and no other: the answers the bot wrote onto them, the CV that opened the chat, and the number that
 * sent their CV. It is a superset on purpose. The join itself decides which of them really are theirs,
 * so a forwarder's other conversations come back here and are dropped there, exactly as the list drops
 * them.
 */
async function sessionsThatMayBelongTo(candidateId: string): Promise<SessionDbRow[]> {
  const supabase = recruitmentDb();
  const found = new Map<string, SessionDbRow>();
  const keep = (rows: readonly SessionDbRow[]) => {
    for (const row of rows) found.set(row.id, row);
  };

  const linked = await supabase
    .from(SESSIONS_TABLE)
    .select(SESSION_COLUMNS)
    .not("job_title_family", "is", null)
    .eq("applied_candidate_id", candidateId);
  if (linked.error) throw linked.error;
  keep((linked.data ?? []) as unknown as SessionDbRow[]);

  const intake = await supabase
    .from(INTAKE_TABLE)
    .select("provider_message_id,sender_identifier")
    .eq("channel", "whatsapp")
    .eq("candidate_id", candidateId);
  if (intake.error) throw intake.error;
  const messageIds = new Set<string>();
  const senders = new Set<string>();
  for (const row of (intake.data ?? []) as { provider_message_id: string | null; sender_identifier: string | null }[]) {
    const messageId = textOrNull(row.provider_message_id);
    if (messageId) messageIds.add(messageId);
    // A conversation's `wa_id` is the number without the plus that the intake row carries.
    const sender = textOrNull(row.sender_identifier);
    if (sender && /^\+\d+$/.test(sender)) senders.add(sender.slice(1));
  }

  const links: Array<["cv_wamid" | "wa_id", string[]]> = [
    ["cv_wamid", [...messageIds]],
    ["wa_id", [...senders]],
  ];
  for (const [column, values] of links) {
    for (const batch of chunkIds(values, MESSAGE_ID_BATCH)) {
      keep(
        await readEveryPage<SessionDbRow>("WhatsApp conversation", (from, to) =>
          supabase
            .from(SESSIONS_TABLE)
            .select(SESSION_COLUMNS)
            .not("job_title_family", "is", null)
            .in(column, batch)
            .order("started_at", { ascending: false })
            .order("id", { ascending: true })
            .range(from, to),
        ),
      );
    }
  }
  return [...found.values()];
}

/**
 * Which of one person's applications a press opens: a finished one first, then the newest. That is the
 * list's own rule for two conversations under one title, applied across titles, so the button never
 * opens an application the list would have hidden behind a fuller one.
 */
export function chooseApplicationRow<TRow extends { appliedAt: string; finished: boolean }>(rows: readonly TRow[]): TRow | null {
  let chosen: TRow | null = null;
  for (const row of rows) {
    if (!chosen) {
      chosen = row;
    } else if (row.finished !== chosen.finished) {
      if (row.finished) chosen = row;
    } else if (Date.parse(row.appliedAt) > Date.parse(chosen.appliedAt)) {
      chosen = row;
    }
  }
  return chosen;
}

/**
 * The WhatsApp conversation whose application belongs to this candidate, or null when they never applied
 * on WhatsApp. It answers "is this person on WhatsApp Applicants, and under which conversation?" the way
 * the list does: the same join, the same choice of conversation, run over only the conversations that
 * could reach them. A candidate the owner has since filed into a folder still answers, as
 * `loadWhatsAppApplication` does, because someone is looking at their interview.
 */
export async function findWhatsAppApplicationSessionId(candidateId: string): Promise<string | null> {
  const sessions = await sessionsThatMayBelongTo(candidateId);
  if (sessions.length === 0) return null;

  const candidates = new Map<string, WhatsAppApplicantCandidate>();
  const joined = await joinToCandidates(sessions, candidates);
  const mine = sessions.filter((session) => joined.get(session.id) === candidateId);
  if (mine.length === 0) return null;

  const [questions, audiences] = await Promise.all([loadAllQuestions(), loadSavedAudiences()]);
  const view = buildWhatsAppApplicantsView({
    audiences,
    candidates,
    questions,
    sessions: mine.map((session) => ({ ...session, candidate_id: candidateId })),
  });
  return chooseApplicationRow(view.rows)?.sessionId ?? null;
}

/**
 * The candidate's whole record, mapped the way every other recruitment screen maps it. The phone and email
 * on it may be blank, and so may the rest: the sheet prints what there is and leaves the rest to a pen.
 */
async function loadRecord(candidateId: string): Promise<Candidate | null> {
  const { data, error } = await recruitmentDb().from("ats_candidates").select("*").eq("id", candidateId).maybeSingle();
  if (error) throw error;
  // `select("*")` types as an untyped row, the shape `mapCandidate` takes; this file's own CandidateDbRow is the narrower list read.
  return data ? mapCandidate(data as Record<string, unknown>) : null;
}

/**
 * The number this candidate applied on over WhatsApp — the chat they themselves answered the bot's
 * questions in — or null when they did not apply that way or the number cannot be trusted as theirs.
 *
 * Only the conversation the bot wrote its answers onto (rule 1 above) is read: it is the surest link
 * to the person. And a number that has sent CVs for SEVERAL different people is a forwarder's, not an
 * applicant's (two forwarders carry most WhatsApp CVs), so it is refused rather than guessed — the
 * interview invitation would otherwise open a chat with the forwarder. The caller then falls back to
 * the candidate's own stored numbers. Digits only, no plus, as a conversation's `wa_id` is kept.
 */
export async function findWhatsAppApplicantNumber(candidateId: string): Promise<string | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select("wa_id,started_at")
    .eq("applied_candidate_id", candidateId)
    .not("job_title_family", "is", null)
    .order("started_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  for (const row of (data ?? []) as { wa_id: string | null }[]) {
    const waId = textOrNull(row.wa_id);
    if (!waId || !/^\d{8,15}$/.test(waId)) continue;
    // Only "did this number send a CV for anybody else?" is asked, so the read excludes this candidate
    // itself and takes one row. A bare `.limit(50)` over every row of the number could be filled by this
    // candidate's own events and never reach the other person.
    const senders = await supabase
      .from(INTAKE_TABLE)
      .select("candidate_id")
      .eq("sender_identifier", `+${waId}`)
      .not("candidate_id", "is", null)
      .neq("candidate_id", candidateId)
      .limit(1);
    if (senders.error) throw senders.error;
    const people = new Set((senders.data ?? []).map((sender) => String((sender as { candidate_id: string }).candidate_id)));
    people.delete(candidateId);
    if (people.size === 0) return waId;
  }
  return null;
}
