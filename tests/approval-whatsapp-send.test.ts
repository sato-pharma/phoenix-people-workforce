import assert from "node:assert/strict";

import {
  approvalReminderMessage,
  assertRemindersReachedSomeone,
  runApprovalWhatsAppReminders,
  type ApprovalReminderDeps,
} from "../src/lib/approvals/urgent-whatsapp.ts";
import { APPROVAL_REMINDER_CAP_PER_RUN, APPROVAL_REMINDER_TEMPLATE_LANGUAGE, APPROVAL_REMINDER_TEMPLATE_NAME, type ApproverDue } from "../src/lib/approvals/urgent-whatsapp-rules.ts";

// Every send here goes to a fake. 🔴 No test may ever reach Meta.

const TUESDAY_10_11 = new Date("2026-11-03T08:11:00.000Z");
const FRIDAY_10_11 = new Date("2026-11-06T08:11:00.000Z");
const LINE = { businessAccountId: "waba-3", phoneNumberId: "third-number" };

function person(hrId: string, total = 2, waId: string | null = `2010${hrId.replace(/\D/gu, "").padStart(8, "0")}`): ApproverDue {
  return { counts: { direct_order: 0, excuse: 0, leave: total, marketing: 0 }, hrId, total, waId };
}

function harness(due: ApproverDue[], over: Partial<ApprovalReminderDeps> = {}) {
  const log: string[] = [];
  const ledger = new Map<string, { status: string; wamid?: string | null; failureReason?: string | null }>();
  const deps: ApprovalReminderDeps = {
    claim: async (claim) => {
      if (ledger.has(claim.hrId)) return false;
      log.push(`claim:${claim.hrId}`);
      ledger.set(claim.hrId, { status: claim.status });
      return true;
    },
    claimedToday: async () => new Set(ledger.keys()),
    finish: async (hrId, _day, outcome) => {
      log.push(`finish:${hrId}:${outcome.status}`);
      ledger.set(hrId, outcome);
    },
    line: () => LINE,
    now: () => TUESDAY_10_11,
    production: () => true,
    send: async ({ phoneNumberId, toWaId, total }) => {
      log.push(`send:${phoneNumberId}:${toWaId}:${total}`);
      return { ok: true, wamid: `wamid.${toWaId}` };
    },
    switchOn: async () => true,
    tally: async () => ({ due, notYetDue: 1, unaddressed: 2 }),
    templateStatus: async () => "approved",
    ...over,
  };
  return { deps, ledger, log, sends: () => log.filter((entry) => entry.startsWith("send:")) };
}

async function testEveryLockKeepsItSilent() {
  const untouchable = () => {
    throw new Error("a locked run must not read the chains");
  };
  for (const [name, over] of [
    ["switch off", { switchOn: async () => false }],
    ["not production", { production: () => false }],
    ["no number", { line: () => null }],
    ["Friday", { now: () => FRIDAY_10_11 }],
    ["template pending", { templateStatus: async () => "pending" }],
    ["template missing", { templateStatus: async () => "missing" }],
    ["template rejected", { templateStatus: async () => "rejected" }],
  ] as Array<[string, Partial<ApprovalReminderDeps>]>) {
    const { deps, log } = harness([person("A-1")], { tally: untouchable as never, ...over });
    const result = await runApprovalWhatsAppReminders({ deps });
    assert.equal(result.outcome, "off", name);
    assert.ok(result.because, `${name} says why`);
    assert.deepEqual(log, [], `${name}: nothing claimed and nothing sent`);
  }

  // With no number configured the sender would fall back to the RECRUITMENT line, so it must never be reached.
  const noLine = harness([person("A-1")], { line: () => null });
  await runApprovalWhatsAppReminders({ deps: noLine.deps });
  assert.deepEqual(noLine.sends(), [], "no number: the recruitment line is never used in its place");

  const notAsked = harness([person("A-1")], {
    switchOn: async () => false,
    templateStatus: async () => {
      throw new Error("Meta must not be asked while the switch is off");
    },
  });
  assert.equal((await runApprovalWhatsAppReminders({ deps: notAsked.deps })).outcome, "off");
}

async function testTheHappyRun() {
  const { deps, ledger, log, sends } = harness([person("A-1", 3), person("A-2", 1)]);
  const result = await runApprovalWhatsAppReminders({ deps });
  assert.equal(result.outcome, "ran");
  assert.equal(result.accepted, 2);
  assert.equal(result.unaddressed, 2, "the run reports who could not be told");
  assert.equal(result.notYetDue, 1);
  assert.equal(result.byChain.leave, 4);
  assert.deepEqual(sends(), ["send:third-number:201000000001:3", "send:third-number:201000000002:1"], "from the third number, with each person's own count");
  const claimedAt = log.indexOf("claim:A-1");
  assert.ok(claimedAt !== -1 && claimedAt < log.indexOf("send:third-number:201000000001:3"), "the row is claimed BEFORE the send");
  assert.equal(ledger.get("A-1")?.status, "accepted");
  assert.equal(ledger.get("A-1")?.wamid, "wamid.201000000001", "the message id is kept for Meta's delivery ticks");
}

