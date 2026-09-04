// Recruitment / ATS — everything that has happened to one candidate, on one line each.
//
// WHY THIS EXISTS. The module records a candidate's history in five different places and showed it
// in none of them together: the status history is `ats_candidate_status_events`, a send is a row in
// `ats_candidate_manager_sends` (and a stamp on the candidate), a manager's answer is
// `ats_candidate_comments`, the CV read is `ats_cv_extractions`, and the arrival is the candidate
// row's own `created_at` plus its file. Answering "what happened to this person, and when" meant
// opening four screens, and two of those screens do not exist.
//
// NOTHING HERE INVENTS AN EVENT. Every line comes off a stored timestamp. Where the system has no
// record — an offer that predates the offer pipeline, a manager who read a CV without replying —
// the timeline is SHORT, and that is the correct answer rather than a gap to fill with a plausible
// step. A fabricated "HR reviewed" line is worse than an empty timeline: it is evidence of an act
// nobody performed, on a record about a real job applicant.
//
// PURE. Takes already-loaded rows and returns a sorted list, so the ordering and the wording are
// testable without a database, and so the client component that renders it carries no DB import.

import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { positionFolderLabel } from "@/lib/recruitment/position-folder";
import type { CandidateComment, CandidateStatusEvent, SentForPosition } from "@/lib/recruitment/types";

/**
 * What kind of thing happened, for the marker beside the line.
 *
 * Deliberately coarse. Five tones a reader can tell apart at a glance beats fifteen that all read
 * as grey dots — the timeline answers "roughly where is this person up to", and the detail is in
 * the sentence, not in the colour.
 */
export const candidateTimelineKinds = ["arrival", "read", "decision", "manager", "interview", "note"] as const;

export type CandidateTimelineKind = (typeof candidateTimelineKinds)[number];

export type CandidateTimelineEvent = {
  /** Stable within one candidate's timeline — used as the React key, never stored. */
  id: string;
  kind: CandidateTimelineKind;
  /** The headline, in the words a recruiter would use. Never a raw status code. */
  title: string;
  /** The second line — who, or which manager, or the note itself. Null when there is nothing. */
  detail: string | null;
  /** ISO. The renderer formats it in Africa/Cairo; nothing here formats a time. */
  at: string;
};

/** Everything the normalizer reads. Every field optional: a caller may hold only some of it. */
export type CandidateTimelineSources = {
  createdAt?: string | null;
  /** Where the CV came from, e.g. "WhatsApp". Only used to make the arrival line say so. */
  source?: string | null;
  files?: ReadonlyArray<{ id: string; fileName: string; kind: string; createdAt: string }>;
  /** The stored CV reads, newest first or oldest first — this sorts. */
  extractions?: ReadonlyArray<{ extractionId: string; createdAt: string | null; isCv: boolean | null }>;
  statusEvents?: readonly CandidateStatusEvent[];
  sends?: ReadonlyArray<{ managerName: string | null; sentAt: string; position: SentForPosition | null }>;
  comments?: readonly CandidateComment[];
  interviews?: ReadonlyArray<{
    id: string;
    interviewType: string;
    scheduledAt: string | null;
    outcome: string | null;
    createdAt: string;
  }>;
  /** When THIS viewer first opened the CV. One line, not one per view — see below. */
  firstSeenAt?: string | null;
};

/** Human words for an interview round. The stored values are snake_case keys, never shown raw. */
const interviewTypeLabels: Record<string, string> = {
  ceo_interview: "CEO interview",
  cv: "CV screening",
  hiring_manager: "Hiring manager interview",
  hr: "HR interview",
  nsm_interview: "National Sales Manager interview",
  phone: "Phone screening",
  rm_interview: "Regional Manager interview",
};

function interviewLabel(type: string): string {
  return interviewTypeLabels[type] ?? "Interview";
}

