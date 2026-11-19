import assert from "node:assert/strict";

import { notificationNamesItsRecipients } from "../src/lib/notifications/policy.ts";
import { resolveNotificationPersonRecipients } from "../src/lib/notifications/role-recipients.ts";
import { createSystemNotification } from "../src/lib/notifications/system.ts";
// Loaded up front so a fire-and-forget error row written by the code under test resolves its module
// from the cache and lands inside the stand-in, never after it has been taken down.
import "../src/lib/error-monitor/service.ts";
import { outboundCalls, withPostgrestStandIn, type Row, type Seen } from "./support/postgrest-stand-in.ts";

/**
 * A NOTICE THAT NAMES ITS RECIPIENTS GOES TO THOSE PEOPLE OR TO NOBODY (owner, 19 Nov 2026: "start
 * the resignation alert fallback task").
 *
 * The resignation alert names its audience from the admin-editable `resignation_workflow_alert` list
 * (owner, 2026-08-09: the Super Admin and the HR seats on it — deliberately not the CEO) and hands it
 * to the engine as `metadata.moduleOwnerHrIds`. The `resignations.*` row's permission-based strategy
 * used those people when there were some — and when the list came back EMPTY it looked through every
 * active login instead and told each company-scope holder of `resignations`: the CEO, the Finance
 * Manager and HR Operations. The list comes back empty on a failed read, when nobody on it resolves,
 * and — the worst case — when an admin switches the alert OFF on the recipients screen, so "off" meant
 * "everyone". The two payroll alerts, the employee-import alert and the attendance stall alert name
 * their people the same way.
 *
 * Tested by what the REAL engine does (`createSystemNotification`, the resolver, the policy) against
 * the shared in-memory database (tests/support/postgrest-stand-in.ts), with sending switched off. The
 * notice is the resignation alert's own shape. Nothing can leave the machine.
 */

const SENDING_KEYS = [
  "RESEND_API_KEY",
  "BREVO_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "ONESIGNAL_REST_API_KEY",
  "NEXT_PUBLIC_ONESIGNAL_APP_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "EMAIL_NOTIFICATIONS_ENABLED",
] as const;

async function withoutSendingKeys(body: () => Promise<void>): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  const saved = SENDING_KEYS.map((key) => [key, env[key]] as const);
  for (const key of SENDING_KEYS) delete env[key];
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

const LEAVER = "AI-0042";
const PEOPLE = [
  { hrId: "B-10", login: "b-10", name: "Super Admin", role: "Super Admin" },
  { hrId: "CEO-1", login: "ceo-1", name: "Chief Executive", role: "CEO" },
  { hrId: "FM-1", login: "fm-1", name: "Finance Manager", role: "Finance Manager" },
  { hrId: "HRO-1", login: "hro-1", name: "HR Operations", role: "HR Operations" },
] as const;
/** The company-scope logins that hold `resignations` but are not on the owner's list. */
const NEVER_TOLD = ["CEO-1", "FM-1"];

function seededTables(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    app_auth_users: PEOPLE.map((person) => ({
      auth_email: `${person.login}@example.test`,
      hr_id: person.hrId,
      is_active: true,
      line: null,
      login_id: person.login,
      manager_hr_id: null,
      name: person.name,
      role: person.role,
    })),
    employees: [
      ...PEOPLE.map((person) => ({
        department_id: null,
        employment_status: "active",
        full_name: person.name,
        hr_id: person.hrId,
        line_id: null,
        manager_hr_id: null,
        nickname: null,
        work_email: `${person.login}@example.test`,
      })),
      { department_id: null, employment_status: "resigned", full_name: "Test Leaver", hr_id: LEAVER, line_id: null, manager_hr_id: "B-10", nickname: null, work_email: "leaver@example.test" },
    ],
    ...extra,
  };
}

/** The resignation alert exactly as `notifyResignationWorkflow` raises it, with the list it resolved. */
function resignationAlert(metadataNames: Record<string, unknown>) {
  return {
    actionUrl: "/admin/approvals-hub?module=resignation&id=res-1",
    actorId: "system",
    eventType: "workflow_updated",
    message: "Resignation workflow for Test Leaver is now submitted.",
    metadata: {
      effectiveDate: "2026-12-01",
      employeeHrId: LEAVER,
      idempotencyKey: `resignation:${LEAVER}:submitted:2026-12-01:${Object.keys(metadataNames).join("-") || "unnamed"}:${JSON.stringify(metadataNames).length}`,
      status: "submitted",
      ...metadataNames,
    },
    module: "resignations",
    priority: "high" as const,
    subjectHrId: LEAVER,
    title: "Resignation submitted",
  };
}

/** Everyone a stored notice was addressed to, across every row the run wrote. */
function told(tables: Record<string, Row[]>): string[] {
  const people = new Set<string>();
  for (const row of tables.notification_events ?? []) {
    for (const hrId of Array.isArray(row.recipients) ? row.recipients : []) people.add(String(hrId));
  }
  return [...people].sort();
}

function sentDeliveries(tables: Record<string, Row[]>): Row[] {
  return (tables.notification_deliveries ?? []).filter((row) => row.status !== "skipped");
}

