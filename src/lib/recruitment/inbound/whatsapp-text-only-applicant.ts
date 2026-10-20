// Recruitment / ATS — the applicant who messages the advertised line and attaches NO CV.
//
// WHY THIS EXISTS. Measured against production 2026-08-29: 461 WhatsApp intake events since 25
// July, from 18 sender numbers — and TWO of those numbers carry 439 of them (95%), because they are
// the bulk-forwarding handsets. Strip the forwarders out and the publicly advertised line
// (+20 10 98500699 — healthy, CLOUD_API, quality GREEN, printed on many job adverts) produced
// 22 events from 16 people in five weeks. That is not what an advertised recruitment line
// RECEIVES. It is what it was RECORDING.
//
// The gap sat in the webhook's fork. A message carrying a document was queued, extracted, and
// notified. A message carrying only TEXT — which is how nearly every Egyptian applicant opens on
// WhatsApp — was parked in the 24-hour source-context buffer, produced no intake event, no
// candidate and no notification, and was then deleted by that buffer's retention sweep. The
// applicant got total silence; nobody was told they had written; and a day later there was no
// evidence they ever had. The owner could FEEL the loss and could not MEASURE it, because the
// measurement was being erased on a timer. (ats_whatsapp_inbound_messages read 0 rows all-time on
// 2026-08-29 — two rows were swept between two queries minutes apart.)
//
// So this module does the three things that were missing, ordered by how much each recovers:
//
//   1. ASK — reply in the applicant's own thread telling them to send the CV as a file. This is the
//      only step that recovers the PERSON rather than merely counting them. Free-form text is
//      correct and policy-compliant here without an approved template, because this only ever runs
//      as a reply to a message that just arrived, i.e. always inside Meta's 24-hour customer
//      service window. That is why this does not go through whatsapp-reply.ts, which exists for the
//      out-of-window case and rightly demands a template.
//   2. RECORD — write a durable ats_cv_intake_events row so the loss is countable next time.
//      Deliberately reuses the EXISTING `ignored_no_attachment` outcome rather than inventing a new
//      one: the outcome column carries a CHECK constraint, that value already means exactly this,
//      and reusing it keeps the fix migration-free.
//   3. NOTIFY — tell Talent Acquisition a real person wrote in, in-app + Telegram + push.
//
// Split pure-decision from I/O on purpose: `decideTextOnlyAction` is a total function over a small
// context and is where every guard lives, so the guards can be asserted in a test with no database
// and no Meta.

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { notifyInboundWhatsAppTextOnly } from "@/lib/recruitment/inbound/recruitment-notify";
import { resolveAutoReply, type AutoReplyOverrides } from "@/lib/recruitment/inbound/whatsapp-auto-replies";
import { loadAutoReplyOverrides } from "@/lib/recruitment/inbound/whatsapp-auto-replies-store";
import { sendWhatsAppText } from "@/lib/recruitment/inbound/whatsapp-interactive";
import { isWhatsAppImportSender } from "@/lib/recruitment/inbound/whatsapp-payload-parser";
import { bySendersOnlyCandidate } from "@/lib/recruitment/inbound/whatsapp-session-link";

/** How far back "we already handled this sender" looks. Matches the classify session's own day-ish
 *  rhythm and Meta's 24h service window, so a person who writes again tomorrow is asked again. */
export const TEXT_ONLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Everything the decision needs, gathered by the caller. Kept as plain data so the guard order is
 * visible and testable in one place — the failure mode this replaces was a guard that existed only
 * as the shape of an `if` inside a 229-line route handler.
 */
export type TextOnlyContext = {
  /** A configured bulk-import handset, not an applicant. */
  isImportSender: boolean;
  /** A coexistence history replay — it already happened, sometimes months ago. */
  historical: boolean;
  /** This sender has an open classification conversation, so they ALREADY sent a CV. */
  hasOpenClassifySession: boolean;
  /** This sender produced a candidate inside the window — they are not missing a CV. */
  hasRecentCv: boolean;
  /**
   * This number belongs to a candidate still open with questions unanswered or no tab yet (typically
   * their reply to "Ask again"): the bot picks their conversation up where their answers stop (owner,
   * 2026-10-20) instead of asking for a CV they already sent. Optional: absent means "no".
   */
  canResume?: boolean;
  /** Prior text-only events already recorded for this sender inside the window. */
  priorTextOnlyEventsInWindow: number;
  /** The outbound half's kill switch (see isTextOnlyReplyEnabled). */
  replyEnabled: boolean;
};

