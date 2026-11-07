// Recruitment — sending an interview's invitation to the candidate and to the interviewer.
//
// WHAT THIS DOES, PLAINLY, BECAUSE THE SCREEN MUST NOT OVERSTATE IT:
//   * E-MAIL is sent from Phoenix. The row in the log says `sent` or `failed`, as the mail provider
//     answered.
//   * WHATSAPP is a click-to-chat link: Phoenix writes the message and opens the chat, and the person
//     presses Send inside WhatsApp (see whatsapp-templates/send-link.ts for why the Cloud API cannot
//     carry this). The log row says `opened` — never `sent`.
//
// WHO GETS WHAT, AND ON WHICH NUMBER (the owner's rule, 2026-09-19):
//   * A candidate who applied on WhatsApp is messaged on that same WhatsApp number. Otherwise the
//     WhatsApp number on their record, then their phone number.
//   * The interviewer's WhatsApp number is the one in Employee Master (`mobile_number`).
//
// THE GATE. Every function here needs the calendar's "book" level on the interview's week: the owner
// and editors. Nothing is sent to anyone else's say-so.

import { createHash } from "node:crypto";

import { systemEmail } from "@/config/system-settings";
import { hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { recordManualEmailSendAudit } from "@/lib/email/email-composer-service";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { emailNotificationsEnabled } from "@/lib/notifications/email";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import {
  getInterviewBooking,
  loadPeople,
  personName,
  requireCalendarAccess,
  type InterviewCalendarCaller,
} from "@/lib/recruitment/interview-calendar";
import { weekStartFor } from "@/lib/recruitment/interview-calendar-week";
import type { InterviewBooking } from "@/lib/recruitment/interview-calendar-types";
import {
  buildInvitationMessage,
  isInvitationKind,
  isInvitationRecipient,
  type InvitationChannel,
  type InvitationContact,
  type InvitationFacts,
  type InvitationKind,
  type InvitationLogEntry,
  type InvitationMessageOption,
  type InvitationPlan,
  type InvitationRecipient,
  type InvitationRecipientPlan,
} from "@/lib/recruitment/interview-invitation";
import { renderInvitationEmail } from "@/lib/recruitment/interview-invitation-email";
import { satoEmailFrom } from "@/lib/sato-email/service";
import { firstNameOf } from "@/lib/recruitment/whatsapp-templates/candidate-context";
import { findWhatsAppApplicantNumber } from "@/lib/recruitment/whatsapp-applicants-loader";
import { formatDialNumberForDisplay, toWhatsAppDialNumber, whatsAppSendUrl } from "@/lib/recruitment/whatsapp-templates/send-link";

const INVITATIONS = "ats_interview_invitations";
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ZOOM_NOT_READY = "This Zoom interview has no meeting link yet, so there is nothing to invite anyone to. Open the interview and try Zoom again first.";

// ── Who can be reached, and how ─────────────────────────────────────────────────────────────────

function contactFrom(input: { dial: string | null; source: string | null; email: string | null }): InvitationContact {
  const email = input.email && EMAIL_SHAPE.test(input.email.trim()) ? input.email.trim() : null;
  return {
    email,
    whatsappDisplay: input.dial ? formatDialNumberForDisplay(input.dial) : null,
    whatsappSource: input.dial ? input.source : null,
  };
}

/**
 * The candidate: the WhatsApp they applied on, else the WhatsApp number on their record, else their
 * phone. An outside person kept on the booking alone has only what was typed when booking.
 */
async function candidateContact(booking: InterviewBooking): Promise<{ dial: string | null; contact: InvitationContact }> {
  if (!booking.candidateId) {
    const dial = toWhatsAppDialNumber(booking.externalPhone);
    return { contact: contactFrom({ dial, email: booking.externalEmail, source: "the phone number typed when the interview was booked" }), dial };
  }
  const { data, error } = await recruitmentDb().from("ats_candidates").select("email,phone,whatsapp").eq("id", booking.candidateId).maybeSingle();
  if (error) throw error;
  const row = (data ?? {}) as Record<string, unknown>;

  const applied = await findWhatsAppApplicantNumber(booking.candidateId);
  const appliedDial = applied ? toWhatsAppDialNumber(applied) : null;
  const whatsappDial = toWhatsAppDialNumber(textOrNull(row.whatsapp));
  const phoneDial = toWhatsAppDialNumber(textOrNull(row.phone));
  const [dial, source] = appliedDial
    ? [appliedDial, "the WhatsApp number they applied on"]
    : whatsappDial
      ? [whatsappDial, "the WhatsApp number on their record"]
      : phoneDial
        ? [phoneDial, "the phone number on their record"]
        : [null, null];
  return { contact: contactFrom({ dial, email: textOrNull(row.email), source }), dial };
}

/** The interviewer: the mobile number and work e-mail in Employee Master. */
async function interviewerContact(hrId: string): Promise<{ dial: string | null; contact: InvitationContact; jobTitle: string | null }> {
  const { data, error } = await recruitmentDb().from("employees").select("hr_id,mobile_number,work_email,job_title").in("hr_id", hrIdLookupKeys(hrId)).limit(1);
  if (error) throw error;
  const row = ((data ?? [])[0] ?? {}) as Record<string, unknown>;
  const dial = toWhatsAppDialNumber(textOrNull(row.mobile_number));
  return { contact: contactFrom({ dial, email: textOrNull(row.work_email), source: "Employee Master" }), dial, jobTitle: textOrNull(row.job_title) };
}

// ── The plan ────────────────────────────────────────────────────────────────────────────────────

/** `interviewerTitle` is the lead interviewer's job title from Employee Master, for the candidate's line. */
function factsOf(booking: InterviewBooking, interviewerTitle: string | null): InvitationFacts {
  return {
    candidateJobTitle: booking.candidateJobTitle,
    candidateName: booking.candidateName,
    dateKey: booking.dateKey,
    interviewerName: booking.interviewerName,
    interviewerTitle,
    location: booking.location,
    platform: booking.platform,
    startMinutes: booking.startMinutes,
    zoomJoinUrl: booking.zoomJoinUrl,
  };
}

function optionsFor(input: {
  recipient: InvitationRecipient;
  name: string;
  dial: string | null;
  facts: InvitationFacts;
  kinds: InvitationKind[];
}): InvitationMessageOption[] {
  return input.kinds.map((kind) => {
    const message = buildInvitationMessage({ facts: input.facts, kind, name: firstNameOf(input.name), recipient: input.recipient });
    return { kind, subject: message.subject, text: message.text, whatsappUrl: input.dial ? whatsAppSendUrl(input.dial, message.text) : null };
  });
}

async function loadLog(bookingId: string): Promise<InvitationLogEntry[]> {
  const { data, error } = await recruitmentDb().from(INVITATIONS).select("id,recipient,channel,kind,status,destination,detail,sent_by_hr_id,created_at").eq("booking_id", bookingId).order("created_at", { ascending: false }).limit(30);
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, string | null>>;
  const people = await loadPeople(rows.map((row) => row.sent_by_hr_id));
  return rows.map((row) => ({
    channel: row.channel as InvitationChannel,
    createdAt: String(row.created_at),
    destination: row.destination,
    detail: row.detail,
    id: String(row.id),
    kind: row.kind as InvitationKind,
    recipient: row.recipient as InvitationRecipient,
    sentByName: personName(people, row.sent_by_hr_id),
    status: row.status as InvitationLogEntry["status"],
  }));
}

type Prepared = { booking: InterviewBooking; facts: InvitationFacts; plan: InvitationPlan };

async function prepare(caller: InterviewCalendarCaller, bookingId: string): Promise<Prepared> {
  const booking = await getInterviewBooking(caller, bookingId);
  requireCalendarAccess(caller, "book", weekStartFor(booking.dateKey));

  // Read first: the candidate's invitation names the interviewer with their job title.
  const person = booking.interviewerHrId ? await interviewerContact(booking.interviewerHrId) : null;
  const facts = factsOf(booking, person?.jobTitle ?? null);
  const zoomProblem = booking.platform === "zoom" && !booking.zoomJoinUrl ? ZOOM_NOT_READY : null;

  const candidate = await candidateContact(booking);
  const candidatePlan: InvitationRecipientPlan = {
    contact: candidate.contact,
    messages: optionsFor({ dial: candidate.dial, facts, kinds: ["invitation", "company_details"], name: booking.candidateName, recipient: "candidate" }),
    name: booking.candidateName,
    problem: zoomProblem,
    recipient: "candidate",
  };

  let interviewerPlan: InvitationRecipientPlan | null = null;
  if (person) {
    const name = booking.interviewerName ?? "colleague";
    interviewerPlan = {
      contact: person.contact,
      messages: optionsFor({ dial: person.dial, facts, kinds: ["invitation"], name, recipient: "interviewer" }),
      name,
      problem: zoomProblem,
      recipient: "interviewer",
    };
  }

  return {
    booking,
    facts,
    plan: { bookingId: booking.id, candidate: candidatePlan, interviewer: interviewerPlan, log: await loadLog(booking.id), platform: booking.platform },
  };
}

/** What the invitation panel shows: who can be reached, on what, the ready-made messages, and the history. */
export async function getInterviewInvitationPlan(caller: InterviewCalendarCaller, bookingId: string): Promise<InvitationPlan> {
  return (await prepare(caller, bookingId)).plan;
}

// ── Logging ─────────────────────────────────────────────────────────────────────────────────────

async function writeLog(
  caller: InterviewCalendarCaller,
  bookingId: string,
  entry: { recipient: InvitationRecipient; channel: InvitationChannel; kind: InvitationKind; status: "sent" | "opened" | "failed"; destination: string | null; detail: string | null },
): Promise<void> {
  const { error } = await recruitmentDb().from(INVITATIONS).insert({
    booking_id: bookingId,
    channel: entry.channel,
    destination: entry.destination,
    detail: entry.detail,
    kind: entry.kind,
    recipient: entry.recipient,
    sent_by_hr_id: hrIdForStorage(caller.access.hrId),
    status: entry.status,
  });
  // The message has already gone (or been opened); a failed log line must not turn that into an error
  // the person would answer by sending it again.
  if (error) console.error("interview_invitation_log_failed", error.message);
}

export type InvitationRequest = { recipient: unknown; kind?: unknown };

function readRequest(input: InvitationRequest): { recipient: InvitationRecipient; kind: InvitationKind } {
  if (!isInvitationRecipient(input.recipient)) throw new Error("Choose who the invitation is for.");
  const kind = input.kind === undefined ? "invitation" : input.kind;
  if (!isInvitationKind(kind)) throw new Error("Choose what to send.");
  if (kind === "company_details" && input.recipient !== "candidate") throw new Error("The company details go to the candidate.");
  return { kind, recipient: input.recipient };
}

function planFor(prepared: Prepared, recipient: InvitationRecipient): InvitationRecipientPlan {
  const plan = recipient === "candidate" ? prepared.plan.candidate : prepared.plan.interviewer;
  if (!plan) throw new Error("Choose the interviewer first.");
  return plan;
}

/** The person opened the WhatsApp chat. Phoenix cannot know it was sent, so this is the log's only claim. */
export async function recordInterviewWhatsAppOpened(caller: InterviewCalendarCaller, bookingId: string, input: InvitationRequest): Promise<InvitationLogEntry[]> {
  const { kind, recipient } = readRequest(input);
  const prepared = await prepare(caller, bookingId);
  const plan = planFor(prepared, recipient);
  if (!plan.contact.whatsappDisplay) throw new Error(`${plan.name} has no WhatsApp number on file.`);
  if (kind === "invitation" && plan.problem) throw new Error(plan.problem);
  await writeLog(caller, bookingId, { channel: "whatsapp", destination: plan.contact.whatsappDisplay, detail: null, kind, recipient, status: "opened" });
  return loadLog(bookingId);
}

// ── E-mail ──────────────────────────────────────────────────────────────────────────────────────

/** E-mail the invitation from Phoenix and log what the mail provider answered. */
export async function emailInterviewInvitation(
  caller: InterviewCalendarCaller,
  bookingId: string,
  input: InvitationRequest,
): Promise<{ status: "sent" | "failed"; message: string; log: InvitationLogEntry[] }> {
  const { kind, recipient } = readRequest(input);
  const prepared = await prepare(caller, bookingId);
  const plan = planFor(prepared, recipient);
  const to = plan.contact.email;
  if (!to) throw new Error(`${plan.name} has no e-mail address on file.`);
  if (kind === "invitation" && plan.problem) throw new Error(plan.problem);

  const message = buildInvitationMessage({ facts: prepared.facts, kind, name: firstNameOf(plan.name), recipient });
  // The message's own greeting, so the e-mail says "Hello Dr Nevin" exactly as the WhatsApp text does.
  const rendered = renderInvitationEmail(message.greeting, message, kind);

  const record = (status: "sent" | "failed", detail: string | null) =>
    writeLog(caller, bookingId, { channel: "email", destination: to, detail, kind, recipient, status });

  if (!emailNotificationsEnabled()) {
    await record("failed", "E-mail sending is switched off in Phoenix.");
    return { log: await loadLog(bookingId), message: "E-mail sending is switched off in Phoenix, so nothing was sent.", status: "failed" };
  }
  // The company's own name in the inbox list, from the mailbox the Sato Email Composer sends from.
  const from = satoEmailFrom(systemEmail.satoComposerFromEmail);

  // A one-minute bucket: a double press is one e-mail, a deliberate second send a minute later is another.
  const minute = Math.floor(Date.now() / 60_000);
  const idempotencyKey = `interview-invite-${createHash("sha256").update(`${bookingId}|${recipient}|${kind}|${to.toLowerCase()}|${minute}`).digest("hex").slice(0, 40)}`;
  let outcome: Awaited<ReturnType<typeof sendPhoenixEmail>>;
  try {
    // The candidate belongs to nobody in the employee directory, and the interviewer's mailbox may be
    // one Phoenix cannot vouch for, so both are declared as intended outside recipients.
    outcome = await sendPhoenixEmail({
      externalRecipients: [to],
      from,
      html: rendered.html,
      idempotencyKey,
      // The composer's reply-to, for the reason it records: a seat-keyed address fell through to an
      // inbox Resend suppresses for a Super Admin send, and the replies bounced.
      replyTo: systemEmail.satoComposerReplyToEmail,
      subject: message.subject,
      text: rendered.text,
      to: [to],
    });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await record("failed", detail);
    return { log: await loadLog(bookingId), message: `The e-mail could not be sent: ${detail}`, status: "failed" };
  }
  if ("skipped" in outcome && outcome.skipped) {
    await record("failed", outcome.reason);
    return { log: await loadLog(bookingId), message: `The e-mail was not sent: ${outcome.reason}`, status: "failed" };
  }

  await record("sent", null);
  await recordManualEmailSendAudit({
    actor: caller.access.loginId ?? caller.access.hrId ?? null,
    bcc: [],
    cc: [],
    clientRequestId: idempotencyKey,
    externalJustification: "Interview invitation sent from the Interview Calendar",
    externalRecipients: [to],
    providerMessageId: "id" in outcome ? outcome.id ?? null : null,
    status: "sent",
    subject: message.subject,
    templateKey: "interview_calendar_invitation",
    to: [to],
  }).catch((auditError) => console.error("interview_invitation_audit_failed", auditError));
  return { log: await loadLog(bookingId), message: `E-mail sent to ${to}.`, status: "sent" };
}
