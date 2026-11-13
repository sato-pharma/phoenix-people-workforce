import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDirectEmailPayload,
  directEmailSentPayload,
  durableEmailDedupeKey,
  isDirectEmailPayload,
  sendDirectEmailMessage,
  type DurableEmailMessage,
} from "../src/lib/notifications/direct-email-payload.ts";
import { runDurableEmail, type DurableEmailDeps } from "../src/lib/notifications/durable-email.ts";
import { classifyDirectEmailSkip, type NotificationOutboxRow } from "../src/lib/notifications/email.ts";
import { assessDrainHealth, describeDrainHealth } from "../src/lib/notifications/drain-health.ts";

// APPROVAL EMAILS SURVIVE A PROVIDER FAILURE (REC-048, 13 Nov 2026).
//
// The leave emails (request, hand-off, step result, final decision, returned, balance settlement)
// and the two background recruitment emails (interview invitation, interview feedback) were sent
// straight to the provider: a failure lost the email and nobody saw it. Each now writes a
// notification_outbox row first and the drain retries it with the SAME sender and the SAME input —
// never the standard notification path, which adds the manager CC and swaps templates. Not one
// recipient, subject, template or body changes.

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** The text of one top-level function, from its declaration to the next top-level declaration. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must still exist`);
  const rest = text.slice(start + declaration.length);
  const next = rest.search(/\n(?:export )?(?:async )?(?:function|type|const) /);
  return next === -1 ? rest : rest.slice(0, next);
}

function count(text: string, needle: string) {
  return text.split(needle).length - 1;
}

const templatedMessage: DurableEmailMessage = {
  input: {
    context: { managerName: "Mona", subject: "Vacation request from Ahmed" },
    employeeHrId: "A-1",
    fallbackTo: ["manager@satopharma.com"],
    overrides: { cc: ["hr@satopharma.com"], replaceRecipients: true, to: ["manager@satopharma.com"] },
    templateKey: "leave_request",
  },
  sender: "templated",
};

const phoenixMessage: DurableEmailMessage = {
  input: {
    cc: ["hr@satopharma.com"],
    html: "<p>Body</p>",
    idempotencyKey: "vacation:r1:returned:employee:a@satopharma.com",
    origin: { employeeHrId: "A-1", eventType: "vacation_returned", module: "vacation" },
    subject: "Vacation request returned for revision",
    text: "Body",
    to: ["a@satopharma.com"],
  },
  sender: "phoenix",
};

function testEveryInScopeCallSiteGoesThroughTheDurableHelper() {
  const vacationEmail = source("src/lib/vacation/email.ts");
  assert.equal(count(vacationEmail, "sendTemplatedEmail("), 0, "no leave email may call sendTemplatedEmail directly any more");
  assert.equal(count(vacationEmail, "sendPhoenixEmail("), 0, "no leave email may call sendPhoenixEmail directly any more");

  // Each leave email has a template send and a plain fallback; both are durable and both carry a key.
  for (const sender of [
    "export async function sendVacationManagerDecisionEmail(",
    "export async function sendVacationDecisionResultEmail(",
    "export async function sendVacationManagerStepResultEmail(",
    "export async function sendVacationBalanceSettlementEmail(",
    "export async function sendVacationReturnedEmail(",
  ]) {
    const body = functionBody(vacationEmail, sender);
    assert.equal(count(body, "sendDurableEmail("), 2, `${sender} must send both its template and its fallback through sendDurableEmail`);
    assert.equal(count(body, "{ dedupeKey:"), 2, `${sender} must pass its own dedupe key on both sends`);
    assert.ok(body.includes('sender: "templated"') && body.includes('sender: "phoenix"'), `${sender} keeps its own two senders`);
  }

  // The service still reaches the leave emails only through those five senders, and settles balances
  // through the settlement sender — so every in-scope call site is covered by the assertions above.
  const service = source("src/lib/vacation/service.ts");
  assert.equal(count(service, "sendTemplatedEmail("), 0, "the leave service sends no templated email of its own");
  assert.equal(count(service, "sendPhoenixEmail("), 0, "the leave service sends no plain email of its own");
  assert.equal(count(service, "sendVacationManagerDecisionEmail({"), 2, "request (on submit) and next-approver hand-off");
  assert.equal(count(service, "sendVacationManagerStepResultEmail({"), 1, "step result");
  assert.equal(count(service, "sendVacationDecisionResultEmail({"), 1, "final decision");
  assert.equal(count(service, "sendVacationReturnedEmail({"), 1, "returned for revision");
  assert.ok(
    source("src/lib/payroll/copilot/vacation-settlement.ts").includes("await sendVacationBalanceSettlementEmail({"),
    "the balance settlement email still goes through its leave sender",
  );

  const interviewNotices = source("src/lib/recruitment/interview-notifications.ts");
  assert.equal(count(interviewNotices, "sendTemplatedEmail("), 0, "the interview emails no longer call sendTemplatedEmail directly");
  assert.equal(count(interviewNotices, "sendDurableEmail("), 2, "the interview invitation and the interview feedback are durable");
  assert.ok(interviewNotices.includes("dedupeKey: `recruitment:interview_invitation:${interview.id}:${kind}:${interview.updatedAt}`"),
    "the invitation's key names the interview, the kind and the version, so a reschedule is a new email and a retry is not");
  assert.ok(interviewNotices.includes("dedupeKey: `recruitment:interview_feedback:"), "the feedback email passes its own key");

  // A failed interview notice is recorded, never swallowed by an empty catch.
  const interviews = source("src/lib/recruitment/interviews.ts");
  assert.doesNotMatch(functionBody(interviews, "async function notifyInterview("), /catch\s*\{/,
    "an interview notice failure must never vanish into an empty catch");
  const feedbackNotice = interviews.slice(interviews.indexOf('afterResponse("interview_notice:feedback"'));
  assert.doesNotMatch(feedbackNotice.slice(0, 900), /catch\s*\{/, "nor the interview feedback notice's failure");
  assert.ok(interviews.includes('event: "interview_notification_failed"'), "a failed interview notice is logged by name");
  assert.ok(interviews.includes('event: "interview_feedback_notification_failed"'), "a failed feedback notice is logged by name");
}

async function testTheStoredInputGoesBackToItsOwnSenderUnchanged() {
  const calls: Array<{ input: unknown; sender: string }> = [];
  const senders = {
    sendPhoenixEmail: async (input: unknown) => {
      calls.push({ input, sender: "phoenix" });
      return { id: "p-1", skipped: false as const };
    },
    sendTemplatedEmail: async (input: unknown) => {
      calls.push({ input, sender: "templated" });
      return { id: "t-1", skipped: false as const };
    },
  };

  // Through the stored payload, the way the drain reads it back.
  const storedTemplated = JSON.parse(JSON.stringify(buildDirectEmailPayload(templatedMessage, "vacation:r1:leave_request", "test")));
  assert.ok(isDirectEmailPayload(storedTemplated), "a stored direct email is recognised as one");
  await sendDirectEmailMessage(storedTemplated.message, senders);
  const storedPhoenix = JSON.parse(JSON.stringify(buildDirectEmailPayload(phoenixMessage, "vacation:r1:returned", "test")));
  await sendDirectEmailMessage(storedPhoenix.message, senders);

  assert.deepEqual(calls.map((call) => call.sender), ["templated", "phoenix"], "each email goes back to its own sender, and only to it");
  assert.deepEqual(calls[0].input, templatedMessage.input, "the template send gets the stored input exactly: same To, CC, template and context");
  assert.deepEqual(calls[1].input, phoenixMessage.input, "the plain send gets the stored input exactly: same To, CC, subject and body");

  const sent = directEmailSentPayload(storedPhoenix);
  assert.equal(sent.figuresCleared, true, "a sent direct email says its figures were cleared");
  assert.equal((sent.message.input as { html: string }).html, "", "the rendered body is deleted once sent");
  assert.deepEqual((sent.message.input as { to: string[] }).to, ["a@satopharma.com"], "who it went to stays");
  assert.deepEqual((sent.message.input as { cc: string[] }).cc, ["hr@satopharma.com"], "the CC stays");
  const sentTemplated = directEmailSentPayload(storedTemplated);
  assert.equal((sentTemplated.message.input as { context?: unknown }).context, undefined, "the template's context (balances, amounts) is deleted once sent");
  assert.equal((sentTemplated.message.input as { templateKey: string }).templateKey, "leave_request", "which template it was stays");
  assert.deepEqual(storedTemplated.recipients, ["manager@satopharma.com"], "the row names its To for Email Activity");

  // The drain branches to that sender BEFORE the standard path's identity guard, policy routing,
  // manager CC and template swap — none of which may touch a direct email.
  const email = source("src/lib/notifications/email.ts");
  const processRow = functionBody(email, "async function processNotificationOutboxRow(");
  const branch = processRow.indexOf("if (isDirectEmailPayload(claimedRow.payload))");
  assert.ok(branch > 0, "the drain must branch on a direct email");
  assert.ok(branch < processRow.indexOf("validateNotificationEmailIdentity("), "the branch comes before the standard path's first step");
  assert.ok(processRow.slice(branch, branch + 400).includes("deliverDirectEmailOutboxRow(claimedRow)"), "the branch delivers through the direct sender");
  const deliver = functionBody(email, "export async function deliverDirectEmailOutboxRow(");
  assert.ok(deliver.includes("sendDirectEmailMessage(payload.message)"), "the drain sends the stored message");
  assert.ok(!deliver.includes("sendNotificationEmailDirect"), "the drain never uses the standard notification path for a direct email");
  assert.ok(!deliver.includes("enrichRecipientsWithManagerCc"), "the drain adds no manager CC to a direct email");
}

function outboxRow(overrides: Partial<NotificationOutboxRow> = {}): NotificationOutboxRow {
  return {
    attempts: 0,
    created_at: "2026-11-13T08:00:00.000Z",
    dedupe_key: "k",
    id: "row-1",
    last_error: null,
    locked_at: null,
    max_attempts: 5,
    next_attempt_at: null,
    payload: {} as NotificationOutboxRow["payload"],
    provider_message_id: null,
    sent_at: null,
    status: "processing",
    updated_at: "2026-11-13T08:00:00.000Z",
    ...overrides,
  };
}

async function testTheInlineSendWritesTheRowFirstAndKeepsTheCallersShape() {
  const log: string[] = [];
  const fakeDeps = (outcome: Awaited<ReturnType<DurableEmailDeps["deliver"]>>, opened?: Awaited<ReturnType<DurableEmailDeps["open"]>>): DurableEmailDeps => ({
    deliver: async () => {
      log.push("deliver");
      return outcome;
    },
    open: async (_message, dedupeKey) => {
      log.push(`open:${dedupeKey}`);
      return opened ?? { row: outboxRow(), state: "claimed" };
    },
    sendDirect: async () => {
      log.push("direct");
      return { id: "direct-1", skipped: false };
    },
  });

  // Sent inline: the row first, then the send, and the provider's answer comes back unchanged.
  log.length = 0;
  const sent = await runDurableEmail(phoenixMessage, { dedupeKey: "vacation:r1:returned" }, fakeDeps({ outcome: "sent", result: { id: "msg-1", skipped: false } }));
  assert.deepEqual(sent, { id: "msg-1", skipped: false }, "a sent email returns exactly what the provider said");
  assert.ok(log[0].startsWith("open:durable-email:vacation:r1:returned:"), "the outbox row is written FIRST, under the caller's own key");
  assert.equal(log[1], "deliver", "then it is sent inline");

  // A skip that cannot change is returned as it always was (the leave fallback depends on it).
  const terminal = await runDurableEmail(templatedMessage, { dedupeKey: "k" }, fakeDeps({ outcome: "skipped", result: { reason: "Email template not found.", skipped: true } }));
  assert.deepEqual(terminal, { reason: "Email template not found.", skipped: true }, "a terminal skip comes back word for word");

  // A transient skip is left in the outbox and says so.
  const queued = await runDurableEmail(templatedMessage, { dedupeKey: "k" }, fakeDeps({ outcome: "queued", result: { reason: "Recipient check unavailable", skipped: true } }));
  assert.deepEqual(queued, { reason: "Queued for retry: Recipient check unavailable", skipped: true }, "a retried skip is still a skip, worded as queued");

  // A provider failure still THROWS to the caller (its own failure record runs), worded as queued.
  await assert.rejects(
    runDurableEmail(templatedMessage, { dedupeKey: "k" }, fakeDeps({ error: new Error("resend: 500"), message: "resend: 500", outcome: "threw" })),
    /^Error: Queued for retry: resend: 500$/,
    "a provider failure throws as before, and says the email is waiting in the outbox",
  );

  // A retried request finds its sent row and never sends a second email.
  log.length = 0;
  const again = await runDurableEmail(
    templatedMessage,
    { dedupeKey: "k" },
    fakeDeps({ outcome: "sent", result: { id: "never", skipped: false } }, { row: outboxRow({ provider_message_id: "msg-1", status: "sent" }), state: "finished" }),
  );
  assert.deepEqual(again, { id: "msg-1", skipped: false }, "the earlier send's id comes back");
  assert.ok(!log.includes("deliver") && !log.includes("direct"), "a request retried after its email went out sends nothing");

  // No outbox: the email still goes, exactly as before.
  log.length = 0;
  const noOutbox = await runDurableEmail(templatedMessage, { dedupeKey: "k" }, {
    ...fakeDeps({ outcome: "sent", result: { id: "x", skipped: false } }),
    open: async () => {
      throw new Error("database unavailable");
    },
  });
  assert.deepEqual(noOutbox, { id: "direct-1", skipped: false }, "durability never costs an email");
  assert.deepEqual(log, ["direct"], "with no row it is sent directly, once");

  // A live credential is never written to this payload.
  log.length = 0;
  await runDurableEmail({ ...phoenixMessage, input: { ...phoenixMessage.input, credentialEmail: "password_setup_link" } } as DurableEmailMessage, { dedupeKey: "k" }, fakeDeps({ outcome: "sent", result: { id: "x", skipped: false } }));
  assert.deepEqual(log, ["direct"], "a credential email skips the durable outbox entirely");
}

function testTheDedupeKey() {
  const day = new Date("2026-11-13T10:00:00Z");
  const key = durableEmailDedupeKey(templatedMessage, "vacation:r1:leave_request:manager@satopharma.com", day);
  assert.ok(key.startsWith("durable-email:vacation:r1:leave_request:manager@satopharma.com:2026-11-13:"), "the caller's own key leads, then the Cairo day");
  assert.equal(durableEmailDedupeKey(templatedMessage, "vacation:r1:leave_request:manager@satopharma.com", new Date("2026-11-13T20:00:00Z")), key,
    "a retried request the same Cairo day finds the same row and never queues a second email");
  const otherStep = { ...templatedMessage, input: { ...templatedMessage.input, context: { managerName: "Omar" } } } as DurableEmailMessage;
  assert.notEqual(durableEmailDedupeKey(otherStep, "vacation:r1:leave_request:manager@satopharma.com", day), key,
    "a different email under the same caller key is its own row, never swallowed");
  assert.notEqual(durableEmailDedupeKey(templatedMessage, "vacation:r1:leave_request:manager@satopharma.com", new Date("2026-11-14T10:00:00Z")), key,
    "the same email on a later day is not swallowed for ever");
}

function testWhatARetryCanChange() {
  assert.deepEqual(classifyDirectEmailSkip("Email template not found."), { code: "type_unsupported", sentryEscalate: false, terminal: true },
    "a missing template does not come back on a retry — the leave sender falls back instead");
  assert.equal(classifyDirectEmailSkip("Email template leave_request is inactive.").terminal, true, "nor does a switched-off template");
  assert.equal(classifyDirectEmailSkip("EMAIL_NOTIFICATIONS_ENABLED is not true.").terminal, true, "email switched off is the standard terminal skip");
  assert.equal(classifyDirectEmailSkip("Held for Super Admin review (40% confidence)").terminal, true, "a held email waits for a person, not a retry");
  assert.equal(classifyDirectEmailSkip("Recipient check unavailable — the employee directory could not be read").terminal, false,
    "a directory blip is retried");
}

function testOutOfRetriesRaisesTheExistingAlarm() {
  const verdict = assessDrainHealth([
    { attempted: 3, queue: "outbox", strandedBefore: 0 },
    { attempted: 0, queue: "approval_email", strandedBefore: 2 },
  ]);
  assert.equal(verdict.healthy, false, "an approval email out of retries makes the drain reading unhealthy");
  assert.match(describeDrainHealth(verdict), /approval_email: 2 approval email\(s\) out of retries/, "the alarm names them and the count");
  assert.equal(assessDrainHealth([{ attempted: 0, queue: "approval_email", strandedBefore: 0 }]).healthy, true, "none out of retries, no alarm");

  const processing = source("src/lib/notifications/scheduled-processing.ts");
  assert.ok(processing.includes('{ attempted: 0, queue: "approval_email", strandedBefore: backlog?.approval_email ?? null }'),
    "the run feeds the reading into the same verdict that pages the existing alarm");
  const drainHealth = source("src/lib/notifications/drain-health.ts");
  assert.ok(drainHealth.includes("countExhaustedApprovalEmails(runStartedAtIso)"), "the backlog read counts them");
  // No new channel: the existing alert is the only thing that speaks.
  const alert = source("src/lib/notifications/drain-health-alert.ts");
  assert.ok(alert.includes('channels: ["in_app", "telegram", "push"]'), "the drain alert keeps its channels, no email");
}

function testSendAgainChecksPermissionBeforeItTouchesAnything() {
  const route = source("app/api/admin/email-notifications/outbox/[id]/send-again/route.ts");
  const permission = route.indexOf('await assertPermission(access, "admin", "update")');
  assert.ok(permission > 0, "the send-again route asserts the Email Notifications update permission");
  assert.ok(permission < route.indexOf("requeueExhaustedDurableEmail(access, id)"), "the permission is checked before the re-queue");
  assert.ok(route.indexOf("assertSameOriginMutation(request)") < permission, "and a cross-site post is refused first");

  const durable = source("src/lib/notifications/durable-email.ts");
  const requeue = functionBody(durable, "export async function requeueExhaustedDurableEmail(");
  const check = requeue.indexOf('await assertPermission(access, "admin", "update")');
  assert.ok(check > 0, "the domain function checks the permission itself too");
  assert.ok(check < requeue.indexOf("getSupabaseAdmin()"), "before it reads or writes anything");
  assert.ok(requeue.includes('status: "pending"') && requeue.includes("attempts: 0"), "it re-queues with a fresh retry budget");
  assert.ok(!requeue.includes("sendDirectEmailMessage") && !requeue.includes("deliverDirectEmailOutboxRow"), "it sends nothing itself — the drain does");
  assert.ok(requeue.includes('.eq("attempts", current.attempts)'), "two presses queue it once (compare-and-set)");
}

export async function runDurableApprovalEmailsTests() {
  testEveryInScopeCallSiteGoesThroughTheDurableHelper();
  await testTheStoredInputGoesBackToItsOwnSenderUnchanged();
  await testTheInlineSendWritesTheRowFirstAndKeepsTheCallersShape();
  testTheDedupeKey();
  testWhatARetryCanChange();
  testOutOfRetriesRaisesTheExistingAlarm();
  testSendAgainChecksPermissionBeforeItTouchesAnything();
}