export type TextOnlyAction = {
  /** Write the durable intake event. */
  record: boolean;
  /** Send the applicant the "send it as a file" reply. */
  ask: boolean;
  /** Push a notification to Talent Acquisition. */
  notify: boolean;
  /** Why — surfaced in the webhook's outcome list and in logs, so a quiet channel is explicable. */
  reason:
    | "import_sender"
    | "historical"
    | "classify_open"
    | "resume"
    | "already_applied"
    | "already_handled"
    | "reply_disabled"
    | "new_contact";
};

const NOTHING = { ask: false, notify: false, record: false } as const;

/**
 * The whole guard set, as one total function.
 *
 * Guard order is deliberate and each rung is a real production shape, not a hypothetical:
 *
 *  - IMPORT SENDER first. The two forwarding handsets are 95% of all traffic on this channel. Were
 *    they to reach the reply, the owner's own phone would be told to "please send your CV as a
 *    file" once per forwarded message, and the notification would fire hundreds of times. This is
 *    the same list, and the same reasoning, that startClassification guards on.
 *  - HISTORICAL next. A coexistence backfill replays months of old chat; every line of it would
 *    otherwise read as a person writing in right now.
 *  - CLASSIFY OPEN. They are mid-conversation answering our own menus, having already sent a CV.
 *    Asking for a CV here contradicts the question we just asked them.
 *  - ALREADY APPLIED. They sent a CV inside the window and are now following up ("did you get it?").
 *    Do NOT ask for a CV they already sent — but this is exactly the message a human should see, so
 *    it still records and still notifies.
 *  - ALREADY HANDLED. Their second, third, tenth message today. Record it (the count is the point)
 *    but stay silent on both channels: one reply and one notification per person per day.
 */
export function decideTextOnlyAction(context: TextOnlyContext): TextOnlyAction {
  if (context.isImportSender) return { ...NOTHING, reason: "import_sender" };
  if (context.historical) return { ...NOTHING, reason: "historical" };
  if (context.hasOpenClassifySession) return { ...NOTHING, reason: "classify_open" };
  // Their reply to "Ask again": the bot asks the next missing question itself, so nobody is asked for
  // a CV they already sent and nobody is notified about a conversation the bot is carrying. Recorded,
  // because the record is what makes a Meta redelivery a no-op.
  if (context.canResume) return { ask: false, notify: false, record: true, reason: "resume" };

  const first = context.priorTextOnlyEventsInWindow === 0;

  // A follow-up from someone who has already applied is worth a human's attention and worth
  // counting, but must never be answered with "send us your CV".
  if (context.hasRecentCv) {
    return { ask: false, notify: first, record: true, reason: "already_applied" };
  }

  if (!first) return { ask: false, notify: false, record: true, reason: "already_handled" };

  if (!context.replyEnabled) return { ask: false, notify: true, record: true, reason: "reply_disabled" };

  return { ask: true, notify: true, record: true, reason: "new_contact" };
}

/**
 * The outbound half's kill switch. Defaults to ON.
 *
 * Deliberately opt-OUT rather than opt-in. A feature that ships dark is a feature nobody can tell
 * from a broken one, and this repo has already paid for that mistake once (a capture path shipped
 * green, deployed cleanly and was reachable by nobody, which looks identical to zero adoption).
 * The owner approved the reply explicitly on 2026-08-29; the switch exists so it can be stopped in
 * seconds without a deploy, not so it has to be turned on to work.
 *
 * Recording and notifying have no switch at all — they touch nobody outside the company.
 */
