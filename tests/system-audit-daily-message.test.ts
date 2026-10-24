import assert from "node:assert/strict";

import {
  SYSTEM_AUDIT_MESSAGE_LINES,
  SYSTEM_AUDIT_PAGE_URL,
  buildSystemAuditDailyMessage,
  cairoDayKey,
  sendSystemAuditDailyMessage,
  systemAuditDailyKey,
  type SystemAuditDailyMessageDeps,
} from "../src/lib/system-audit/daily-message.ts";
import type { SystemNotificationResult } from "../src/lib/notifications/system.ts";
import type { AlertCandidate, AlertDetail } from "../src/lib/system-audit/repository.ts";

/**
 * The one daily message. Nothing new → nothing sent (a daily "all clear" trains everyone to stop
 * reading). In-app and Telegram only, never email. One per person per Cairo day. The issues are
 * marked as told ONLY when somebody was actually told, so a message that reached nobody leaves them
 * for tomorrow; no recipient at all fails loudly into the audit trail. And it never throws.
 */

const NOW = new Date("2026-10-23T01:59:00.000Z");

function candidate(index: number, overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    issueId: `issue-${index}`,
    title: `Problem ${index}`,
    family: "app_error",
    status: "investigating",
    people: 2,
    operations: 5,
    lastOccurredAt: "2026-10-22T09:15:00.000Z",
    reason: "new",
    ...overrides,
  };
}

function delivered(status: "sent" | "skipped" | "failed" | "pending"): SystemNotificationResult {
  return {
    deliveries: [
      { channel: "in_app", idempotencyKey: "k", status },
      { channel: "telegram", idempotencyKey: "k", status: status === "sent" ? "sent" : "skipped" },
    ],
    eventId: "event-1",
    eventKey: "event-key",
  };
}

function harness(overrides: Partial<SystemAuditDailyMessageDeps> = {}) {
  const notified: Array<Parameters<SystemAuditDailyMessageDeps["notify"]>[0]> = [];
  const marked: string[][] = [];
  const audits: Array<Parameters<SystemAuditDailyMessageDeps["audit"]>[0]> = [];
  const deps: SystemAuditDailyMessageDeps = {
    loadCandidates: async () => [candidate(1)],
    markAlerted: async (ids) => {
      marked.push(ids);
      return ids.length;
    },
    loadDetails: async () => new Map(),
    audienceEnabled: async () => true,
    recipients: async () => ({ recipients: [{ hrId: "B-10", userId: "user-10" }], warnings: [] }),
    alreadyToldToday: async () => false,
    notify: async (input) => {
      notified.push(input);
      return delivered("sent");
    },
    audit: async (input) => {
      audits.push(input);
    },
    now: () => NOW,
    ...overrides,
  };
  return { deps, notified, marked, audits };
}

function testMessageText() {
  const candidates = [
    candidate(1),
    candidate(2, { reason: "newly_shared", people: 1, operations: 1 }),
    candidate(3, { reason: "reopened", people: 0 }),
    ...Array.from({ length: 9 }, (_, index) => candidate(index + 4)),
  ];
  const { title, message } = buildSystemAuditDailyMessage(candidates);
  assert.equal(title, "System Audit — 12 issues need a look");
  const lines = message.split("\n");
  assert.equal(lines[0], "10 new · 1 newly shared · 1 reopened", "Counts by reason come first");
  const bullets = lines.filter((line) => line.startsWith("• "));
  assert.equal(bullets.length, SYSTEM_AUDIT_MESSAGE_LINES, "At most ten issues are named");
  assert.equal(lines.at(-1), "and 2 more on the page", "The rest are counted, never cut in silence");
  assert.match(bullets[1], /^• 1 person — Problem 2 — 1 time, last /, "Without ledger detail the line keeps the title");
  assert.match(bullets[2], /^• system, no employee — Problem 3 — 5 times/, "A row with no person never reads as '0 people'");
  assert.match(bullets[0], /last 22.*12:15/, "Times are Cairo local");

  assert.equal(buildSystemAuditDailyMessage([candidate(1)]).title, "System Audit — 1 issue needs a look");
  assert.equal(cairoDayKey(new Date("2026-10-22T22:30:00.000Z")), "2026-10-23", "The day is the owner's Cairo day, not UTC's");
}

