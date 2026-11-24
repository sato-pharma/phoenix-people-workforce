import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DECISION_EMPLOYEE_CHANNELS,
  DECISION_MANAGER_CHANNELS,
  buildDisputeDecisionSends,
} from "../src/lib/dispute-center/notify.ts";
import { canonicalHrIdKey } from "../src/lib/hr-id.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Owner, 2026-11-24, after accepting two deduction disputes and seeing nothing reach the employees'
 * phones: "the email and a telegram to be sent to them, CC their manager and their national sales
 * manager".
 *
 * Before: the decision went in-app and push only — both employees' push subscriptions had lapsed, so
 * only the bell had it. Now a decided deduction dispute goes to the employee by email, Telegram,
 * push and in-app, with the managers (the direct manager and the one above — a rep's District Sales
 * Manager and National Sales Manager) on the email's cc line, and each manager gets the heads-up
 * in-app and on Telegram, vouched for with authorizedRecipient (the deductions module refuses a
 * non-subject recipient without it).
 */

const notice = {
  actorHrId: "B-10",
  audience: "employee" as const,
  copyManagers: {
    message: (name: string) => `${name}'s dispute was accepted — the November 2026 deduction is cancelled.`,
    title: (name: string) => `Deduction dispute decided — ${name} — November 2026`,
  },
  employeeHrId: "B-132",
  eventKey: "decided:2026-11-24T16:30:00.916Z",
  kind: "deduction" as const,
  message: "Your dispute was accepted — the November 2026 deduction is cancelled.",
  recipientHrIds: ["B-132"],
  ref: "123cdec0-2e3b-458b-94cb-05667502e1b1",
  title: "Deduction dispute decided — November 2026",
};

const employee = { hrId: "B-132", name: "Yassin Khalifa", title: "Medical Representative" };
const managers = [
  { hrId: "B-119", name: "Saad Salama", title: "District Sales Manager" },
  { hrId: "B-122", name: "Amr Naguib", title: "National Sales Manager" },
];
// Keyed exactly as loadWorkEmails keys them: by canonicalHrIdKey.
const emails = new Map(
  [
    ["B-132", "yassin@example.test"],
    ["B-119", "saad@example.test"],
    ["B-122", "amr@example.test"],
  ].map(([hrId, email]) => [canonicalHrIdKey(hrId) as string, email]),
);

export async function runDisputeDecisionCopiesManagersTests() {
  // ── The employee: email + Telegram + push + in-app, the managers on the cc line ──────────────
  {
    const [toEmployee, ...toManagers] = buildDisputeDecisionSends({ emails, employee, managers, notice });
    assert.ok(toEmployee.channels?.includes("email"), "the employee is emailed the decision");
    assert.ok(toEmployee.channels?.includes("telegram"), "the employee is sent the decision on Telegram");
    assert.ok(toEmployee.channels?.includes("in_app") && toEmployee.channels?.includes("push"), "the bell and the phone keep it too");
    assert.deepEqual([...DECISION_EMPLOYEE_CHANNELS].sort(), ["email", "in_app", "push", "telegram"]);
    assert.equal(toEmployee.recipientHrId, "B-132", "addressed to the employee");
    assert.deepEqual(toEmployee.email?.recipients, ["yassin@example.test"], "To: the employee's work email");
    assert.deepEqual(
      [...(toEmployee.email?.cc ?? [])].sort(),
      ["amr@example.test", "saad@example.test"],
      "CC: the manager and the national sales manager",
    );
    assert.equal(toEmployee.email?.summary, notice.message, "the email says what the bell says");
    assert.equal(toEmployee.eventType, "dispute_center_decided");
    assert.equal(toEmployee.module, "deductions");

    // ── Each manager: Telegram + in-app, vouched for, no email of their own ───────────────────
    assert.deepEqual(toManagers.map((send) => send.recipientHrId), ["B-119", "B-122"], "one heads-up per manager");
    for (const send of toManagers) {
      assert.ok(send.channels?.includes("telegram"), `${send.recipientHrId} is told on Telegram`);
      assert.ok(!send.channels?.includes("email"), `${send.recipientHrId} gets the email as the cc, never a second one`);
      assert.equal(send.metadata?.authorizedRecipient, true, "a manager is not the subject — without this the engine refuses him");
      assert.equal(send.subjectHrId, "B-132", "the notice is about the employee");
      assert.match(send.message, /Yassin Khalifa's dispute was accepted/, "the manager's copy names the employee");
      assert.match(send.title, /Yassin Khalifa/);
    }
    assert.deepEqual([...DECISION_MANAGER_CHANNELS].sort(), ["in_app", "telegram"]);
    assert.notEqual(
      toManagers[0].metadata?.idempotencyKey,
      toManagers[1].metadata?.idempotencyKey,
      "two managers are two notices, never deduplicated onto one",
    );
  }

  // ── No manager on record: the employee is still emailed and sent Telegram, with an empty cc ──
  {
    const sends = buildDisputeDecisionSends({ emails, employee, managers: [], notice });
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].email?.cc, []);
    assert.ok(sends[0].channels?.includes("email") && sends[0].channels?.includes("telegram"));
  }

  // ── Both deduction decision paths ask for the managers' copy ────────────────────────────────
  for (const file of ["src/lib/dispute-center/deduction.ts", "src/lib/dispute-center/daily.ts"]) {
    const code = stripComments(readFileSync(file, "utf8"));
    const decided = code.slice(code.indexOf("eventKey: `decided:") - 1200, code.indexOf("eventKey: `decided:") + 200);
    assert.ok(code.includes("eventKey: `decided:"), `${file} still raises a decided notice`);
    assert.match(decided, /copyManagers:\s*\{/, `${file}: a decided deduction dispute copies the employee's managers`);
  }

  // ── And a reply's manager copies are vouched for too (they were refused on 2026-10-08) ──────
  {
    const comments = stripComments(readFileSync("src/lib/deductions/comments.ts", "utf8"));
    assert.match(
      comments,
      /metadata:\s*\{\s*authorizedRecipient:\s*true,\s*candidateId: input\.candidateId, pictureCount, reply: true\s*\}/,
      "a reply to a deduction dispute vouches for the managers it copies",
    );
  }
}
