import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { AR_MESSAGES } from "../src/components/offers/joining-form-copy.ts";
import { defaultOfferBlocks } from "../src/lib/offers/default-template.ts";
import { JOINING_FORM_STATE_MESSAGE, joiningFormState } from "../src/lib/offers/joining-form.ts";
import { renderOfferEmail } from "../src/lib/offers/render-email.ts";
import {
  OFFER_EMAIL_MESSAGE_MAX,
  cairoLongDate,
  normalizeOfferEmailMessage,
  offerIdempotencyKeyFor,
  offerIsBeingUpdated,
  offerRevisionCancelRefusal,
  offerRevisionRefusal,
  offerSubjectFor,
  offerUpdateNote,
  offerVersionLabel,
} from "../src/lib/offers/revision-rules.ts";
import type { OfferFields } from "../src/lib/offers/types.ts";

/**
 * Three asks from the owner, 2026-11-10, verbatim:
 *
 *   "add a coloumn to show the job offer was sent by whom .... also add a field for the HR to write
 *    whatever he wants and this goes in the job offer email body of the job offer .... also make an
 *    option for the updated job offer i may need to update a job offer"
 *
 * These pin the "Sent by" column, HR's message in the EMAIL body (never the PDF), and the updated
 * offer: the same row, the sent version kept, and the update reaching the candidate only through Send.
 */

const FIELDS: OfferFields = {
  candidateEmail: "samaa@example.com",
  candidateName: "SAMAA SHALABY",
  contractTerm: "One year, renewable",
  costOfLiving: 3500,
  dateOfIssue: "10 November 2026",
  reference: "SP-HR-MR-2026-090",
  reportsTo: "District Manager",
  roleSummary: "",
  salutationName: "Dr SAMAA SHALABY",
  startDate: "1 December 2026",
  territory: "Delta 3",
  title: "Medical Representative",
  totalMonthly: 20000,
  validUntil: "17 November 2026",
};

