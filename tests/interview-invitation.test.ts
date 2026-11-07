import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { systemInterviewVenue } from "../src/config/system-settings.ts";
import {
  buildInvitationMessage,
  greetingName,
  invitationDate,
  invitationLogSentence,
  invitationTime,
  isInvitationChannel,
  isInvitationKind,
  isInvitationRecipient,
  type InvitationFacts,
} from "../src/lib/recruitment/interview-invitation.ts";
import { renderInvitationEmail } from "../src/lib/recruitment/interview-invitation-email.ts";
import { whatsAppSendUrl } from "../src/lib/recruitment/whatsapp-templates/send-link.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

/** The body of `function <name>(` up to the closing brace at column 0. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`function ${name}\\b`));
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end + 3);
}

/**
 * Interview invitations — the owner's request of 2026-09-19: choose the interviewer as well as the
 * candidate; one button sends the invitation to both, each by WhatsApp or by e-mail; a candidate who
 * applied on WhatsApp is written to on that same number and the interviewer on the number in
 * Employee Master; the same works for an office interview and a Zoom one; and the company's
 * location, website and LinkedIn can be sent to the candidate on their own. And: "when it comes its
 * time, the Zoom link auto opens".
 */
export async function runInterviewInvitationTests() {
  runWordingTests();
  runChannelTests();
  runWiringTests();
  runSatoTemplateTests();
}

const OFFICE: InvitationFacts = {
  candidateJobTitle: "Medical Representative",
  candidateName: "Nevin Adel",
  dateKey: "2026-09-21",
  platform: "in_office",
  startMinutes: 16 * 60,
  zoomJoinUrl: null,
};

