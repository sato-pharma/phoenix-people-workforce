// Recruitment — the words of an interview invitation, and the shapes the invitation screen shares
// with its server.
//
// PURE AND CLIENT-SAFE: no database, no clock, no environment. The server builds the message from a
// booking and the screen only shows it; because both read this one file, the text a person sees in
// the preview is the text that goes out.
//
// THE WORDING IS THE OWNER'S, given in chat on 2026-09-19 (an office invitation to a candidate):
//
//   Hello Nevin
//
//   Kindly find below the interview details.
//   • Date: 21-9-2026
//   • Time: 04:00 PM
//
//   • Location: <the map pin>
//
//   • Address: <the address, in Arabic>
//
//   • LinkedIn : <the company page>
//
//   • Website : www.satopharma.com
//
// A Zoom interview swaps the Location and Address lines for the Zoom link. The date is day-month-
// year with no leading zero, and the time is twelve-hour with one, exactly as he wrote them.

import { systemInterviewVenue } from "@/config/system-settings";
import { titledFirstName } from "@/lib/recruitment/candidate-greeting";
import type { InterviewPlatform } from "@/lib/recruitment/interview-calendar-types";

export type InvitationRecipient = "candidate" | "interviewer";
export type InvitationChannel = "whatsapp" | "email";
/** `invitation` is the interview itself; `company_details` is the location, LinkedIn and website alone. */
export type InvitationKind = "invitation" | "company_details";

export const INVITATION_RECIPIENTS: readonly InvitationRecipient[] = ["candidate", "interviewer"];

export function isInvitationRecipient(value: unknown): value is InvitationRecipient {
  return value === "candidate" || value === "interviewer";
}

export function isInvitationChannel(value: unknown): value is InvitationChannel {
  return value === "whatsapp" || value === "email";
}

export function isInvitationKind(value: unknown): value is InvitationKind {
  return value === "invitation" || value === "company_details";
}

export const INVITATION_CHANNEL_LABEL: Record<InvitationChannel, string> = { email: "E-mail", whatsapp: "WhatsApp" };

/** "2026-09-21" -> "21-9-2026". */
export function invitationDate(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  return `${Number(match[3])}-${Number(match[2])}-${match[1]}`;
}