export function isTextOnlyReplyEnabled(): boolean {
  return String(process.env.RECRUITMENT_WHATSAPP_TEXT_REPLY_ENABLED ?? "true").trim().toLowerCase() !== "false";
}

/** Whether this message asked us something, or merely opened a conversation. */
export type TextOnlyEnquiry = "asked_about_the_job" | "plain";

/**
 * Arabic written on a phone is not one spelling. Normalising before matching is the difference
 * between catching "التفاصيل" and missing "التفاصيل" typed with a different alef or a stray
 * diacritic — both of which arrive here constantly.
 *
 * Strips Arabic diacritics and tatweel, folds the alef/ya/ta-marbuta variants, drops the Arabic
 * comma, collapses whitespace, and lowercases so one keyword list covers both languages.
 */
function normalizeEnquiryText(body: string | null | undefined): string {
  return String(body ?? "")
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/،/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Strong signals that the sender ASKED something rather than just saying hello.
 *
 * Grounded in the real corpus, not imagined: of the first ten messages this channel recorded
 * (2026-08-29/30), SEVEN were pure greetings — "السلام عليكم", "مساء الخير", "Hello" — one named a
 * role and area ("MR Gharbia1 Tanta"), one announced an attachment, and exactly ONE asked a
 * question: "قريت الاعلان ... وكنت عايز اعرف التفاصيل ايه". That one got told to send a CV as a
 * file, which answered a question he had not asked and ignored the one he had.
 *
 * Deliberately keyword-based rather than AI: this composes a message sent to a member of the public
 * in their own thread, the OpenAI key on this project has been observed 401ing and falling back
 * silently, and an intent call that changes what a stranger is told must be inspectable in a diff
 * and pinned by a test. Cheap, total, and offline.
 */
const ENQUIRY_MARKERS = [
  // Arabic — asking for detail, terms, money, place, or simply "I want to know".
  "تفاصيل",
  "استفسار",
  "عايز اعرف",
  "عاوز اعرف",
  "عايزه اعرف",
  "عاوزه اعرف",
  "ممكن اعرف",
  "حابب اعرف",
  "اريد ان اعرف",
  "معلومات",
  "المرتب",
  "الراتب",
  "مرتب",
  "راتب",
  "شروط",
  "المطلوب",
  "الوظيفه ايه",
  "ايه الوظيفه",
  "فين المكان",
  "المنطقه ايه",
  // English.
  "detail",
  "salary",
  "package",
  "requirement",
  "qualification",
  "more info",
  "information",
  "tell me about",
  "what is the",
  "what are the",
  "how much",
  "where is",
  "which area",
];

/**
 * Did they ask us something?
 *
 * Biased deliberately TOWARDS answering. A false positive costs a few extra lines in a message that
 * still carries the CV instruction verbatim; a false negative is the exact defect being fixed —
 * someone asks a question and is answered with an instruction. Given that asymmetry, a bare
 * question mark counts.
 */
export function classifyTextOnlyEnquiry(body: string | null | undefined): TextOnlyEnquiry {
  const text = normalizeEnquiryText(body);
  if (text.length === 0) return "plain";
  if (text.includes("?") || text.includes("؟")) return "asked_about_the_job";
  return ENQUIRY_MARKERS.some((marker) => text.includes(marker)) ? "asked_about_the_job" : "plain";
}

/**
 * What the applicant is told.
 *
 * Bilingual because the adverts run in Arabic and the applicants write in Arabic, while the pool
 * and the reviewers work in English. Arabic goes FIRST: it is the language the reader is already
 * writing in, and burying it under an English paragraph is how a message gets skimmed past.
 *
 * It names the file formats on purpose. `ignored_unsupported_attachment` is 20 events from 5 people
 * — CVs photographed rather than attached, which the extractor cannot read — so "as a file, not a
 * photo" is not padding, it is the second-largest loss on this channel after silence itself.
 *
 * WHEN THEY ASKED A QUESTION the reply answers it first and asks second. What it may truthfully say
 * is bounded by what this system actually knows, and that is deliberately little: `ats_requisitions`
 * held five rows on 2026-08-30 and not one open Medical Representative, so the live Gharbia-1
 * campaign exists nowhere in the database. The advert runs outside Phoenix. **Never fabricate a
 * salary, a deadline or a requirement into this message** — it is sent to a member of the public in
 * the company's name. So it states only what is true and verifiable: the role being hired, that
 * hiring is per-area, and that a human sends the specifics. If a real vacancy feed ever lands in
 * `ats_requisitions`, this is the function that should read it.
 */
export function textOnlyReplyText(
  enquiry: TextOnlyEnquiry = "plain",
  overrides?: AutoReplyOverrides | null,
): string {
  return resolveAutoReply({
    fallback: textOnlyReplyDefault(enquiry),
    key: enquiry === "asked_about_the_job" ? "text_only_job_enquiry" : "text_only_plain",
    overrides,
  });
}

/**
 * The wording in code — what is sent until the owner rewords it on the Screening Questions screen,
 * and what that screen seeds its box with.
 *
 * Kept as the FALLBACK rather than copied into the database, so improving it here still reaches
 * every message nobody has reworded, and "reset to default" can be a row delete.
 */
export function textOnlyReplyDefault(enquiry: TextOnlyEnquiry = "plain"): string {
  // The ⚠️ line is identical in both variants on purpose: it is the one instruction that recovers a
  // photographed CV, and it must not vary with how the question was phrased.
  const cannotBeProcessed = "⚠️ A photo of a CV, or a typed message, cannot be processed.";

  if (enquiry === "asked_about_the_job") {
    return [
      "Thanks for contacting Sato Pharma 🌟",
      "We are hiring *Medical Representatives* in several areas.",
      "Our recruitment team will send you the full details for your area if your CV matches an open position.",
      "To start, please send your CV here as a *file* (PDF or Word).",
      cannotBeProcessed,
    ].join("\n");
  }

  return [
    "Thanks for contacting Sato Pharma 🌟",
    "To apply, please send your CV here as a *file* (PDF or Word).",
    cannotBeProcessed,
  ].join("\n");
}

/** First line of what they wrote, bounded — enough to recognise a real person from a phone alert. */
export function previewInboundText(body: string | null | undefined, max = 160): string {
  const flattened = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (flattened.length === 0) return "(no text)";
  // Never an ellipsis-truncated tail in the UI (owner rule), but this is a notification BODY, not a
  // table cell, and an unbounded paste of a long message into a push is worse. Cut on a word.
  if (flattened.length <= max) return flattened;
  const cut = flattened.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** How this person should be named to a human: their WhatsApp profile name, else their number. */
export function textOnlySenderLabel(contactName: string | null | undefined, phone: string): string {
  const name = String(contactName ?? "").trim();
  return name.length > 0 ? `${name} (${phone})` : phone;
}

type SenderHistory = {
  hasOpenClassifySession: boolean;
  hasRecentCv: boolean;
  priorTextOnlyEventsInWindow: number;
  /** The candidate this number's reply to "Ask again" resumes, or null. */
  resumeCandidateId: string | null;
};

/**
 * The candidate a text from this number resumes (owner, 2026-10-20), or null. Whose number it is:
 *
 *   1. the person the WhatsApp Inbox chat with this number is linked to — "Ask again" links it when
 *      it sends, so a reply to the follow-up always finds them;
 *   2. else the sender's only candidate — every CV this number ever sent became that one person (the
 *      same rule 3 the bot's answers use; a forwarder's number, whose CVs became several people,
 *      resumes nobody).
 *
 * And only when there is something to pick up: the person is still open (not hired, rejected or
 * archived) and either has questions unanswered or is not filed in any tab yet. Never a guess from
 * the number's newest CV.
 */
export async function findResumeCandidate(input: { waId: string }): Promise<string | null> {
  const supabase = recruitmentDb();
  const { data: chats, error } = await supabase
    .from("whatsapp_inbox_conversations")
    .select("candidate_id")
    .eq("contact_key", input.waId)
    .not("candidate_id", "is", null);
  if (error) throw error;
  let ids = Array.from(
    new Set(((chats ?? []) as Array<{ candidate_id: string | null }>).map((row) => row.candidate_id).filter(Boolean)),
  ) as string[];
  if (ids.length === 0) {
    const probe = { applied_candidate_id: null, cv_wamid: null, id: "sender", wa_id: input.waId };
    const only = (await bySendersOnlyCandidate([probe])).get("sender");
    ids = only ? [only] : [];
  }
  if (ids.length === 0) return null;

  const { data: candidates, error: candidateError } = await supabase
    .from("ats_candidates")
    .select("id,status,archived_at,missing_answer_keys,followup_sent_at")
    .in("id", ids)
    .is("archived_at", null)
    .order("followup_sent_at", { ascending: false, nullsFirst: false });
  if (candidateError) throw candidateError;
  const open = ((candidates ?? []) as Array<{ id: string; status: string | null; missing_answer_keys: string[] | null }>).filter(
    (row) => row.status !== "hired" && row.status !== "rejected",
  );
  if (open.length === 0) return null;

  const { data: placed, error: placedError } = await supabase
    .from("ats_candidate_placements")
    .select("candidate_id")
    .in(
      "candidate_id",
      open.map((row) => row.id),
    );
  if (placedError) throw placedError;
  const filed = new Set(((placed ?? []) as Array<{ candidate_id: string }>).map((row) => row.candidate_id));
  return open.find((row) => (row.missing_answer_keys ?? []).length > 0 || !filed.has(row.id))?.id ?? null;
}

/**
 * Reads the three facts the decision needs about this sender inside the window.
 *
 * One round trip each, and every one is allowed to fail loudly rather than silently widen the
 * decision: a failure here throws to the caller, which treats the whole message as best-effort.
 * Returning optimistic defaults instead would turn a transient database blip into a duplicate
 * reply to a real applicant.
 */
export async function loadSenderHistory(input: { phone: string; waId: string; now: Date }): Promise<SenderHistory> {
  const supabase = recruitmentDb();
  const sinceIso = new Date(input.now.getTime() - TEXT_ONLY_WINDOW_MS).toISOString();

  const [session, priorTextOnly, recentCv] = await Promise.all([
    supabase.from("ats_whatsapp_classification_sessions").select("id").eq("wa_id", input.waId).is("completed_at", null).maybeSingle(),
    supabase
      .from("ats_cv_intake_events")
      .select("id", { count: "exact", head: true })
      .eq("channel", "whatsapp")
      .eq("outcome", "ignored_no_attachment")
      .eq("sender_identifier", input.phone)
      .gte("created_at", sinceIso),
    supabase
      .from("ats_cv_intake_events")
      .select("id", { count: "exact", head: true })
      .eq("channel", "whatsapp")
      .in("outcome", ["candidate_created", "candidate_matched"])
      .eq("sender_identifier", input.phone)
      .gte("created_at", sinceIso),
  ]);

  if (priorTextOnly.error) throw priorTextOnly.error;
  if (recentCv.error) throw recentCv.error;

  // Only worth a read when no conversation is open — an open one is answered by the bot already.
  const resumeCandidateId = session.data ? null : await findResumeCandidate({ waId: input.waId });

  return {
    hasOpenClassifySession: Boolean(session.data),
    hasRecentCv: (recentCv.count ?? 0) > 0,
    priorTextOnlyEventsInWindow: priorTextOnly.count ?? 0,
    resumeCandidateId,
  };
}

/**
 * Writes the durable record. Idempotent on (channel, provider_message_id) — the same unique index
 * the CV path claims through — so a Meta redelivery of the whole payload records once, not twice.
 *
 * Returns false when the row already existed, which is also the signal that this exact message has
 * already been replied to and notified about. That matters more than it looks: Meta retries an
 * unacked payload, and without this a retry storm would send the same applicant the same reply
 * several times over.
 */
export async function recordTextOnlyMessage(input: {
  phone: string;
  waId: string;
  wamid: string;
  contactName: string | null;
  body: string | null;
  deliveredToPhoneNumberId: string | null;
  deliveredToDisplayNumber: string | null;
  reason: TextOnlyAction["reason"];
}): Promise<boolean> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_cv_intake_events").insert({
    channel: "whatsapp",
    outcome: "ignored_no_attachment",
    provider_message_id: input.wamid,
    raw_metadata: {
      // The flag a future count keys on. `ignored_no_attachment` predates this feature and is also
      // written by the worker for a document whose download failed, so the two must stay separable.
      textOnly: true,
      body: previewInboundText(input.body, 500),
      messageType: "text",
      reason: input.reason,
      wa_id: input.waId,
      ...(input.deliveredToPhoneNumberId ? { deliveredToPhoneNumberId: input.deliveredToPhoneNumberId } : {}),
      ...(input.deliveredToDisplayNumber ? { deliveredToDisplayNumber: input.deliveredToDisplayNumber } : {}),
    },
    sender_display_name: input.contactName,
    sender_identifier: input.phone,
  });
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") return false;
  throw error;
}