// ── 1 · The words ─────────────────────────────────────────────────────────────────────────────
function runWordingTests() {
  assert.equal(invitationDate("2026-09-21"), "21-9-2026", "day-month-year, no leading zero");
  assert.equal(invitationDate("2026-10-05"), "5-10-2026");
  assert.equal(invitationTime(16 * 60), "04:00 PM");
  assert.equal(invitationTime(9 * 60), "09:00 AM");
  assert.equal(invitationTime(12 * 60), "12:00 PM", "noon is PM");
  assert.equal(invitationTime(0), "12:00 AM", "midnight is 12, not 0");
  assert.equal(invitationTime(13 * 60 + 30), "01:30 PM");
  assert.equal(greetingName("  Nevin   Adel Hassan "), "Nevin", "the first word");
  assert.equal(greetingName(""), "there", "never \"Hello ,\"");

  // The owner's message, character for character: an office interview to the candidate — greeted
  // "Dr" before the first name, as every candidate is (owner, 2026-10-20).
  const office = buildInvitationMessage({ facts: OFFICE, kind: "invitation", name: "Nevin", recipient: "candidate" });
  assert.equal(
    office.text,
    [
      "Hello Dr Nevin",
      "",
      "Kindly find below the interview details.",
      "",
      "• Date: 21-9-2026",
      "• Time: 04:00 PM",
      "",
      "• Location: https://maps.app.goo.gl/35pPjSAQt3HsG3eE7",
      "",
      "• Address: عقار رقم ٨ نموذج ن مربع ١٢٥٨ الدور التانى - ش عبدالحميد بدوى بجوار حزب مستقبل وطن - شيراتون",
      "",
      "• LinkedIn : https://linkedin.com/company/sato-pharma-careers",
      "",
      "• Website : www.satopharma.com",
    ].join("\n"),
    "an office invitation is the owner's own wording",
  );
  assert.equal(office.action?.href, systemInterviewVenue.mapUrl, "and the e-mail's button opens the map");
  assert.equal(office.greeting, "Dr Nevin", "the e-mail greets with the same name the text does");
  assert.equal(buildInvitationMessage({ facts: OFFICE, kind: "invitation", name: "", recipient: "candidate" }).greeting, "there", "no name is \"Hello there\", never \"Hello Dr there\"");
  assert.equal(office.subject, "Interview invitation — Sato Pharma, 21-9-2026", "with no interviewer chosen the subject names none");
  assert.doesNotMatch(office.text, /Interviewer:/, "and the text has no empty interviewer line");

  // The interviewer the candidate will meet, in the owner's own format, and in the subject (owner,
  // 2026-10-20: "add the interviewer name in the invitation and title").
  const withInterviewer = buildInvitationMessage({
    facts: { ...OFFICE, interviewerName: "Ahmed Nour", interviewerTitle: "Senior HR Manager" },
    kind: "invitation",
    name: "Nevin",
    recipient: "candidate",
  });
  assert.match(withInterviewer.text, /• Date: 21-9-2026\n• Time: 04:00 PM\n\n• Interviewer: Ahmed Nour \(Senior HR Manager\)\n\n• Location: /, "after the time, on its own line, name and title");
  assert.equal(withInterviewer.subject, "Interview invitation with Ahmed Nour — Sato Pharma, 21-9-2026", "the subject names the interviewer");
  assert.ok(withInterviewer.rows.some((row) => row.label === "Interviewer" && row.value === "Ahmed Nour (Senior HR Manager)"), "and the e-mail's table carries the same line");
  const untitled = buildInvitationMessage({ facts: { ...OFFICE, interviewerName: "Ahmed Nour", interviewerTitle: null }, kind: "invitation", name: "Nevin", recipient: "candidate" });
  assert.match(untitled.text, /• Interviewer: Ahmed Nour\n/, "an interviewer with no job title on file is named without empty brackets");

  // Zoom swaps the place for the link — no office address on an online interview.
  const zoom = buildInvitationMessage({
    facts: { ...OFFICE, platform: "zoom", zoomJoinUrl: "https://zoom.us/j/123456789" },
    kind: "invitation",
    name: "Nevin",
    recipient: "candidate",
  });
  assert.match(zoom.text, /• Zoom link: https:\/\/zoom\.us\/j\/123456789/, "a Zoom interview carries its link");
  assert.doesNotMatch(zoom.text, /Location:|Address:/, "and no office address");
  assert.match(zoom.text, /• LinkedIn : /, "but keeps LinkedIn");
  assert.match(zoom.text, /• Website : /, "and the website");
  assert.equal(zoom.action?.href, "https://zoom.us/j/123456789", "the e-mail's button joins the meeting");

  // A phone call (the Medical Rep 1st interview's third way, owner 7 Nov 2026): no place, no link, no
  // map button — the candidate is told we will call, the interviewer to call.
  const phoneCall = buildInvitationMessage({ facts: { ...OFFICE, location: "Head office", platform: "phone" }, kind: "invitation", name: "Nevin", recipient: "candidate" });
  assert.match(phoneCall.text, /• Interview: By phone call — we will call you at this time/, "the candidate is told we will call");
  assert.doesNotMatch(phoneCall.text, /Location:|Address:|Zoom link:/, "and given no place or link");
  assert.equal(phoneCall.action, null, "no map button and no meeting to join");
  const phoneInterviewer = buildInvitationMessage({ facts: { ...OFFICE, platform: "phone" }, kind: "invitation", name: "Omar", recipient: "interviewer" });
  assert.match(phoneInterviewer.text, /• Interview: By phone call — call the candidate at this time/, "the interviewer is told to call");

  // Zoom with no link yet has nothing to point at — the panel refuses to send it (see below).
  const noLink = buildInvitationMessage({ facts: { ...OFFICE, platform: "zoom" }, kind: "invitation", name: "Nevin", recipient: "candidate" });
  assert.equal(noLink.action, null);

  // The interviewer is told WHO they are meeting.
  const interviewer = buildInvitationMessage({ facts: OFFICE, kind: "invitation", name: "Omar", recipient: "interviewer" });
  assert.match(interviewer.text, /^Hello Omar\n/, "a colleague is greeted by the plain first name — the \"Dr\" is for candidates");
  assert.match(interviewer.text, /• Candidate: Nevin Adel/);
  assert.match(interviewer.text, /• Applied for: Medical Representative/);
  assert.match(interviewer.text, /• Date: 21-9-2026\n• Time: 04:00 PM/);
  assert.doesNotMatch(interviewer.text, /LinkedIn|Website/, "the company's own page is not sent to its own employee");

  // The company details on their own: location, address, LinkedIn, website — no date.
  const company = buildInvitationMessage({ facts: OFFICE, kind: "company_details", name: "Nevin", recipient: "candidate" });
  assert.match(company.text, /Location: https:\/\/maps\.app\.goo\.gl\/35pPjSAQt3HsG3eE7/);
  assert.match(company.text, /Address: /);
  assert.match(company.text, /LinkedIn : https:\/\/linkedin\.com\/company\/sato-pharma-careers/);
  assert.match(company.text, /Website : www\.satopharma\.com/);
  assert.doesNotMatch(company.text, /Date:|Time:/, "company details carry no interview time");
  assert.deepEqual(
    company.rows.map((row) => row.label),
    ["Location", "Address", "LinkedIn", "Website"],
    "the e-mail's table has clean labels",
  );
  assert.ok(office.subject.length > 0 && zoom.subject.length > 0 && company.subject.length > 0, "every message has a subject");
}