/**
 * 24 Oct 2026: the first message said "1 person" and never the name or the module, cut one sentence
 * at "singl" (the stored title is short) and printed <n>/<hr> where the signature masks numbers.
 * Each line now leads with who, in which module, and the whole words the person saw.
 */
function testNamesModuleAndWholeWords() {
  const whole =
    "A district manager has one day of single visits a week without approval, which is two half-days. Your week already holds two, so this half-day cannot be a single visit until your managers approve another day.";
  const details = new Map<string, AlertDetail>([
    [
      "issue-1",
      { people: [{ name: "Khaled Mohamed Ali Bedair", role: "SFE Manager" }], module: "Phoenix CRM", text: whole },
    ],
    [
      "issue-2",
      {
        people: [
          { name: "Hany Saad Mohamed Omar", role: "District Sales Manager" },
          { name: "Osama Mohamed El-said Mahmoud Ahmed", role: null },
          { name: "Third Person", role: null },
        ],
        module: "Phoenix CRM",
        text: "No answer",
      },
    ],
    ["issue-3", { people: [], module: null, text: "OpenAI said account out of credit (model gpt-5.1-nano, 412ms)" }],
  ]);
  const { message } = buildSystemAuditDailyMessage(
    [candidate(1, { people: 1, title: "short title cut at singl" }), candidate(2, { people: 3 }), candidate(3, { people: 0 })],
    details,
  );
  const bullets = message.split("\n").filter((line) => line.startsWith("• "));
  assert.match(bullets[0], /^• Khaled Mohamed Ali Bedair, SFE Manager · Phoenix CRM — A district manager/, "Who and which module lead the line");
  assert.ok(bullets[0].includes("approve another day."), "The sentence the person saw is whole, not the cut title");
  assert.ok(!bullets[0].includes("cut at singl"), "The stored title is not used when the ledger holds the words");
  assert.match(
    bullets[1],
    /^• Hany Saad Mohamed Omar, District Sales Manager; Osama Mohamed El-said Mahmoud Ahmed; and 1 other person · Phoenix CRM — No answer/,
    "Two people are named, the rest counted — never cut in silence",
  );
  assert.match(bullets[2], /^• system, no employee — OpenAI said account out of credit \(model gpt-5.1-nano, 412ms\)/, "Masks are filled from the real event; a system row names no one");
}

async function testSends() {
  const h = harness({ loadCandidates: async () => [candidate(1), candidate(2)] });
  const result = await sendSystemAuditDailyMessage(h.deps);
  assert.deepEqual(result, { sent: true, candidates: 2, delivered: 1, marked: 2 });
  assert.equal(h.notified.length, 1);
  const sent = h.notified[0];
  assert.deepEqual(sent.channels, ["in_app", "telegram"], "In-app and Telegram only — never email, never push");
  assert.equal(sent.module, "system", "The module Telegram is enabled for; an unknown one would drop the message");
  assert.equal(sent.actionUrl, SYSTEM_AUDIT_PAGE_URL);
  assert.equal(sent.recipientHrId, "B-10");
  assert.equal(
    (sent.metadata as Record<string, unknown>).idempotencyKey,
    "system-audit-daily:2026-10-23:B-10",
    "One per person per Cairo day",
  );
  assert.deepEqual(h.marked, [["issue-1", "issue-2"]], "What was said is marked, so tomorrow carries only what changed");
}

