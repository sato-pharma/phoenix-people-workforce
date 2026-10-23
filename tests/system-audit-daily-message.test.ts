import assert from "node:assert/strict";

import {
  SYSTEM_AUDIT_MESSAGE_LINES,
  SYSTEM_AUDIT_PAGE_URL,
  buildSystemAuditDailyMessage,
  cairoDayKey,
  sendSystemAuditDailyMessage,
  type SystemAuditDailyMessageDeps,
} from "../src/lib/system-audit/daily-message.ts";
import type { SystemNotificationResult } from "../src/lib/notifications/system.ts";
import type { AlertCandidate } from "../src/lib/system-audit/repository.ts";

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
    audienceEnabled: async () => true,
    recipients: async () => ({ recipients: [{ hrId: "B-10", userId: "user-10" }], warnings: [] }),
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
  assert.match(bullets[1], /^• Problem 2 — 1 person, 1 time, last /);
  assert.match(bullets[2], /— system, no employee, 5 times/, "A row with no person never reads as '0 people'");
  assert.match(bullets[0], /last 22.*12:15/, "Times are Cairo local");

  assert.equal(buildSystemAuditDailyMessage([candidate(1)]).title, "System Audit — 1 issue needs a look");
  assert.equal(cairoDayKey(new Date("2026-10-22T22:30:00.000Z")), "2026-10-23", "The day is the owner's Cairo day, not UTC's");
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

  const broken = harness({
    loadCandidates: async () => {
      throw new Error("ledger unreachable");
    },
  });
  const failed = await sendSystemAuditDailyMessage(broken.deps);
  assert.equal(failed.sent, false, "A failure never throws out of the sweep");
  assert.equal(failed.reason, "ledger unreachable");
}

export async function runSystemAuditDailyMessageTests() {
  testMessageText();
  await testSends();
  await testSendsNothing();
}