// ── 2 · Channels ──────────────────────────────────────────────────────────────────────────────
function runChannelTests() {
  assert.ok(isInvitationChannel("whatsapp") && isInvitationChannel("email") && !isInvitationChannel("sms"));
  assert.ok(isInvitationRecipient("candidate") && isInvitationRecipient("interviewer") && !isInvitationRecipient("manager"));
  assert.ok(isInvitationKind("invitation") && isInvitationKind("company_details") && !isInvitationKind("cv"));

  // The chat opens with the WHOLE message, Arabic and the map's own & and ? intact.
  const text = buildInvitationMessage({ facts: OFFICE, kind: "invitation", name: "Nevin", recipient: "candidate" }).text;
  const url = new URL(whatsAppSendUrl("01012345678", text));
  assert.equal(url.origin + url.pathname, "https://wa.me/201012345678", "an Egyptian mobile is repaired to its international form");
  assert.equal(url.searchParams.get("text"), text, "the message survives the link unchanged");

  // WhatsApp is only ever "opened": Phoenix cannot see the press on Send. E-mail is sent or failed.
  assert.equal(invitationLogSentence({ channel: "whatsapp", destination: "+20 10 1234 5678", detail: null, status: "opened" }), "WhatsApp opened for +20 10 1234 5678");
  assert.doesNotMatch(invitationLogSentence({ channel: "whatsapp", destination: null, detail: null, status: "opened" }), /sent/i, "never claims a WhatsApp was sent");
  assert.equal(invitationLogSentence({ channel: "email", destination: "nevin@example.com", detail: null, status: "sent" }), "E-mail sent to nevin@example.com");
  assert.match(invitationLogSentence({ channel: "email", destination: "nevin@example.com", detail: "Mailbox full", status: "failed" }), /failed.*Mailbox full/);
}

