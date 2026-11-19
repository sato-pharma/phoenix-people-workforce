import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import { createSystemNotification } from "../src/lib/notifications/system.ts";
import { runResignationWorkflow } from "../src/lib/resignations/service.ts";
import { outboundCalls, registryModuleRow, withPostgrestStandIn, writesTo, type Failure, type Row, type Seen, type StandIn } from "./support/postgrest-stand-in.ts";

// A named recipient list is the WHOLE audience, even when it resolves to nobody (19 Nov 2026).
//
// The resignation alert names its people — the Super Admin and the HR seats on the admin-editable
// `resignation_workflow_alert` list (owner, 2026-08-09: deliberately NOT the CEO, NOT the leaver's
// manager chain) — as metadata.moduleOwnerHrIds, and the `resignations.*` policy resolves them through
// permission_based. That resolver used to read `explicit.length > 0 ? explicit : activeAuthCandidates()`,
// so a list that came back EMPTY (a failed app_auth_users read) or whose ids all failed the
// active-employee read fell through to EVERY active login, and each one holding `resignations` at
// company scope was told — the CEO among them. The same shape reached both payroll alerts, the
// employee-import alert and the punch-feed alarm.
//
// Run end to end on the shared in-memory PostgREST, the real resolver and the real sender:
//   1. control: a notice that names NOBODY (no key at all) still reaches a company-scope holder — the
//      CEO here — so the negative cases below are not passing because the CEO is invisible;
//   2. an EMPTY named list tells nobody, and the skip says the named list resolved to no one;
//   3. a list whose only id is not an active employee tells nobody;
//   4. a list naming the Super Admin tells the Super Admin and never the CEO;
//   5. the real resignation sender, with its recipient read failing, sends nothing and says so;
//   6. the real resignation sender, read healthy, tells the Super Admin and never the CEO.

const RESIGNATION_ID = "66666666-6666-4666-8666-666666666666";
const READ_AT = "2026-11-18T08:00:00.000000+00:00";
const OWNER = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" });
const CEO_MARKERS = ["CEO-1", "ceo.one", "ceo.one@stand-in.invalid"];

function world(): Record<string, Row[]> {
  return {
    app_auth_users: [
      { auth_email: "owner@stand-in.invalid", hr_id: "B-10", is_active: true, login_id: "b-10", name: "Stand-in Owner", role: "Super Admin" },
      { auth_email: "ceo.one@stand-in.invalid", hr_id: "CEO-1", is_active: true, login_id: "ceo.one", name: "Stand-in Chief", role: "CEO" },
      { auth_email: "dm.one@stand-in.invalid", hr_id: "DM-1", is_active: true, login_id: "dm.one", name: "Stand-in District Manager", role: "District Manager" },
      { auth_email: null, hr_id: "MR-66", is_active: true, login_id: "mr.sixty.six", name: "Stand-in Leaver", role: "Medical Rep" },
      // Named on a list but no longer employed: the login lags the employee record.
      { auth_email: "gone.nine@stand-in.invalid", hr_id: "GONE-9", is_active: true, login_id: "gone.nine", name: "Stand-in Departed", role: "Super Admin" },
    ],
    employee_resignations: [
      {
        create_vacancy: false,
        created_at: "2026-11-16T09:00:00+00:00",
        effective_date: "2026-12-15",
        employee_hr_id: "MR-66",
        employee_name: "Stand-in Leaver",
        exit_status: "submitted",
        id: RESIGNATION_ID,
        last_working_date: "2026-12-15",
        reason: "Moving abroad",
        resignation_date: "2026-11-16",
        status: "submitted",
        submitted_date: "2026-11-16",
        updated_at: READ_AT,
        vacancy_id: null,
        workflow_notes: null,
      },
    ],
    employees: [
      { employment_status: "active", full_name: "Stand-in Owner", hr_id: "B-10", manager_hr_id: null, work_email: "owner@stand-in.invalid" },
      { employment_status: "active", full_name: "Stand-in Chief", hr_id: "CEO-1", manager_hr_id: null, work_email: "ceo.one@stand-in.invalid" },
      { employment_status: "active", full_name: "Stand-in District Manager", hr_id: "DM-1", manager_hr_id: "CEO-1", work_email: "dm.one@stand-in.invalid" },
      { employment_status: "active", full_name: "Stand-in Leaver", hr_id: "MR-66", manager_hr_id: "DM-1", work_email: null },
      { employment_status: "resigned", full_name: "Stand-in Departed", hr_id: "GONE-9", manager_hr_id: null, work_email: "gone.nine@stand-in.invalid" },
    ],
    workflow_registry_modules: [
      registryModuleRow("resignations", [
        { from: ["resignation_submitted"], key: "resignation_approve", roles: ["Super Admin"], to: "resignation_approved" },
      ]),
    ],
  };
}