export async function runOfferEmailMessageAndUpdateTests() {
  // ── 1. The message is plain text, tidied, capped ───────────────────────────────────────────────
  assert.deepEqual(normalizeOfferEmailMessage("  \r\n Hello Samaa,\r\n\r\n\r\n\r\nWelcome aboard.  \r\n "), {
    message: "Hello Samaa,\n\nWelcome aboard.",
    problem: null,
  });
  assert.deepEqual(normalizeOfferEmailMessage("   "), { message: null, problem: null }, "blank is no message");
  assert.deepEqual(normalizeOfferEmailMessage(undefined), { message: null, problem: null });
  assert.match(normalizeOfferEmailMessage("x".repeat(OFFER_EMAIL_MESSAGE_MAX + 1)).problem ?? "", /most it can be is 2000/);
  assert.equal(normalizeOfferEmailMessage("x".repeat(OFFER_EMAIL_MESSAGE_MAX)).problem, null);

  // ── 2. It prints at the TOP of the email body, escaped, and in the text part ──────────────────
  const blocks = defaultOfferBlocks();
  const message = "Dear Samaa,\n\nWe are delighted. <script>alert(1)</script>\nSee you soon & welcome.";
  const email = renderOfferEmail({ blocks, theme: {} }, FIELDS, { message });
  assert.ok(email.html.includes("We are delighted. &lt;script&gt;alert(1)&lt;/script&gt;<br>See you soon &amp; welcome."), "typed text prints as typed, never as markup");
  assert.ok(!email.html.includes("<script>"), "nothing HR types becomes a tag in a stranger's inbox");
  // Measured inside <body>: the document's own <title> also reads "Offer of Employment".
  const body = email.html.slice(email.html.indexOf("<body"));
  const at = body.indexOf("Dear Samaa,");
  const titleWords = String((blocks.find((block) => block.type === "title")?.props as { h1?: string } | undefined)?.h1 ?? "");
  assert.ok(at > -1 && titleWords && body.indexOf(titleWords) > at, "the message sits above the letter's first words");
  assert.ok(email.text.includes("Dear Samaa,\n\nWe are delighted."), "the plain-text part carries the same words");
  assert.ok(email.text.indexOf("Dear Samaa,") < email.text.indexOf(titleWords.toUpperCase()), "and in the same place");
  const plain = renderOfferEmail({ blocks, theme: {} }, FIELDS);
  assert.ok(!plain.html.includes("border-bottom:1px solid") || plain.html.length < email.html.length, "no message, no cover note");

  // ── 3. Never on the PDF letter ────────────────────────────────────────────────────────────────
  for (const file of ["src/lib/offers/render.ts", "src/lib/offers/pdf.ts"]) {
    assert.ok(!stripComments(readFileSync(file, "utf8")).includes("emailMessage"), `${file} never prints HR's email message`);
  }
  const send = stripComments(readFileSync("src/lib/offers/send.ts", "utf8"));
  assert.match(send, /message: offer\.emailMessage\?\.trim\(\) \|\| undefined/, "the send hands the stored message to the email renderer");

  // ── 4. The updated offer, as the candidate sees it ────────────────────────────────────────────
  assert.equal(offerSubjectFor("Medical Representative"), "Offer of Employment — Medical Representative");
  assert.equal(offerSubjectFor("Medical Representative", 1), "Updated Offer of Employment — Medical Representative");
  assert.equal(offerIdempotencyKeyFor("OFFER-1"), "offer-letter:OFFER-1", "a first send keeps the key it always had");
  assert.equal(offerIdempotencyKeyFor("OFFER-1", 2), "offer-letter:OFFER-1:rev:2", "an update never re-uses a key the provider would answer with the old letter");
  assert.equal(cairoLongDate("2026-11-02T23:30:00Z"), "3 November 2026", "read on Cairo's calendar, not UTC's");
  assert.equal(cairoLongDate("not a date"), "");
  assert.match(offerUpdateNote("2026-11-03T08:00:00Z"), /replaces the offer we sent you on 3 November 2026/);
  const updated = renderOfferEmail({ blocks, theme: {} }, FIELDS, { updateNote: offerUpdateNote("2026-11-03T08:00:00Z") });
  assert.ok(updated.html.includes("This is an updated offer.") && updated.text.includes("This is an updated offer."));
  assert.match(send, /idempotencyKey: offerIdempotencyKey\(offer\.id, offer\.revision \?\? 0\)/);
  assert.match(send, /offerUpdateNote\(history\[history\.length - 1\]\?\.sentAt \?\? null\)/, "the note names the version it replaces");
  assert.equal(offerVersionLabel(1), "2nd version");
  assert.equal(offerVersionLabel(2), "3rd version");
  assert.equal(offerVersionLabel(10), "11th version");

  // ── 5. Who can update what ────────────────────────────────────────────────────────────────────
  const snapshot = { blocks: [], fontFamily: "Inter", fontSizePt: 11, theme: {}, variant: "classic" } as never;
  const sent = { candidateEmail: "c@example.com", status: "sent" as const, templateSnapshot: snapshot };
  assert.equal(offerRevisionRefusal(sent), null, "a sent, unanswered offer can be updated");
  assert.ok(offerRevisionRefusal({ ...sent, employeeHrId: "MR-500" }), "never once the joining form made the employee");
  for (const status of ["draft", "pending_approval", "accepted", "declined", "withdrawn"] as const) {
    assert.ok(offerRevisionRefusal({ ...sent, status }), `a ${status} offer is not updated`);
  }
  assert.ok(offerRevisionRefusal({ ...sent, templateSnapshot: null }), "without the sent letter there is nothing to keep");
  assert.equal(offerRevisionCancelRefusal({ revision: 1, revisionHistory: [{}], status: "draft" }), null);
  assert.ok(offerRevisionCancelRefusal({ revision: 0, revisionHistory: [], status: "draft" }), "a plain draft has nothing to cancel");
  assert.ok(offerRevisionCancelRefusal({ revision: 1, revisionHistory: [{}], status: "pending_approval" }), "a waiting update is rejected first");
  assert.ok(offerRevisionCancelRefusal({ revision: 1, revisionHistory: [{}], status: "sent" }), "a sent update cannot be cancelled");
  assert.equal(offerIsBeingUpdated({ revision: 1, status: "draft" }), true);
  assert.equal(offerIsBeingUpdated({ revision: 1, status: "pending_approval" }), true);
  assert.equal(offerIsBeingUpdated({ revision: 1, status: "sent" }), false);
  assert.equal(offerIsBeingUpdated({ revision: 0, status: "draft" }), false);

  // ── 6. The candidate's old link, while the update is written ─────────────────────────────────
  const base = { employeeHrId: null, requiresSeat: false, seatOpen: true };
  assert.equal(joiningFormState({ ...base, revision: 1, status: "draft" }), "being_updated", "old terms cannot be accepted mid-update");
  assert.equal(joiningFormState({ ...base, revision: 1, status: "pending_approval" }), "being_updated");
  assert.equal(joiningFormState({ ...base, revision: 0, status: "draft" }), "not_sent", "a never-sent draft is unchanged");
  assert.equal(joiningFormState({ ...base, revision: 1, status: "sent" }), "open", "once the update goes, the same link opens it");
  const notice = JOINING_FORM_STATE_MESSAGE.being_updated;
  assert.ok(AR_MESSAGES[notice.title] && AR_MESSAGES[notice.body], "the notice has its Arabic line");
  assert.match(stripComments(readFileSync("src/lib/offers/joining-form-service.ts", "utf8")), /revision: offer\.revision \?\? 0/);

  // ── 7. The data layer keeps the sent version, conditionally ──────────────────────────────────
  const service = stripComments(readFileSync("src/lib/offers/service.ts", "utf8"));
  const start = service.slice(service.indexOf("export async function startOfferRevision("), service.indexOf("export async function cancelOfferRevision("));
  assert.match(start, /offerRevisionRefusal\(current\)/);
  assert.match(start, /revision_history: \[\.\.\.\(current\.revisionHistory \?\? \[\]\), entry\]/, "the sent version is appended, never overwritten");
  assert.match(start, /status: "draft"/);
  assert.match(start, /\.eq\("status", "sent"\)[\s\S]*\.eq\("revision", revision\)/, "two presses cannot each freeze a copy");
  assert.match(start, /templateSnapshot: current\.templateSnapshot/, "the letter as sent is kept");
  const cancel = service.slice(service.indexOf("export async function cancelOfferRevision("), service.indexOf("export async function markOfferSent("));
  assert.match(cancel, /status: "sent"/);
  assert.match(cancel, /template_snapshot: previous\.templateSnapshot/);
  assert.match(cancel, /sent_at: previous\.sentAt/, "the version comes back with its own send date");
  assert.match(cancel, /\.eq\("status", "draft"\)/, "a sent update is never rolled back");
  const update = service.slice(service.indexOf("export async function updateOffer("), service.indexOf("export function offerEditRefusal("));
  assert.match(update, /patch\.email_message = fields\.emailMessage \|\| null/);

  // ── 8. The update route emails nobody and is registered ──────────────────────────────────────
  const route = stripComments(readFileSync("app/api/offers/[id]/revise/route.ts", "utf8"));
  assert.match(route, /assertSameOriginMutation\(request\)/);
  assert.match(route, /assertPermission\(access, "offers", "create"\)/, "Send's own grant");
  assert.match(route, /writeRequiredAuditLog\(/);
  assert.ok(!route.includes("sendOfferEmail") && !route.includes("sendPhoenixEmail"), "starting or cancelling an update emails nobody");
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(registry, /pattern: "\/api\/offers\/:id\/revise", permission: \{ resource: "offers", action: "create" \}/);
  for (const file of ["app/api/offers/route.ts", "app/api/offers/[id]/route.ts"]) {
    assert.match(stripComments(readFileSync(file, "utf8")), /normalizeOfferEmailMessage\(body\.emailMessage\)/, `${file} judges the message before saving it`);
  }

  // ── 9. The screen ────────────────────────────────────────────────────────────────────────────
  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  assert.match(composer, /\["Candidate", "Title", "Package", "Status", "Sent", "Sent by", ""\]/, "the Sent by column");
  const cols = composer.slice(composer.indexOf("<colgroup>"), composer.indexOf("</colgroup>"));
  const widths = [...cols.matchAll(/w-\[(\d+)%\]/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 7, "one column per heading");
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "the columns fill the table exactly — never a sideways scroll");
  assert.match(composer, /colSpan=\{7\}/);
  assert.equal((composer.match(/<OfferSentBy offer=\{offer\} people=\{people\} \/>/g) ?? []).length, 2, "the desktop row and the phone card");
  assert.match(composer, /id="offer-email-message"/);
  assert.match(composer, /maxLength=\{OFFER_EMAIL_MESSAGE_MAX\}/);
  assert.match(composer, /emailMessage: draft\.emailMessage/, "the message is saved with the draft, so the HR Manager approves it");
  const updateLabel = "<FilePenLine className=\"h-3.5 w-3.5\" /> Update offer";
  assert.equal(composer.split(updateLabel).length - 1, 2, "Update offer on the desktop row and the phone card");
  for (let at = composer.indexOf(updateLabel); at > -1; at = composer.indexOf(updateLabel, at + 1)) {
    const gate = composer.lastIndexOf('canManage && offer.status === "sent"', at);
    assert.ok(gate > -1 && composer.indexOf(") : null}", gate) > at, "only a manager, only on a sent offer");
  }
  assert.match(composer, /call\(`\/api\/offers\/\$\{offer\.id\}\/revise`, "POST", \{ action: "start" \}\)/);
  for (const page of ["app/(admin)/offers/page.tsx", "app/employee-portals/offers/page.tsx"]) {
    const source = readFileSync(page, "utf8");
    assert.match(source, /loadOffersWorkspace\(\{ viewerHrId \}\)/, `${page} names the viewer too`);
    assert.match(source, /people=\{workspace\.people\}/, `${page} hands the names down`);
  }
  assert.match(readFileSync("src/lib/offers/workspace.ts", "utf8"), /loadOfferPeopleNames\(offers, \[options\.viewerHrId\]\)/);

  // ── 10. The database admits it ───────────────────────────────────────────────────────────────
  const migration = readFileSync("supabase/migrations/20261110195450_offer_email_message_and_revisions.sql", "utf8");
  for (const column of ["email_message text", "revision integer not null default 0", "revision_history jsonb not null default '[]'::jsonb", "revised_at timestamptz", "revised_by text"]) {
    assert.ok(migration.includes(column), `the migration adds ${column}`);
  }
}
