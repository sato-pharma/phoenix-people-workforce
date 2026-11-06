// Recruitment / ATS — inbound-intake funnel analytics + spike detection.
//
// Turns the ats_cv_intake_events log (+ the queue's dead-letter count) into the numbers the admin
// dashboard shows and the health cron alerts on: volume, per-channel + per-outcome breakdown, and a
// "delivery success" rate — of the messages that CARRIED a CV, how many became a candidate. The
// summarize step is pure so the whole funnel is unit-testable without a database.

import { recruitmentDb } from "@/lib/recruitment/db";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";

export type IntakeEventRow = { channel: string | null; outcome: string | null; created_at: string | null };

// Outcomes that mean "a CV was there" — the denominator of the success rate. ignored_no_attachment
// is deliberately excluded: a plain text/other message was never going to be a candidate, so
// counting it would understate how well real CVs are being captured.
const CV_BEARING_OUTCOMES = new Set([
  "candidate_created",
  "candidate_matched",
  "error",
  "ignored_unsupported_attachment",
]);
const CANDIDATE_OUTCOMES = new Set(["candidate_created", "candidate_matched"]);

export type IntakeChannelSummary = {
  channel: string;
  total: number;
  candidates: number;
  ignoredNoAttachment: number;
  errors: number;
};

export type InboundIntakeAnalytics = {
  windowDays: number;
  total: number;
  candidatesCreated: number;
  candidatesMatched: number;
  ignoredNoAttachment: number;
  ignoredUnsupported: number;
  errors: number;
  deadLettered: number;
  /** Of CV-bearing messages, the % that became a candidate. null when there were none. */
  successRatePct: number | null;
  byChannel: IntakeChannelSummary[];
  byOutcome: Array<{ outcome: string; count: number }>;
};

function normalizeChannel(value: string | null): string {
  return value === "whatsapp" || value === "email" ? value : "other";
}

export function summarizeInboundIntake(
  rows: readonly IntakeEventRow[],
  deadLettered: number,
  windowDays: number,
): InboundIntakeAnalytics {
  const byOutcomeMap = new Map<string, number>();
  const byChannelMap = new Map<string, IntakeChannelSummary>();
  let created = 0;
  let matched = 0;
  let ignoredNoAttachment = 0;
  let ignoredUnsupported = 0;
  let errors = 0;
  let cvBearing = 0;

  for (const row of rows) {
    const outcome = row.outcome ?? "unknown";
    byOutcomeMap.set(outcome, (byOutcomeMap.get(outcome) ?? 0) + 1);

    const channel = normalizeChannel(row.channel);
    const chan = byChannelMap.get(channel) ?? { candidates: 0, channel, errors: 0, ignoredNoAttachment: 0, total: 0 };
    chan.total += 1;
    if (CANDIDATE_OUTCOMES.has(outcome)) chan.candidates += 1;
    if (outcome === "ignored_no_attachment") chan.ignoredNoAttachment += 1;
    if (outcome === "error") chan.errors += 1;
    byChannelMap.set(channel, chan);

    if (outcome === "candidate_created") created += 1;
    else if (outcome === "candidate_matched") matched += 1;
    else if (outcome === "ignored_no_attachment") ignoredNoAttachment += 1;
    else if (outcome === "ignored_unsupported_attachment") ignoredUnsupported += 1;
    else if (outcome === "error") errors += 1;
    if (CV_BEARING_OUTCOMES.has(outcome)) cvBearing += 1;
  }

  return {
    byChannel: Array.from(byChannelMap.values()).sort((a, b) => b.total - a.total),
    byOutcome: Array.from(byOutcomeMap.entries())
      .map(([outcome, count]) => ({ count, outcome }))
      .sort((a, b) => b.count - a.count),
    candidatesCreated: created,
    candidatesMatched: matched,
    deadLettered,
    errors,
    ignoredNoAttachment,
    ignoredUnsupported,
    successRatePct: cvBearing > 0 ? Math.round(((created + matched) / cvBearing) * 100) : null,
    total: rows.length,
    windowDays,
  };
}

// A surge of errors/dead-letters over a short window is the "something is systematically wrong"
// signal the per-message dead-letter alert can't give (each of those is one CV). Pure + testable.
export function shouldAlertIntakeSpike(input: { errors: number; deadLettered: number; threshold: number }): boolean {
  return input.errors + input.deadLettered >= Math.max(1, input.threshold);
}

// Every event in the window, walked by id: the log is written while it is read, and a fixed row ceiling
// would understate the funnel (and the spike alert) without a sound.
async function fetchIntakeEvents(sinceIso: string): Promise<IntakeEventRow[]> {
  const supabase = recruitmentDb();
  return fetchAllRowsKeyset<IntakeEventRow & { id: string }>(
    () => supabase.from("ats_cv_intake_events").select("id,channel,outcome,created_at").gte("created_at", sinceIso),
    { cursorColumn: "id", cursorOf: (row) => row.id },
  );
}

async function countDeadLettered(sinceIso: string): Promise<number> {
  const supabase = recruitmentDb();
  const { count, error } = await supabase
    .from("ats_inbound_intake_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "dead")
    .gte("created_at", sinceIso);
  if (error) throw error;
  return count ?? 0;
}

export async function getInboundIntakeAnalytics(windowDays = 30, now: Date = new Date()): Promise<InboundIntakeAnalytics> {
  const sinceIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const [rows, deadLettered] = await Promise.all([fetchIntakeEvents(sinceIso), countDeadLettered(sinceIso).catch(() => 0)]);
  return summarizeInboundIntake(rows, deadLettered, windowDays);
}

// One attachment that arrived and did NOT become a candidate, with the reason it was turned away.
export type HeldBackIntakeRow = {
  id: string;
  channel: string;
  mailboxLabel: string | null;
  subject: string | null;
  sender: string | null;
  reason: string | null;
  createdAt: string | null;
};

// Deliberately small. This is a "what did we turn away, and was any of it a real applicant" list to
// glance down, not a log to page through — anything longer is a SQL question.
const HELD_BACK_LIMIT = 25;

/**
 * The attachments that arrived but were not turned into a candidate, newest first.
 *
 * Without this the stricter per-inbox gate (inbox-cv-gate.ts) would be a silent filter, and a
 * silent filter is exactly how a real applicant disappears without anyone noticing. Everything it
 * holds back is written to the intake event with its reason, and this is where that reason is read.
 *
 * Only rows carrying a reason: an `ignored_unsupported_attachment` with no message predates the
 * reason being recorded, and showing it as a blank line explains nothing.
 */
export async function listHeldBackIntakeAttachments(
  windowDays = 30,
  now: Date = new Date(),
): Promise<HeldBackIntakeRow[]> {
  const sinceIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_intake_events")
    .select("id,channel,mailbox_label,subject,sender_identifier,error_message,created_at")
    .eq("outcome", "ignored_unsupported_attachment")
    .not("error_message", "is", null)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(HELD_BACK_LIMIT);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      channel: String(r.channel ?? ""),
      createdAt: typeof r.created_at === "string" ? r.created_at : null,
      id: String(r.id ?? ""),
      mailboxLabel: typeof r.mailbox_label === "string" ? r.mailbox_label : null,
      reason: typeof r.error_message === "string" ? r.error_message : null,
      sender: typeof r.sender_identifier === "string" ? r.sender_identifier : null,
      subject: typeof r.subject === "string" ? r.subject : null,
    };
  });
}
