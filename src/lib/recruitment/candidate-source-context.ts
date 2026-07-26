// Recruitment / ATS — "where did this CV come from" context shown on the candidate list/profile.
//
// Pure (no I/O) so it can be unit-tested and shared by both the WhatsApp webhook (which ASSEMBLES
// the context from a CV's caption + the sender's preceding messages) and the candidate data
// layer / UI (which FORMATS a stored intake event into a short label + full detail). The stored
// shape lives in ats_cv_intake_events.raw_metadata under `sourceContext` for WhatsApp; email uses
// the event's own `subject` column.

// How many of a sender's preceding WhatsApp messages to keep with a CV. The owner asked for the
// "first 2-3 messages"; 3 is the upper bound, oldest-first once assembled.
export const MAX_WHATSAPP_SOURCE_MESSAGES = 3;

export type WhatsAppSourceContext = {
  // The caption typed on the forwarded/sent CV document itself, if any.
  caption: string | null;
  // The sender's plain-text messages that arrived just before the CV, oldest first, capped.
  firstMessages: string[];
};

function cleanLine(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Assembles the WhatsApp source context from a CV document's caption plus the sender's buffered
 * preceding messages (as returned by the buffer, newest-first). Returns null when there is
 * genuinely nothing to show, so callers can skip writing an empty object.
 */
export function assembleWhatsAppSourceContext(
  caption: string | null | undefined,
  bufferedNewestFirst: ReadonlyArray<string | null | undefined>,
  limit: number = MAX_WHATSAPP_SOURCE_MESSAGES,
): WhatsAppSourceContext | null {
  const cleanedCaption = cleanLine(caption);
  const firstMessages = bufferedNewestFirst
    .map(cleanLine)
    .filter((line): line is string => line !== null)
    .slice(0, Math.max(0, limit))
    .reverse(); // buffer hands them back newest-first; show them in the order they were sent
  if (!cleanedCaption && firstMessages.length === 0) return null;
  return { caption: cleanedCaption, firstMessages };
}

function parseStoredWhatsAppContext(raw: unknown): WhatsAppSourceContext | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const caption = cleanLine(typeof record.caption === "string" ? record.caption : null);
  const firstMessages = Array.isArray(record.firstMessages)
    ? record.firstMessages.map(cleanLine).filter((line): line is string => line !== null)
    : [];
  if (!caption && firstMessages.length === 0) return null;
  return { caption, firstMessages };
}

// CandidateSourceContext (the display shape: channel + shortLabel + detailLines) is declared in
// src/lib/recruitment/types.ts alongside Candidate, since Candidate carries it. Imported for local
// use and re-exported so callers of this module get it from one place.
import type { CandidateSourceContext } from "@/lib/recruitment/types";
export type { CandidateSourceContext };

export type SourceContextRow = {
  channel?: string | null;
  subject?: string | null;
  raw_metadata?: unknown;
};

/**
 * Turns a candidate's most-recent intake event (from ats_candidate_source_context) into the
 * display shape the list column and profile panel render. Pure — an unknown/empty event yields an
 * empty context rather than throwing, so a manually-added candidate (no intake event) simply
 * shows nothing.
 */
export function describeCandidateSource(row: SourceContextRow | null | undefined): CandidateSourceContext {
  const channel = row?.channel === "email" || row?.channel === "whatsapp" ? row.channel : null;

  if (channel === "email") {
    const subject = cleanLine(row?.subject);
    return { channel, detailLines: subject ? [subject] : [], shortLabel: subject };
  }

  if (channel === "whatsapp") {
    const context = parseStoredWhatsAppContext((row?.raw_metadata as Record<string, unknown> | undefined)?.sourceContext);
    if (!context) return { channel, detailLines: [], shortLabel: null };
    const detailLines = [...(context.caption ? [context.caption] : []), ...context.firstMessages];
    return { channel, detailLines, shortLabel: detailLines[0] ?? null };
  }

  return { channel: null, detailLines: [], shortLabel: null };
}