function trimmed(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * One candidate's history, newest first.
 *
 * NEWEST FIRST because the question a recruiter opens this tab with is "where are we now" — the
 * arrival five weeks ago is context, the manager's reply yesterday is the answer. The reference
 * prototype ran oldest-first, which reads well on a candidate who arrived an hour ago and badly on
 * every one of the 400 who did not.
 *
 * ONE LINE PER VIEW WOULD DROWN THE REST. The view table counts every opening, and a CV read three
 * times in one sitting is three rows saying nothing a reader can act on — so only the FIRST is a
 * line, and it says "you opened this", which is the half that is actually a fact about the history.
 */
export function buildCandidateTimeline(sources: CandidateTimelineSources): CandidateTimelineEvent[] {
  const events: CandidateTimelineEvent[] = [];
  const push = (event: CandidateTimelineEvent | null) => {
    if (event && trimmed(event.at)) events.push(event);
  };

  if (sources.createdAt) {
    const via = trimmed(sources.source);
    push({
      at: sources.createdAt,
      detail: via ? `Arrived via ${via}` : null,
      id: "created",
      kind: "arrival",
      title: "Candidate record created",
    });
  }

  for (const file of sources.files ?? []) {
    push({
      at: file.createdAt,
      detail: file.fileName,
      id: `file:${file.id}`,
      kind: "arrival",
      // The kind is the stored column ("cv", "certificate", …) and is shown as-is rather than
      // re-cased: a file somebody filed as something unusual should read as what they filed it as.
      title: file.kind === "cv" ? "CV attached" : `File attached · ${file.kind}`,
    });
  }

  for (const extraction of sources.extractions ?? []) {
    if (!extraction.createdAt) continue;
    push({
      at: extraction.createdAt,
      // `isCv === false` is the only judgement worth a line. Null means nobody judged — a
      // rules-only or OCR read never reaches a model — and printing "is a CV" for that would be
      // reporting a verdict that was never given.
      detail: extraction.isCv === false ? "The reader judged this file not to be a CV" : null,
      id: `extraction:${extraction.extractionId}`,
      kind: "read",
      title: "CV read",
    });
  }

  if (sources.firstSeenAt) {
    push({
      at: sources.firstSeenAt,
      detail: null,
      id: "first-seen",
      kind: "read",
      title: "You opened this CV",
    });
  }

  for (const event of sources.statusEvents ?? []) {
    const from = trimmed(event.fromStatus);
    push({
      at: event.createdAt,
      detail: trimmed(event.note),
      id: `status:${event.id}`,
      kind: "decision",
      // "New → Shortlisted" rather than "Shortlisted", because the move is the event. The labels go
      // through candidateStatusLabel, which handles the free-text statuses production carried
      // before the 2026-08-15 backfill instead of rendering them as undefined.
      title: from
        ? `${candidateStatusLabel(from)} → ${candidateStatusLabel(event.toStatus)}`
        : candidateStatusLabel(event.toStatus),
    });
  }

  for (const [index, send] of (sources.sends ?? []).entries()) {
    const position = send.position ? positionFolderLabel(send.position) : "";
    push({
      at: send.sentAt,
      detail: position ? `For ${position}` : null,
      id: `send:${index}:${send.sentAt}`,
      kind: "manager",
      // The name stored AT SEND TIME, never joined on render — the standing rule that a raw HR_ID
      // never reaches a person, and the reason the send freezes the name in the first place.
      title: `Sent to ${send.managerName ?? "a hiring manager"}`,
    });
  }

  for (const comment of sources.comments ?? []) {
    push({
      at: comment.createdAt,
      detail: comment.body,
      id: `comment:${comment.id}`,
      kind: "note",
      title: [comment.authorName, comment.authorJobTitle].filter(Boolean).join(" · ") || "Note added",
    });
  }

  for (const interview of sources.interviews ?? []) {
    const label = interviewLabel(interview.interviewType);
    if (interview.scheduledAt) {
      push({
        at: interview.scheduledAt,
        detail: trimmed(interview.outcome) ? `Outcome: ${interview.outcome}` : null,
        id: `interview:${interview.id}`,
        kind: "interview",
        title: `${label} scheduled`,
      });
    } else {
      push({
        at: interview.createdAt,
        detail: trimmed(interview.outcome) ? `Outcome: ${interview.outcome}` : null,
        id: `interview:${interview.id}`,
        kind: "interview",
        title: `${label} recorded`,
      });
    }
  }

  return events.sort((left, right) => {
    const difference = new Date(right.at).getTime() - new Date(left.at).getTime();
    // A stable tiebreak on the id: several of these land in the same second — the candidate row,
    // its file and its first CV read are all written by one intake run — and an unstable sort would
    // reshuffle them on every render.
    return difference !== 0 ? difference : left.id.localeCompare(right.id);
  });
}