// ── 3 · Who can do what, and where the numbers come from ──────────────────────────────────────
function runWiringTests() {
  const invitations = stripComments(read("src/lib/recruitment/interview-invitations.ts"));
  const calendar = stripComments(read("src/lib/recruitment/interview-calendar.ts"));
  const loader = stripComments(read("src/lib/recruitment/whatsapp-applicants-loader.ts"));

  // The gate: book level on the interview's own week, before anything is read or sent.
  const prepare = functionBody(invitations, "prepare");
  assert.match(prepare, /requireCalendarAccess\(caller, "book", weekStartFor\(booking\.dateKey\)\)/, "an invitation needs the book level");
  for (const name of ["getInterviewInvitationPlan", "emailInterviewInvitation", "recordInterviewWhatsAppOpened"]) {
    assert.match(functionBody(invitations, name), /await prepare\(caller, bookingId\)|prepare\(caller, bookingId\)/, `${name} goes through the gate`);
  }

  // WhatsApp is logged as opened and never as sent; e-mail is logged as the provider answered.
  const opened = functionBody(invitations, "recordInterviewWhatsAppOpened");
  assert.match(opened, /status: "opened"/);
  assert.doesNotMatch(opened, /"sent"/, "a WhatsApp is never logged as sent");
  const emailed = functionBody(invitations, "emailInterviewInvitation");
  assert.match(emailed, /record\("sent", null\)/, "an e-mail the provider took is logged sent");
  assert.match(emailed, /record\("failed"/, "and a refusal is logged failed");
  assert.match(emailed, /externalRecipients: \[to\]/, "the recipient is declared to the mail guard");
  assert.match(emailed, /recordManualEmailSendAudit\(/, "and audited like every manual e-mail");

  // The candidate: the WhatsApp they applied on first, then their record's WhatsApp, then their phone.
  const candidate = functionBody(invitations, "candidateContact");
  assert.ok(
    candidate.indexOf("findWhatsAppApplicantNumber") < candidate.indexOf("row.whatsapp") && candidate.indexOf("row.whatsapp") < candidate.indexOf("row.phone"),
    "applied-on WhatsApp, then the record's WhatsApp, then the phone",
  );
  // A number that sent CVs for several people is a forwarder's — never the candidate's.
  const applied = functionBody(loader, "findWhatsAppApplicantNumber");
  assert.match(applied, /applied_candidate_id/, "read from the conversation the bot wrote onto");
  assert.match(applied, /people\.delete\(candidateId\)[\s\S]*people\.size === 0/, "a forwarder's number is refused");
  // The interviewer: Employee Master.
  assert.match(functionBody(invitations, "interviewerContact"), /"employees"[\s\S]*mobile_number,work_email,job_title/, "the interviewer's number, e-mail and job title are Employee Master's");
  assert.match(functionBody(invitations, "prepare"), /factsOf\(booking, person\?\.jobTitle \?\? null\)/, "the candidate's invitation is built with the interviewer's job title");
  assert.match(functionBody(invitations, "emailInterviewInvitation"), /renderInvitationEmail\(message\.greeting, message, kind\)/, "the e-mail greets with the message's own (titled) name");

  // The interviewer is checked against Employee Master before it is stored.
  assert.match(functionBody(calendar, "resolveInterviewer"), /loadPeople\(/, "an interviewer must be a real employee");
  assert.match(functionBody(calendar, "createInterviewBooking"), /interviewer_hr_id: interviewerHrId \?\? null/, "a booking stores its interviewer");
  assert.match(functionBody(calendar, "updateInterviewBooking"), /interviewerColumn/, "and a move can change it");
  assert.match(functionBody(calendar, "searchInterviewCalendarPeople"), /if \(purpose === "interviewer"\) assertMayPickInterviewer\(caller\);\s*else requireCalendarAccess\(caller, "share", null\)/, "anyone who can book OR request can search for an interviewer; only the owner searches to share");

  // Zoom opens for THEIR interviews only: the chosen interviewer, or the owner when none is chosen.
  const due = functionBody(calendar, "listDueZoomInterviews");
  assert.match(due, /chosen \? chosen === viewer : caller\.own === "owner"/, "someone the calendar is merely shared with is never sent to a meeting that is not theirs");
  assert.match(due, /booking\.platform !== "zoom" \|\| !booking\.zoomJoinUrl \|\| booking\.ended/, "only a live Zoom meeting");
  assert.match(due, /seen\.has\(booking\.zoomJoinUrl\)/, "a session's slots share one link and open one tab");
  assert.match(due, /openUrl: hostUrl \?\? booking\.zoomJoinUrl/, "the interviewer is sent the HOST link so the meeting starts itself, the guest link only when Zoom will not give it");

  // The screen polls, opens once per interview, and says so when the browser blocks the tab.
  const auto = stripComments(read("src/components/recruitment/interview-calendar/zoom-auto-open.tsx"));
  assert.match(auto, /api\.get\("\/zoom-due"\)/, "it asks the server which are starting");
  assert.match(auto, /rememberOpened\(key\)/, "each interview opens once");
  assert.match(auto, /Join Zoom now/, "a blocked pop-up is said out loud, with a button");
  assert.doesNotMatch(auto, /joinUrl/, "the screen opens what the server chose (openUrl), never the guest link directly");
  assert.doesNotMatch(auto, /window\.open\([^)]*noopener/, "the open is not made with noopener, which answers null even when the tab opened");
  assert.match(stripComments(read("src/components/recruitment/interview-calendar/interview-calendar-view.tsx")), /link \? null : <ZoomAutoOpen api=\{api\} \/>/, "it runs inside Phoenix, not on a copy link");

  // The tables: the log is service-role only, and WhatsApp's "opened" is a value the table knows.
  const migration = read("supabase/migrations/20260919212712_interview_interviewer_and_invitations.sql").replace(/--[^\n]*/g, "");
  assert.match(migration, /alter table public\.ats_interview_invitations enable row level security;/);
  assert.match(migration, /revoke all on table public\.ats_interview_invitations from anon, authenticated;/);
  assert.doesNotMatch(migration, /grant [^;]* to (anon|authenticated)/i);
  assert.match(migration, /status in \('sent', 'opened', 'failed'\)/);
  assert.match(migration, /add column if not exists interviewer_hr_id text/);
}

// ── 4 · The e-mail wears the SATO template ────────────────────────────────────────────────────
// Owner, 2026-09-19: "I want the emails that are fired in this module to be fired in the SATO template."
function runSatoTemplateTests() {
  const invitation = buildInvitationMessage({ facts: OFFICE, kind: "invitation", name: "Nevin", recipient: "candidate" });
  const { html: mail, text } = renderInvitationEmail("Nevin", invitation, "invitation");

  // The house letter: the Sato mark, the standard, the masthead's own label — and nothing Phoenix.
  assert.match(mail, /sato-pharma-logo-on-light\.png/, "the Sato mark, the on-light file");
  assert.match(mail, /SATO-DIS-2026-01 v1\.0/, "the house standard");
  assert.match(mail, />Interview invitation</, "the masthead names what this is");
  assert.doesNotMatch(mail, /Company announcement/, "not the composer's distribution-list label");
  assert.doesNotMatch(mail, /distribution list/, "and not its distribution-list footnote");
  assert.match(mail, /sent to you personally by Sato Pharma Human Resources/, "a one-to-one notice says so");
  assert.ok(!/phoenix/i.test(mail.replace(/<[^>]+>/g, " ")), "nothing a reader sees says Phoenix");
  assert.ok(!/phoenix/i.test(text), "nor the plain-text part");
  assert.doesNotMatch(mail, /border-radius/, "square edges");

  // The details are the house's zebra table, and the owner's facts are in it.
  assert.match(mail, /<strong>Date<\/strong>/);
  assert.match(mail, /21-9-2026/);
  assert.match(mail, /04:00 PM/);
  assert.match(mail, /عقار رقم ٨/, "the Arabic address survives");
  assert.match(mail, /href="https:\/\/maps\.app\.goo\.gl\/35pPjSAQt3HsG3eE7"/, "the map is a link");
  assert.match(mail, /href="https:\/\/www\.satopharma\.com"/, "a bare www address becomes a link");
  assert.match(mail, /Open the location on the map/, "the one action is a plain link");
  assert.match(text, /^Interview invitation — Sato Pharma/, "the plain-text part opens on the subject");
  assert.match(text, /Regards,\nHuman Resources/);

  // Company details on their own carry their own label and no "look forward" closing.
  const company = renderInvitationEmail("Nevin", buildInvitationMessage({ facts: OFFICE, kind: "company_details", name: "Nevin", recipient: "candidate" }), "company_details");
  assert.match(company.html, />Company details</);
  assert.doesNotMatch(company.html, /We look forward to meeting you/);

  // A name is text, never markup.
  const hostile = renderInvitationEmail("<script>x</script>", invitation, "invitation");
  assert.doesNotMatch(hostile.html, /<script>x/, "the greeting is escaped");

  // Wiring: the sender goes through the house renderer and the composer's From and Reply-To, and no
  // longer through the Phoenix shell.
  const invitations = stripComments(read("src/lib/recruitment/interview-invitations.ts"));
  assert.match(invitations, /renderInvitationEmail\(/, "the send renders the SATO template");
  assert.doesNotMatch(invitations, /renderPhoenixEmail|phoenix-email-layout/, "and never the Phoenix shell");
  assert.match(invitations, /satoEmailFrom\(systemEmail\.satoComposerFromEmail\)/, "sent as Sato Pharma, from the composer's mailbox");
  assert.match(invitations, /replyTo: systemEmail\.satoComposerReplyToEmail/, "replies reach the composer's reply-to, not a seat address that can be suppressed");
  const shell = stripComments(read("src/lib/sato-email/render.ts"));
  assert.match(shell, /kicker\?: string;/, "the template takes its own masthead label");
  assert.match(shell, /footnote\?: string;/, "and its own footnote");
}