/** The resignation notice exactly as notifyResignationWorkflow raises it, with the named list given. */
function resignationNotice(metadata: Record<string, unknown>) {
  return {
    actionUrl: `/admin/approvals-hub?module=resignation&id=${RESIGNATION_ID}`,
    actorId: "system",
    eventType: "workflow_updated",
    message: "Resignation workflow for Stand-in Leaver is now approved.",
    metadata: {
      effectiveDate: "2026-12-15",
      employeeHrId: "MR-66",
      idempotencyKey: `resignation:MR-66:approved:2026-12-15:${Math.random()}`,
      status: "approved",
      ...metadata,
    },
    module: "resignations",
    priority: "high" as const,
    subjectHrId: "MR-66",
    title: "Resignation Approved",
  };
}

/** Every row the notification engine and the email outbox hold, as one text, to search for a person. */
function notificationRows(standIn: StandIn): Row[] {
  return Object.entries(standIn.tables)
    .filter(([table]) => table.startsWith("notification_") || table.includes("outbox") || table.includes("telegram") || table.includes("push"))
    .flatMap(([, rows]) => rows);
}

function told(standIn: StandIn, markers: string[]): boolean {
  const text = JSON.stringify(notificationRows(standIn)).toLowerCase();
  return markers.some((marker) => text.includes(marker.toLowerCase()));
}

const live = (row: Row) => row.status !== "skipped";
const deliveries = (standIn: StandIn) => standIn.tables.notification_deliveries ?? [];

function governanceWarnings(standIn: StandIn): string[] {
  return (standIn.tables.notification_events ?? []).flatMap((row) => {
    const governance = (row.metadata as { governance?: { warnings?: Array<{ code?: string }> } } | undefined)?.governance;
    return (governance?.warnings ?? []).map((warning) => String(warning.code ?? ""));
  });
}

