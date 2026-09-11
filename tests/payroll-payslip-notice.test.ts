import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { notifyPayslipAvailable } from "../src/lib/payroll/notify-payslip-available.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * 205 PEOPLE WERE NEVER TOLD THEIR PAYSLIP WAS READY.
 *
 * FINDING 15. A payslip becomes visible the moment its batch is approved. The notification that
 * says so was wired only to the OLD payroll module's Approve button, as a helper PRIVATE TO A ROUTE
 * FILE. Automated Payroll — the live payroll path since July 2026 — approves its batch with a
 * direct database write, so it could not reach that helper and silently did without one.
 *
 * Measured on production: the event type carries 123 records, every one dated 13 July 2026, the
 * last time the old module approved a batch, and none since. The two automated publishes on
 * 10 August and 8 September covered 105 and 100 employees and produced two notifications between
 * them, both to finance.
 *
 * THE CAUSE IS THE SHAPE, NOT THE OMISSION. Business logic living in a route file has no second
 * caller, so when a second caller appeared it quietly went without. The sender now lives in the
 * domain and both paths call the same copy — that is what stops this recurring the next time a
 * third path is built.
 *
 * THE OWNER RULE THIS MUST NOT BREAK: a payslip is NEVER emailed. In-app and a generic Telegram
 * nudge only. Push is separately allowed by the owner's 2026-07-25 override and comes from the
 * policy row, not from the call site.
 *
 * NOTHING HERE SENDS ANYTHING. The suite runs with production credentials, so every test passes its
 * own sender. Reaching the real one would notify real employees and burn the idempotency key for a
 * month nobody has published.
 */

const BATCH = "batch-august";

function roster(hrIds: Array<string | null>) {
  return fakeSupabaseClient({
    salary_records: hrIds.map((hr_id) => ({ hr_id, batch_id: BATCH })),
  });
}

type Sent = Record<string, unknown>;

export async function runPayrollPayslipNoticeTests() {
  // ---- HEADLINE: everyone on the batch is told ------------------------------------------------
  const sent: Sent[] = [];
  const result = await notifyPayslipAvailable({
    batchId: BATCH,
    client: roster(["B-1", "B-2", "B-3"]) as never,
    send: async (payload) => {
      sent.push(payload as Sent);
    },
  });
  assert.equal(result.notified, 3, "every employee on the batch is told their payslip is ready");
  assert.equal(result.failed, 0);
  assert.equal(result.error, null);

  // ---- THE OWNER RULE: never by email ------------------------------------------------------------
  for (const payload of sent) {
    const channels = payload.channels as string[];
    assert.ok(
      !channels.includes("email"),
      "a payslip is NEVER emailed — owner rule, and this call site must not be the one that asks",
    );
    assert.deepEqual(channels, ["in_app", "telegram"], "in-app and a generic Telegram nudge only");
    assert.equal(payload.email, undefined, "and no email block, so it cannot carry payslip content");
  }

  // ---- Each person gets their own idempotency key ------------------------------------------------
  const keys = sent.map((payload) => (payload.metadata as { idempotencyKey: string }).idempotencyKey);
  assert.deepEqual(
    keys,
    [
      `payroll-payslip-available:${BATCH}:B-1`,
      `payroll-payslip-available:${BATCH}:B-2`,
      `payroll-payslip-available:${BATCH}:B-3`,
    ],
    "keyed per batch AND per person: per batch alone would tell one employee and silence the rest, " +
      "and re-publishing a month must not tell anybody twice",
  );
  assert.equal(sent[0]?.actionUrl, "/payslips", "and it takes them somewhere");
  assert.equal(sent[0]?.eventType, "payslip_available");

  // ---- A duplicated or blank roster row is not a second person -------------------------------------
  const deduped: Sent[] = [];
  const twice = await notifyPayslipAvailable({
    batchId: BATCH,
    client: roster(["B-1", "B-1", "  B-2  ", null, ""]) as never,
    send: async (payload) => {
      deduped.push(payload as Sent);
    },
  });
  assert.equal(twice.notified, 2, "one person with two salary rows is told once, and a blank id is nobody");

  // ---- One failure does not lose the rest, and does not throw ---------------------------------------
  const partial = await notifyPayslipAvailable({
    batchId: BATCH,
    client: roster(["B-1", "B-2", "B-3"]) as never,
    send: async (payload) => {
      if ((payload as { recipientHrId: string }).recipientHrId === "B-2") throw new Error("telegram down");
    },
  });
  assert.equal(partial.notified, 2, "the other two are still told");
  assert.equal(partial.failed, 1, "and the one that failed is COUNTED, not swallowed");

  // ---- A FAILED ROSTER READ IS NOT A QUIET MONTH ------------------------------------------------------
  // Zero notified with no error reads as "nobody worked here". The two must be distinguishable.
  const broken = await notifyPayslipAvailable({
    batchId: BATCH,
    client: fakeSupabaseClient({ salary_records: [] }, { failOn: { salary_records: "connection reset" } }) as never,
    send: async () => {
      throw new Error("must never be reached when the roster could not be read");
    },
  });
  assert.equal(broken.notified, 0);
  assert.match(
    String(broken.error),
    /connection reset/,
    "a failed roster read must say so — 0 notified with a null error is an empty company, which is " +
      "a different fact entirely",
  );

  // ---- Both payroll paths call the SAME copy -----------------------------------------------------------
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  assert.match(
    runService,
    /const payslipNotice = await notifyPayslipAvailable\(\{ batchId \}\)/,
    "the automated publish path must tell the employees — this is the whole finding",
  );
  assert.match(
    runService,
    /payslipNoticeSent: payslipNotice\.notified/,
    "and record who was told, because 'best effort' with no record is how the original stayed invisible",
  );
  assert.match(runService, /payslipNoticeFailed: payslipNotice\.failed/);
  assert.match(runService, /payslipNoticeError: payslipNotice\.error/);

  const workflowRoute = readFileSync("app/api/payroll/[id]/workflow/route.ts", "utf8");
  assert.match(
    workflowRoute,
    /import \{ notifyPayslipAvailable \} from "@\/lib\/payroll\/notify-payslip-available"/,
    "the old module must use the shared copy",
  );
  assert.ok(
    !workflowRoute.includes("async function notifyEmployeesPayslipAvailable"),
    "and must not keep a private one beside it — two copies is how the two paths drift apart again",
  );
  // The route still builds its OWN notification — the payroll workflow alert to Super Admin, CEO
  // and Finance Manager, which carries an email block and legitimately belongs there. What it must
  // not do is build a second PAYSLIP payload beside the shared one.
  assert.ok(
    !workflowRoute.includes('eventType: "payslip_available"'),
    "the route must not build a payslip payload of its own — two copies is how the two paths drift",
  );
}
