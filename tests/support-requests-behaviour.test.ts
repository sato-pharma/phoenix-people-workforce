import assert from "node:assert/strict";

import { createAccessContext, normalizeHrId } from "../src/lib/auth/permissions.ts";
import {
  createSupportRequest,
  listAllSupportRequests,
  listSupportRequestsForViewer,
  updateSupportRequestStatus,
} from "../src/lib/support-requests/service.ts";
import { withPostgrestStandIn, writesTo, writtenRow, type Row, type StandIn } from "./support/postgrest-stand-in.ts";

// REC-079 (phase 2): src/lib/support-requests — the employee's "contact HR" tickets — run against the
// shared in-memory PostgREST, not read.
//
// Its main rule:
//
//   1. A ticket is opened in the SIGNED-IN employee's name, whatever HR id the form sends, and it is
//      saved BEFORE HR is alerted — an alert that cannot be addressed is reported back, never a lost
//      ticket and never a silent "sent".
//   2. An employee lists their own tickets only; the whole queue, and moving a ticket's status, are
//      HR's, re-checked by the service, and an unknown status is refused before anything is written.
//   3. Before the table exists, the lists answer empty instead of breaking the page.

const TABLE = "employee_support_requests";
const REP = createAccessContext({ hrId: "MR-41", loginId: "mr.41", role: "Medical Rep", source: "session" });
const OWNER = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" });

const ticket = (id: string, hrId: string, status = "Pending"): Row => ({
  attachments: [],
  category: "Payroll",
  created_at: "2026-11-18T09:00:00+00:00",
  description: "My October payslip is missing.",
  employee_name: "Someone",
  hr_id: hrId,
  id,
  status,
  subcategory: null,
  subject: "Payslip",
});

export async function runSupportRequestsBehaviourTests(): Promise<void> {
  // ── 1. Opened in the session's name, saved before the alert, and an unaddressed alert is reported ─
  const recipientsDown: StandIn = {
    failReads: { app_auth_users: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } },
    tables: { [TABLE]: [] },
  };
  await withPostgrestStandIn(recipientsDown, async (seen) => {
    const result = await createSupportRequest(REP, {
      category: "Payroll",
      description: "  My October payslip is missing.  ",
      employeeName: "Stand-in Rep",
      hrId: "B-99",
      subject: "Payslip",
    } as never);
    const [insert] = writesTo(seen, TABLE);
    assert.ok(insert, "the ticket was written");
    assert.equal(writtenRow(insert).hr_id, normalizeHrId(REP.hrId), "HEADLINE: the ticket carries the signed-in employee's HR id");
    assert.notEqual(writtenRow(insert).hr_id, "B-99", "never the HR id the form sent");
    assert.equal(writtenRow(insert).description, "My October payslip is missing.", "stored trimmed");
    assert.equal(ticketsSaved(recipientsDown), 1, "the ticket is saved although nobody could be alerted");
    assert.equal(result.notification.errored, true, "HEADLINE: the alert that could not be addressed is reported back to the page");
    assert.equal(result.notification.recipientCount, 0, "and it says nobody was reached — never a silent sent");
    assert.equal(result.row.subject, "Payslip");
  });
  await withPostgrestStandIn({ tables: { [TABLE]: [] } }, async (seen) => {
    await assert.rejects(
      createSupportRequest(REP, { category: "Payroll", description: " ", subject: "Payslip" } as never),
      /Category, subject, and description are all required\./,
    );
    assert.equal(writesTo(seen, TABLE).length, 0, "an empty description writes nothing");
  });

  // ── 2. Own tickets for the employee; the queue and the status are HR's ─────────────────────────
  const queue: StandIn = { tables: { [TABLE]: [ticket("t1", normalizeHrId(REP.hrId) as string), ticket("t2", "PD-7"), ticket("t3", "AI-3", "Resolved")] } };
  await withPostgrestStandIn(queue, async (seen) => {
    const own = await listSupportRequestsForViewer(REP);
    assert.deepEqual(own.map((row) => row.id), ["t1"], "HEADLINE: an employee sees their own tickets and nobody else's");
    await assert.rejects(listAllSupportRequests(REP), (error: Error) => error.message.startsWith("Forbidden:"), "the whole queue is refused to an employee");
    await assert.rejects(updateSupportRequestStatus(REP, "t2", "Resolved"), (error: Error) => error.message.startsWith("Forbidden:"), "and so is moving a ticket");
    await assert.rejects(updateSupportRequestStatus(OWNER, "t2", "Escalated" as never), /Invalid support request status\./, "an unknown status is refused");
    assert.equal(writesTo(seen, TABLE).length, 0, "none of those refusals wrote anything");

    const all = await listAllSupportRequests(OWNER, { status: "Pending" });
    assert.deepEqual(all.map((row) => row.id).sort(), ["t1", "t2"], "HR reads the queue, filtered by status");
    const moved = await updateSupportRequestStatus(OWNER, "t2", "In Progress");
    assert.equal(moved.status, "In Progress");
  });
  assert.equal(queue.tables[TABLE].find((row) => row.id === "t2")?.status, "In Progress");

  // ── 3. Before the table exists, the lists answer empty ─────────────────────────────────────────
  const missing: StandIn = {
    failReads: { [TABLE]: { body: { code: "42P01", message: `relation "public.${TABLE}" does not exist` }, status: 404 } },
    tables: {},
  };
  await withPostgrestStandIn(missing, async () => {
    assert.deepEqual(await listSupportRequestsForViewer(REP), [], "the employee's page shows no tickets instead of breaking");
    assert.deepEqual(await listAllSupportRequests(OWNER), [], "and so does HR's");
  });
}

function ticketsSaved(standIn: StandIn): number {
  return standIn.tables[TABLE].length;
}