/**
 * Sends the reply. Never throws — an unsent reply must not cost us the record of the applicant.
 *
 * Takes what they wrote, not a pre-computed variant: classifying at the point of sending is what
 * stops a future caller from wiring the reply up and silently getting the greeting version for
 * everybody, which is the defect this parameter exists to fix.
 */
export async function askForCvFile(input: {
  waId: string;
  phoneNumberId: string | null;
  body?: string | null;
  inboundWamid?: string | null;
}): Promise<boolean> {
  const result = await sendWhatsAppText({
    phoneNumberId: input.phoneNumberId,
    logContext: { detail: { enquiry: classifyTextOnlyEnquiry(input.body) }, inboundWamid: input.inboundWamid ?? null },
    // The owner's own wording when he has saved one, else the default above. Loaded here rather than
    // at module load so a rewording reaches the very next applicant, and best-effort inside the
    // store — a database hiccup must cost the words, never the reply.
    text: textOnlyReplyText(classifyTextOnlyEnquiry(input.body), await loadAutoReplyOverrides()),
    toWaId: input.waId,
  }).catch((error) => {
    logError("WhatsApp text-only reply threw", {
      error,
      labels: { event: "whatsapp_text_only_reply_threw" },
    });
    return { detail: "threw", ok: false as const, reason: "failed" as const };
  });
  return result.ok === true;
}