async function testSendsNothing() {
  const quiet = harness({ loadCandidates: async () => [] });
  const none = await sendSystemAuditDailyMessage(quiet.deps);
  assert.equal(none.sent, false);
  assert.equal(none.reason, "nothing new");
  assert.equal(quiet.notified.length, 0, "Nothing new → nothing sent, no 'all clear'");

  const off = harness({ audienceEnabled: async () => false });
  assert.equal((await sendSystemAuditDailyMessage(off.deps)).reason, "audience disabled by admin");
  assert.equal(off.notified.length, 0);

  const nobody = harness({ recipients: async () => ({ recipients: [], warnings: ["no active login"] }) });
  const failClosed = await sendSystemAuditDailyMessage(nobody.deps);
  assert.equal(failClosed.reason, "no recipients");
  assert.equal(nobody.marked.length, 0, "Unmarked, so the next message still carries them");
  assert.equal((nobody.audits[0].newValues as Record<string, unknown>).failClosed, true, "No recipient fails loudly into the audit trail");

  const skipped = harness({ notify: async () => delivered("skipped") });
  const again = await sendSystemAuditDailyMessage(skipped.deps);
  assert.equal(again.sent, false, "A second send the same day comes back skipped");
  assert.equal(skipped.marked.length, 0, "…and nothing is marked as told: the issues ride tomorrow's message");

  const pending = harness({ notify: async () => delivered("pending") });
  assert.equal((await sendSystemAuditDailyMessage(pending.deps)).sent, true, "A delivery on its way counts as told");

  const noDetail = harness({
    loadDetails: async () => {
      throw new Error("detail read failed");
    },
  });
  assert.equal((await sendSystemAuditDailyMessage(noDetail.deps)).sent, true, "A failed detail read still sends the plainer message");
  assert.match(String(noDetail.notified[0].message), /Problem 1/);

  const broken = harness({
    loadCandidates: async () => {
      throw new Error("ledger unreachable");
    },
  });
  const failed = await sendSystemAuditDailyMessage(broken.deps);
  assert.equal(failed.sent, false, "A failure never throws out of the sweep");
  assert.equal(failed.reason, "ledger unreachable");
}

/**
 * 23 Oct 2026: the 10:56 message listed 365 issues; an 11:53 re-run the same Cairo day was refused
 * delivery by the idempotency key, but the refused call still rewrote the stored notice — the in-app
 * bell then read "3 issues" with an 11:53 time. A person already told today is never asked again.
 */
async function testAlreadyToldToday() {
  const asked: Array<[string, string]> = [];
  const told = harness({
    alreadyToldToday: async (day, hrId) => {
      asked.push([day, hrId]);
      return true;
    },
  });
  const result = await sendSystemAuditDailyMessage(told.deps);
  assert.equal(told.notified.length, 0, "Already told today: the notification service is NOT called, so the stored notice is not rewritten");
  assert.equal(result.sent, false);
  assert.equal(result.reason, "already sent today");
  assert.equal(told.marked.length, 0, "…and nothing is marked: today's later findings ride tomorrow's message");
  assert.deepEqual(asked, [["2026-10-23", "B-10"]], "The check is per person, on the Cairo day");
  assert.equal(told.audits.length, 1, "The skipped run still leaves an audit row");
  assert.equal(systemAuditDailyKey("2026-10-23", "B-10"), "system-audit-daily:2026-10-23:B-10", "The key the check reads is the key the send writes");

  const unreadable = harness({ alreadyToldToday: async () => null });
  assert.equal((await sendSystemAuditDailyMessage(unreadable.deps)).sent, true, "A check that cannot read sends as before");
  assert.equal(unreadable.notified.length, 1);

  const throwing = harness({
    alreadyToldToday: async () => {
      throw new Error("network");
    },
  });
  assert.equal((await sendSystemAuditDailyMessage(throwing.deps)).sent, true, "A check that throws sends as before");

  const two = harness({
    recipients: async () => ({
      recipients: [
        { hrId: "B-10", userId: "user-10" },
        { hrId: "B-20", userId: "user-20" },
      ],
      warnings: [],
    }),
    alreadyToldToday: async (_day, hrId) => hrId === "B-10",
  });
  await sendSystemAuditDailyMessage(two.deps);
  assert.deepEqual(two.notified.map((input) => input.recipientHrId), ["B-20"], "Only the person not yet told today is sent to");
  assert.equal(two.notified[0]?.metadata?.idempotencyKey, "system-audit-daily:2026-10-23:B-20");
}

export async function runSystemAuditDailyMessageTests() {
  testMessageText();
  testNamesModuleAndWholeWords();
  await testSends();
  await testSendsNothing();
  await testAlreadyToldToday();
}