async function testOneMessageAPersonADay() {
  const { deps, sends } = harness([person("A-1"), person("A-2")]);
  await runApprovalWhatsAppReminders({ deps });
  assert.equal(sends().length, 2);
  const second = await runApprovalWhatsAppReminders({ deps });
  assert.equal(sends().length, 2, "the next tick sends nobody a second message");
  assert.equal(second.alreadyToday, 2);

  const lost = harness([person("A-1")], { claim: async () => false });
  const raced = await runApprovalWhatsAppReminders({ deps: lost.deps });
  assert.deepEqual(lost.sends(), [], "a claim lost to another tick means no send");
  assert.equal(raced.alreadyToday, 1);
}

async function testNoNumberIsRecordedNeverSkipped() {
  const { deps, ledger, sends } = harness([person("A-1", 2, null), person("A-2")]);
  const result = await runApprovalWhatsAppReminders({ deps });
  assert.equal(result.noNumber, 1);
  assert.equal(ledger.get("A-1")?.status, "no_number", "a person with no number leaves a row");
  assert.equal(sends().length, 1, "and nothing is sent for them");
}

async function testTheCapAndTheNextTick() {
  const many = Array.from({ length: APPROVAL_REMINDER_CAP_PER_RUN + 4 }, (_, index) => person(`A-${index + 1}`));
  const { deps, sends } = harness(many);
  const first = await runApprovalWhatsAppReminders({ deps });
  assert.equal(sends().length, APPROVAL_REMINDER_CAP_PER_RUN, "one tick stays inside its cap");
  assert.equal(first.leftForNextTick, 4);
  const second = await runApprovalWhatsAppReminders({ deps });
  assert.equal(sends().length, many.length, "the next tick finishes the list");
  assert.equal(second.leftForNextTick, 0);
  assert.equal(new Set(sends()).size, many.length, "nobody twice");
}

async function testRefusals() {
  let attempts = 0;
  const refusing = harness([person("A-1"), person("A-2")], {
    send: async () => {
      attempts += 1;
      return attempts === 1 ? { detail: "Meta said no", ok: false, reason: "failed" } : { ok: true, wamid: "w" };
    },
  });
  const partly = await runApprovalWhatsAppReminders({ deps: refusing.deps });
  assert.equal(partly.failed, 1);
  assert.equal(partly.accepted, 1, "one refusal does not stop the others");
  assert.equal(refusing.ledger.get("A-1")?.status, "failed");
  assert.ok(refusing.ledger.get("A-1")?.failureReason?.includes("Meta said no"));
  attempts = 0;
  await runApprovalWhatsAppReminders({ deps: refusing.deps });
  assert.equal(attempts, 0, "a refused send is never retried that day");

  const allRefused = harness([person("A-1")], { send: async () => ({ detail: null, ok: false, reason: "failed" }) });
  await assert.rejects(() => runApprovalWhatsAppReminders({ deps: allRefused.deps }), /refused/u, "every send refused turns the job red");
  assert.equal(allRefused.ledger.get("A-1")?.status, "failed", "after writing the outcome down");
  assert.doesNotThrow(() => assertRemindersReachedSomeone({ accepted: 0, failed: 0 }), "a morning with nothing due is not a failure");
}

async function testAFailedReadIsNeverACalmZero() {
  const failing = harness([person("A-1")], {
    tally: async () => {
      throw new Error("the read failed");
    },
  });
  await assert.rejects(() => runApprovalWhatsAppReminders({ deps: failing.deps }), /the read failed/u, "a failed read throws, so the heartbeat records a failure");
  assert.deepEqual(failing.log, []);
}

async function testTheDryRun() {
  const { deps, log } = harness([person("A-1", 2), person("A-2", 3, null)], {
    now: () => FRIDAY_10_11,
    production: () => false,
    switchOn: async () => false,
    line: () => null,
    templateStatus: async () => "missing",
  });
  const result = await runApprovalWhatsAppReminders({ deps, dryRun: true });
  assert.equal(result.outcome, "dry_run");
  assert.equal(result.approversDue, 2, "it counts whatever the locks say");
  assert.equal(result.noNumber, 1);
  assert.equal(result.byChain.leave, 5);
  assert.deepEqual(log, [], "and writes nothing and sends nothing");
  assert.ok(!JSON.stringify(result).includes("A-1"), "counts only, no person");
}

function testTheMessageItself() {
  const message = approvalReminderMessage(3) as unknown as {
    type: string;
    template: { name: string; language: { code: string }; components: Array<{ type: string; parameters: Array<{ text: string; parameter_name?: string }> }> };
  };
  assert.equal(message.type, "template", "only a template can reach someone who has not written first");
  assert.equal(message.template.name, APPROVAL_REMINDER_TEMPLATE_NAME);
  assert.equal(message.template.language.code, APPROVAL_REMINDER_TEMPLATE_LANGUAGE);
  assert.equal(message.template.components.length, 1, "a body and nothing else");
  assert.deepEqual(message.template.components[0]?.parameters, [{ parameter_name: "count", text: "3", type: "text" }], "the count is all it carries");
}

export async function runApprovalWhatsAppSendTests() {
  await testEveryLockKeepsItSilent();
  await testTheHappyRun();
  await testOneMessageAPersonADay();
  await testNoNumberIsRecordedNeverSkipped();
  await testTheCapAndTheNextTick();
  await testRefusals();
  await testAFailedReadIsNeverACalmZero();
  await testTheDryRun();
  testTheMessageItself();
}