/**
 * At most this many replies per webhook DELIVERY. Same bound, and the same reason, as the classify
 * prompts: each reply is one Graph round trip inside a request whose whole job is to ack fast, and
 * Meta disables a webhook that keeps missing its delivery timeout. Nobody reaches this in normal
 * traffic — a bulk forward is already excluded before any network call.
 */
export const MAX_TEXT_ONLY_REPLIES_PER_DELIVERY = 3;

export type HandleTextOnlyResult = {
  asked: boolean;
  reason: TextOnlyAction["reason"] | "duplicate" | "budget" | "error";
};

/**
 * The whole text-only path, end to end. NEVER throws.
 *
 * Order is deliberate: RECORD, then ask, then notify. The record is the idempotency anchor — it is
 * claimed on the wamid's unique index, so a Meta redelivery of the same payload finds the row
 * already there and stops, which is what prevents a retry storm from messaging one applicant five
 * times. Recording first does mean a reply that fails AFTER a successful record is not retried, and
 * that trade is taken on purpose: the notification still fires and names the person, so a human
 * knows to answer, whereas the opposite order risks spamming a real applicant automatically.
 */
export async function handleTextOnlyMessage(input: {
  waId: string;
  wamid: string;
  body: string | null;
  contactName: string | null;
  historical: boolean;
  importSenders: readonly string[];
  deliveredToPhoneNumberId: string | null;
  deliveredToDisplayNumber: string | null;
  repliesSent: number;
  now?: Date;
}): Promise<HandleTextOnlyResult> {
  const isImportSender = isWhatsAppImportSender(input.waId, input.importSenders);

  // The two guards that need no database — and they cover ~95% of this channel's traffic, so
  // answering them before the round trip is what keeps a bulk forward as cheap as it was.
  if (isImportSender) return { asked: false, reason: "import_sender" };
  if (input.historical) return { asked: false, reason: "historical" };

  const now = input.now ?? new Date();
  const phone = `+${input.waId}`;

  try {
    const history = await loadSenderHistory({ now, phone, waId: input.waId });
    const action = decideTextOnlyAction({
      canResume: Boolean(history.resumeCandidateId),
      historical: false,
      hasOpenClassifySession: history.hasOpenClassifySession,
      hasRecentCv: history.hasRecentCv,
      isImportSender: false,
      priorTextOnlyEventsInWindow: history.priorTextOnlyEventsInWindow,
      replyEnabled: isTextOnlyReplyEnabled(),
    });

    if (!action.record) return { asked: false, reason: action.reason };

    const recorded = await recordTextOnlyMessage({
      body: input.body,
      contactName: input.contactName,
      deliveredToDisplayNumber: input.deliveredToDisplayNumber,
      deliveredToPhoneNumberId: input.deliveredToPhoneNumberId,
      phone,
      reason: action.reason,
      waId: input.waId,
      wamid: input.wamid,
    });
    // Already recorded, therefore already replied to and already notified about. A Meta retry.
    if (!recorded) return { asked: false, reason: "duplicate" };

    const withinBudget = input.repliesSent < MAX_TEXT_ONLY_REPLIES_PER_DELIVERY;

    if (action.reason === "resume" && history.resumeCandidateId) {
      if (!withinBudget) return { asked: false, reason: "budget" };
      // Loaded here, not at the top: the conversation module is the whole bot, and this file stays light
      // for the pure decision above and the tests that read it.
      const { resumeClassification } = await import("@/lib/recruitment/inbound/whatsapp-classify-session");
      const resumed = await resumeClassification({
        candidateId: history.resumeCandidateId,
        phoneNumberId: input.deliveredToPhoneNumberId,
        waId: input.waId,
      });
      if (resumed === "asked") return { asked: true, reason: "resume" };
      // Nothing left to ask, or the send failed: a person wrote to us and the bot did not answer, so
      // a human hears about it.
      await notifyInboundWhatsAppTextOnly({
        alreadyApplied: true,
        asked: false,
        askedAboutTheJob: classifyTextOnlyEnquiry(input.body) === "asked_about_the_job",
        preview: previewInboundText(input.body),
        senderLabel: textOnlySenderLabel(input.contactName, phone),
        wamid: input.wamid,
      }).catch((notifyError) => {
        logError("WhatsApp text-only notification failed", {
          error: notifyError,
          labels: { event: "whatsapp_text_only_notify_failed", wamid: input.wamid },
        });
      });
      return { asked: false, reason: "resume" };
    }
    const asked =
      action.ask && withinBudget
        ? await askForCvFile({
            body: input.body,
            inboundWamid: input.wamid,
            phoneNumberId: input.deliveredToPhoneNumberId,
            waId: input.waId,
          })
        : false;

    if (action.notify) {
      // Best-effort: a notification failure must not cost us the record or the reply that already
      // succeeded, and must never fail the delivery.
      await notifyInboundWhatsAppTextOnly({
        alreadyApplied: action.reason === "already_applied",
        asked,
        askedAboutTheJob: classifyTextOnlyEnquiry(input.body) === "asked_about_the_job",
        preview: previewInboundText(input.body),
        senderLabel: textOnlySenderLabel(input.contactName, phone),
        wamid: input.wamid,
      }).catch((notifyError) => {
        logError("WhatsApp text-only notification failed", {
          error: notifyError,
          labels: { event: "whatsapp_text_only_notify_failed", wamid: input.wamid },
        });
      });
    }

    if (action.ask && !withinBudget) return { asked: false, reason: "budget" };
    return { asked, reason: action.reason };
  } catch (error) {
    logError("WhatsApp text-only handling failed", {
      error,
      labels: { event: "whatsapp_text_only_failed", wamid: input.wamid },
    });
    return { asked: false, reason: "error" };
  }
}