/** The person resolver's role read (`.in("role", …)`) fails; every other app_auth_users read works. */
const roleReadFails = (seen: Seen): Failure | null =>
  seen.params.has("role") ? { body: { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" }, status: 500 } : null;

export async function runResignationAlertNamedListFailClosedTests(): Promise<void> {
  // ── 1. Control: with no named list at all, the old fallback still runs — and reaches the CEO ──────
  {
    const standIn: StandIn = { tables: world() };
    await withPostgrestStandIn(standIn, async () => {
      await createSystemNotification(resignationNotice({}));
    });
    assert.ok(
      deliveries(standIn).some((row) => live(row) && String(row.recipient_hr_id ?? "").toUpperCase() === "CEO-1"),
      "control: a notice that names nobody still falls back to every company-scope holder, so the stand-in CAN see the CEO being told",
    );
  }

  // ── 2. An EMPTY named list tells nobody ─────────────────────────────────────────────────────────────
  {
    const standIn: StandIn = { tables: world() };
    let result: Awaited<ReturnType<typeof createSystemNotification>> | null = null;
    let seenHere: Seen[] = [];
    await withPostgrestStandIn(standIn, async (seen) => {
      result = await createSystemNotification(resignationNotice({ moduleOwnerHrIds: [] }));
      seenHere = seen;
    });
    assert.deepEqual(
      deliveries(standIn).filter(live),
      [],
      "HEADLINE: an EMPTY moduleOwnerHrIds tells NOBODY — it never widens to every active login holding the permission",
    );
    assert.ok(deliveries(standIn).length > 0, "the skip left its delivery rows");
    assert.ok(deliveries(standIn).every((row) => row.recipient_hr_id == null), "no delivery row names a person");
    assert.ok(result!.deliveries.every((delivery) => delivery.status === "skipped"), "every channel answers skipped");
    assert.deepEqual(outboundCalls(seenHere), [], "no Telegram, push or email provider was called");
    assert.equal(told(standIn, CEO_MARKERS), false, "the CEO appears nowhere in the notification tables");
    assert.ok(
      governanceWarnings(standIn).includes("named_recipient_unresolved"),
      "the skip says the named list resolved to no one, not that a permission was missing",
    );
  }

  // ── 3. A list whose only id is not an active employee tells nobody ────────────────────────────────
  {
    const standIn: StandIn = { tables: world() };
    let result: Awaited<ReturnType<typeof createSystemNotification>> | null = null;
    await withPostgrestStandIn(standIn, async () => {
      result = await createSystemNotification(resignationNotice({ moduleOwnerHrIds: ["GONE-9"] }));
    });
    assert.deepEqual(
      deliveries(standIn).filter(live),
      [],
      "HEADLINE: a named list none of whose ids resolve to an active employee tells NOBODY",
    );
    assert.ok(result!.deliveries.every((delivery) => delivery.status === "skipped"), "every channel answers skipped");
    assert.equal(told(standIn, CEO_MARKERS), false, "the CEO is never the stand-in for an unresolvable list");
    assert.ok(
      deliveries(standIn).every((row) => String(row.recipient_hr_id ?? "").toUpperCase() !== "GONE-9" && row.recipient_address !== "gone.nine@stand-in.invalid"),
      "and the departed person on the list is not told either (the list itself stays on the event's metadata)",
    );
  }

  // ── 4. A list naming the Super Admin tells the Super Admin, never the CEO ─────────────────────────
  {
    const standIn: StandIn = { tables: world() };
    await withPostgrestStandIn(standIn, async () => {
      await createSystemNotification(resignationNotice({ moduleOwnerHrIds: ["B-10"] }));
    });
    const reached = new Set(deliveries(standIn).filter(live).map((row) => String(row.recipient_hr_id ?? "").toUpperCase()));
    assert.ok(reached.has("B-10"), "the person on the list is told");
    assert.deepEqual([...reached].filter((hrId) => hrId && hrId !== "B-10"), [], "nobody outside the list is told");
    assert.equal(told(standIn, CEO_MARKERS), false, "the CEO holds resignations read company-wide and is still never told");
  }

  // ── 5. The real sender: its recipient read fails, so it sends nothing and logs why ───────────────
  {
    const standIn: StandIn = { failReads: { app_auth_users: roleReadFails }, tables: world() };
    const logged: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...parts: unknown[]) => void logged.push(parts.map(String).join(" "));
    console.warn = (...parts: unknown[]) => void logged.push(parts.map(String).join(" "));
    try {
      await withPostgrestStandIn(standIn, async (seen) => {
        const record = await runResignationWorkflow(RESIGNATION_ID, "approve", "B-10", null, null, OWNER);
        assert.equal(record?.status, "approved", "the decision itself is saved");
        assert.deepEqual(writesTo(seen, "notification_events"), [], "HEADLINE: an empty recipient list is not sent at all");
        assert.deepEqual(writesTo(seen, "notification_deliveries"), [], "no delivery row, skipped or otherwise");
        assert.deepEqual(outboundCalls(seen), [], "no provider was called");
      });
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
    assert.equal(told(standIn, CEO_MARKERS), false, "the CEO is not told");
    assert.ok(
      logged.some((line) => line.includes("resignation_workflow_alert_no_recipients") && line.includes("list_resolved_to_nobody")),
      "the failed read is logged as the alert not being sent, naming why",
    );
  }

  // ── 6. The real sender, read healthy: the Super Admin is told, the CEO never ───────────────────────
  {
    const standIn: StandIn = { tables: world() };
    await withPostgrestStandIn(standIn, async () => {
      const record = await runResignationWorkflow(RESIGNATION_ID, "approve", "B-10", null, null, OWNER);
      assert.equal(record?.status, "approved");
    });
    const reached = new Set(deliveries(standIn).filter(live).map((row) => String(row.recipient_hr_id ?? "").toUpperCase()));
    assert.ok(reached.has("B-10"), "the Super Admin on the resignation_workflow_alert list is told");
    assert.equal(told(standIn, CEO_MARKERS), false, "HEADLINE (owner, 2026-08-09): a resignation never reaches the CEO");
    assert.equal(told(standIn, ["DM-1", "dm.one"]), false, "nor the leaver's manager chain");
  }
}