async function run(tables: Record<string, Row[]>, body: () => Promise<void>): Promise<Seen[]> {
  let seen: Seen[] = [];
  await withoutSendingKeys(async () => {
    seen = await withPostgrestStandIn({ tables }, body);
  });
  return seen;
}

function testWhatCountsAsNamed() {
  assert.equal(notificationNamesItsRecipients({ moduleOwnerHrIds: [] }), true, "an EMPTY list is still a named audience — the sender named nobody, not everybody");
  assert.equal(notificationNamesItsRecipients({ moduleOwnerHrIds: ["B-10"] }), true);
  assert.equal(notificationNamesItsRecipients({ permissionRecipientHrId: null }), true, "a single named owner that could not be resolved is still named");
  assert.equal(notificationNamesItsRecipients({ moduleOwnerHrIds: undefined }), false, "an undefined value never reaches the stored metadata, so it names nobody");
  assert.equal(notificationNamesItsRecipients({ employeeHrId: LEAVER }), false, "the subject is not a recipient list");
  assert.equal(notificationNamesItsRecipients(undefined), false);
}

async function testAnEmptyNamedListTellsNobody() {
  const tables = seededTables();
  const seen = await run(tables, async () => {
    await createSystemNotification(resignationAlert({ moduleOwnerHrIds: [] }));
  });
  for (const hrId of NEVER_TOLD) {
    assert.ok(!told(tables).includes(hrId), `EMPTY LIST: ${hrId} was told about a resignation — an empty named list fell back to every holder of the permission`);
  }
  assert.deepEqual(told(tables), [], "EMPTY LIST: nobody was told");
  assert.deepEqual(sentDeliveries(tables), [], "EMPTY LIST: every delivery is a recorded skip");
  const skip = (tables.notification_events ?? []).find((row) => (row.metadata as Row | null)?.governance);
  assert.ok(skip, "EMPTY LIST: the skip is recorded, so it is visible, never silent");
  const warnings = ((skip.metadata as Row).governance as { warnings?: Array<{ code: string }> }).warnings ?? [];
  assert.ok(warnings.some((warning) => warning.code === "named_recipients_unresolved"), `EMPTY LIST: the skip says the named list resolved nobody — it said ${warnings.map((w) => w.code).join(", ")}`);
  assert.deepEqual(outboundCalls(seen), [], "EMPTY LIST: nothing left the machine");
}

async function testTheListSwitchedOffTellsNobody() {
  // The admin switches "Resignation workflow recipients" OFF on the recipients screen: the real
  // resolver returns no one, and the alert must reach no one — "off" must never mean "everyone".
  const tables = seededTables({
    notification_role_policies: [
      { description: "switched off", enabled: false, label: "Resignation workflow alert", notification_key: "resignation_workflow_alert", roles: ["Super Admin", "HR Operations"] },
    ],
  });
  await run(tables, async () => {
    const { recipients } = await resolveNotificationPersonRecipients("resignation_workflow_alert", "Resignation workflow recipients");
    assert.deepEqual(recipients, [], "SWITCHED OFF: the resolver names nobody");
    await createSystemNotification(resignationAlert({ moduleOwnerHrIds: recipients.map((recipient) => recipient.hrId) }));
  });
  assert.deepEqual(told(tables), [], "SWITCHED OFF: nobody was told — not the CEO, not the Finance Manager, not HR Operations");
  assert.deepEqual(sentDeliveries(tables), [], "SWITCHED OFF: every delivery is a recorded skip");
}

async function testANamedListThatResolvesNobodyTellsNobody() {
  const tables = seededTables();
  await run(tables, async () => {
    await createSystemNotification(resignationAlert({ moduleOwnerHrIds: ["NO-SUCH-PERSON"] }));
  });
  assert.deepEqual(told(tables), [], "UNRESOLVED LIST: a named person who does not resolve is never replaced by everyone else");
}

async function testANamedListReachesExactlyItsPeople() {
  const tables = seededTables();
  await run(tables, async () => {
    await createSystemNotification(resignationAlert({ moduleOwnerHrIds: ["B-10", "HRO-1"] }));
  });
  assert.deepEqual(told(tables), ["B-10", "HRO-1"], "NAMED LIST: exactly the two named people, as before");
}

async function testANoticeThatNamesNobodyKeepsTheFallback() {
  // No resignation sender does this; it pins that the fix is the NAMING, not the module — a notice
  // that names no list still finds the company-scope holders of the permission, as it always did.
  const tables = seededTables();
  await run(tables, async () => {
    await createSystemNotification(resignationAlert({}));
  });
  for (const hrId of ["B-10", "CEO-1", "FM-1", "HRO-1"]) {
    assert.ok(told(tables).includes(hrId), `UNNAMED: ${hrId} holds resignations company-wide and is still found when the sender names nobody`);
  }
}

export async function runNamedRecipientsNeverWidenTests() {
  testWhatCountsAsNamed();
  await testAnEmptyNamedListTellsNobody();
  await testTheListSwitchedOffTellsNobody();
  await testANamedListThatResolvesNobodyTellsNobody();
  await testANamedListReachesExactlyItsPeople();
  await testANoticeThatNamesNobodyKeepsTheFallback();
}