/** 960 -> "04:00 PM"; 540 -> "09:00 AM"; 0 -> "12:00 AM". */
export function invitationTime(startMinutes: number): string {
  const hours = Math.floor(startMinutes / 60) % 24;
  const minutes = startMinutes % 60;
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(twelve).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

export type InvitationFacts = {
  dateKey: string;
  startMinutes: number;
  platform: InterviewPlatform;
  zoomJoinUrl: string | null;
  candidateName: string;
  candidateJobTitle: string | null;
  /**
   * The lead interviewer and their job title, as the candidate's invitation names them — "•
   * Interviewer: Ahmed Nour (Senior HR Manager)", the line of the owner's own invitation (owner,
   * 2026-10-20: "add the interviewer name in the invitation and title"). Absent when none is chosen.
   */
  interviewerName?: string | null;
  interviewerTitle?: string | null;
  /**
   * Where an in-person interview is held when the booker named a place (the Medical Rep workflow, §5:
   * "date, time and location must be registered"). Absent or blank means the company's usual venue.
   */
  location?: string | null;
};

export type InvitationLine = { label: string; value: string };

export type InvitationMessage = {
  /** The whole message as plain text — WhatsApp's body, and the e-mail's text part. */
  text: string;
  subject: string;
  /** The same lines, for the e-mail's table. */
  rows: InvitationLine[];
  /** The one button the e-mail carries: join the Zoom, or open the map. */
  action: { href: string; label: string } | null;
  /** The name after "Hello" — "Dr Nevin" for a candidate, the plain first name for an interviewer. */
  greeting: string;
};

/** The greeting's name: the first word, so "Hello Nevin" and never "Hello Nevin Adel Hassan". */
export function greetingName(fullName: string): string {
  const first = fullName.trim().split(/\s+/u)[0] ?? "";
  return first || "there";
}

const VENUE = systemInterviewVenue;

function companyLines(): InvitationLine[] {
  return [
    { label: "Location", value: VENUE.mapUrl },
    { label: "Address", value: VENUE.addressAr },
    { label: "LinkedIn", value: VENUE.linkedinUrl },
    { label: "Website", value: VENUE.websiteDisplay },
  ];
}

function whereLines(facts: InvitationFacts, recipient: InvitationRecipient): InvitationLine[] {
  if (facts.platform === "zoom") return facts.zoomJoinUrl ? [{ label: "Zoom link", value: facts.zoomJoinUrl }] : [];
  if (facts.platform === "phone") {
    return [{ label: "Interview", value: recipient === "candidate" ? "By phone call — we will call you at this time" : "By phone call — call the candidate at this time" }];
  }
  // A place the booker named is printed as it was typed — the head office's map link would send the
  // candidate to the wrong building.
  const place = facts.location?.trim();
  if (place) return [{ label: "Address", value: place }];
  return companyLines().slice(0, 2);
}

/**
 * The lines as the owner laid them out: a bullet each, with a blank line between one group and the
 * next. `groups` keeps the date and time together (as in his message) and every other item alone.
 */
function bulletText(groups: InvitationLine[][]): string {
  return groups
    .map((group) => group.map((line) => `• ${line.label}${SPACED_LABELS.has(line.label) ? " " : ""}: ${line.value}`).join("\n"))
    .join("\n\n");
}

/** LinkedIn and Website keep the owner's space before the colon ("LinkedIn : …"); the other labels do not. */
const SPACED_LABELS = new Set(["LinkedIn", "Website"]);

export function buildInvitationMessage(input: { recipient: InvitationRecipient; kind: InvitationKind; name: string; facts: InvitationFacts }): InvitationMessage {
  const { facts, kind, recipient } = input;
  // A candidate is greeted "Dr" before the first name (owner, 2026-10-20, candidate-greeting.ts); the
  // interviewer, a colleague, by the plain first name. No name at all is still "Hello there".
  const greeting = recipient === "candidate" && input.name.trim() ? titledFirstName(greetingName(input.name)) : greetingName(input.name);
  const hello = `Hello ${greeting}`;
  const when: InvitationLine[] = [
    { label: "Date", value: invitationDate(facts.dateKey) },
    { label: "Time", value: invitationTime(facts.startMinutes) },
  ];

  if (kind === "company_details") {
    const lines = companyLines();
    return {
      action: { href: VENUE.mapUrl, label: "Open the location on the map" },
      greeting,
      rows: lines,
      subject: "Sato Pharma — how to find us",
      text: `${hello}\n\nKindly find below our company details.\n\n${bulletText(lines.map((line) => [line]))}`,
    };
  }

  const where = whereLines(facts, recipient);
  const isZoom = facts.platform === "zoom";
  const action = isZoom
    ? facts.zoomJoinUrl
      ? { href: facts.zoomJoinUrl, label: "Join the Zoom meeting" }
      : null
    : facts.platform === "phone" || facts.location?.trim()
      ? null
      : { href: VENUE.mapUrl, label: "Open the location on the map" };

  if (recipient === "interviewer") {
    const who: InvitationLine[] = [{ label: "Candidate", value: facts.candidateName }];
    if (facts.candidateJobTitle) who.push({ label: "Applied for", value: facts.candidateJobTitle });
    const rows = [...who, ...when, ...where];
    return {
      action,
      greeting,
      rows,
      subject: `Interview with ${facts.candidateName} — ${invitationDate(facts.dateKey)}, ${invitationTime(facts.startMinutes)}`,
      text: `${hello}\n\nKindly find below the interview details.\n\n${bulletText([who, when, ...where.map((line) => [line])])}`,
    };
  }

  const company = companyLines().slice(2);
  // Who they will meet, in the owner's own format — "• Interviewer: Name (Title)" — on its own line
  // after the time, and the name in the subject too (owner, 2026-10-20).
  const interviewerName = facts.interviewerName?.trim() || null;
  const interviewerTitle = facts.interviewerTitle?.trim() || null;
  const interviewer: InvitationLine[] = interviewerName
    ? [{ label: "Interviewer", value: interviewerTitle ? `${interviewerName} (${interviewerTitle})` : interviewerName }]
    : [];
  const rows = [...when, ...interviewer, ...where, ...company];
  return {
    action,
    greeting,
    rows,
    subject: `Interview invitation${interviewerName ? ` with ${interviewerName}` : ""} — Sato Pharma, ${invitationDate(facts.dateKey)}`,
    text: `${hello}\n\nKindly find below the interview details.\n\n${bulletText([when, ...(interviewer.length ? [interviewer] : []), ...where.map((line) => [line]), ...company.map((line) => [line])])}`,
  };
}

// ── What the screen and the server pass between them ───────────────────────────────────────────

/** Where one person can be reached, and how that was found. */
export type InvitationContact = {
  /** The number as a person reads it back ("+20 101 234 5678"), or null when none can be dialled. */
  whatsappDisplay: string | null;
  /** Where the number came from, in words the sender can check it against. */
  whatsappSource: string | null;
  email: string | null;
};

export type InvitationMessageOption = {
  kind: InvitationKind;
  text: string;
  subject: string;
  /** wa.me link with the whole message in it, or null when there is no number. */
  whatsappUrl: string | null;
};

export type InvitationRecipientPlan = {
  recipient: InvitationRecipient;
  name: string;
  contact: InvitationContact;
  messages: InvitationMessageOption[];
  /** Why the invitation itself cannot be sent yet, or null. */
  problem: string | null;
};

export type InvitationLogEntry = {
  id: string;
  recipient: InvitationRecipient;
  channel: InvitationChannel;
  kind: InvitationKind;
  status: "sent" | "opened" | "failed";
  destination: string | null;
  detail: string | null;
  sentByName: string | null;
  createdAt: string;
};

export type InvitationPlan = {
  bookingId: string;
  platform: InterviewPlatform;
  candidate: InvitationRecipientPlan;
  /** Null until an interviewer is chosen. */
  interviewer: InvitationRecipientPlan | null;
  log: InvitationLogEntry[];
};

/** What a log row says, as one line: "E-mail sent to nevin@…" or "WhatsApp opened for +20 …". */
export function invitationLogSentence(entry: Pick<InvitationLogEntry, "channel" | "status" | "destination" | "detail">): string {
  const channel = INVITATION_CHANNEL_LABEL[entry.channel];
  const to = entry.destination ? ` ${entry.status === "opened" ? "for" : "to"} ${entry.destination}` : "";
  if (entry.status === "failed") return `${channel} failed${to}${entry.detail ? ` — ${entry.detail}` : ""}`;
  return entry.status === "opened" ? `${channel} opened${to}` : `${channel} sent${to}`;
}
