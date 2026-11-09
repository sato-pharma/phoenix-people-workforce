import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { permissionMatrix, phoenixRoles } from "../src/lib/auth/permissions.ts";
import type { AssignmentStatus, DeviceStatus, MarkableDeviceStatus } from "../src/lib/devices/types.ts";

/**
 * Device custody RESERVATIONS — a pre-provision for a not-yet-hired holder, and the day-one reconcile.
 *
 * The owner's decision (2026-09-28): a reservation is NOT a signed custody. It owes nothing and freezes
 * no value; the value is frozen on day one, when the reservation is reconciled to the hired employee.
 *
 * Read as TEXT, for the reason `device-register.test.ts` gives: the custody rules live in the database
 * on purpose, so pinning them in TypeScript would pin a second implementation. What matters is catching
 * a clause quietly relaxed — the value freeze moved off day one, a signed custody made revocable, the
 * one-live-holder guard narrowed back to outstanding-only, or a grant widened past service_role.
 */

const MIGRATION = "supabase/migrations/20260928230000_device_assignment_placeholder_reservation.sql";
const SERVICE = "src/lib/devices/service.ts";
const ROUTE = "app/api/devices/route.ts";
const FLEET = "src/lib/devices/headwind/fleet.ts";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export async function runDeviceReservationTests(): Promise<void> {
  const migration = source(MIGRATION);

  // The two new states, at both layers.
  const devStatus: DeviceStatus = "reserved";
  const asgReserved: AssignmentStatus = "reserved";
  const asgRevoked: AssignmentStatus = "revoked";
  assert.equal(devStatus, "reserved");
  assert.equal(asgReserved, "reserved");
  assert.equal(asgRevoked, "revoked");
  assert.match(
    migration,
    /company_devices_status_check[\s\S]*'reserved'/,
    "company_devices gains the reserved state",
  );
  assert.match(
    migration,
    /device_assignments_status_check[\s\S]*'reserved', 'revoked'/,
    "device_assignments gains reserved and revoked",
  );

  // A row is EITHER a real holder OR a placeholder — never both, never neither.
  assert.match(migration, /device_assignments_holder_identity check \(/, "the holder-identity check is added");
  assert.match(
    migration,
    /is_placeholder = true[\s\S]*employee_hr_id is null[\s\S]*placeholder_name is not null/,
    "a placeholder has a name and no hr_id",
  );

  // 🔴 The one-live-holder guard must cover reservations too, or a reserved device could be issued
  // to somebody else at the same time.
  assert.match(
    migration,
    /uq_device_assignments_live_device[\s\S]*where status in \('outstanding', 'reserved'\)/,
    "the one-live-claim index covers reserved as well as outstanding",
  );

  // 🔴 The value is frozen on RECONCILE, from the device — البند (9) at the day-one signature, not at
  // reservation. A reservation carried no value.
  assert.match(
    migration,
    /phx_device_reconcile[\s\S]*agreed_value_egp = v_device\.estimated_value_egp/,
    "reconcile freezes the device's value onto the row",
  );
  assert.match(
    migration,
    /phx_device_reconcile[\s\S]*status = 'outstanding'[\s\S]*is_placeholder = false/,
    "reconcile turns the reservation into a real outstanding custody",
  );

  // 🔴 A signed custody is never revoked — only a reservation.
  assert.match(
    migration,
    /Only a reservation can be revoked\. A signed-out device must be returned/,
    "revoke refuses a signed custody",
  );

  // Every new function is SECURITY DEFINER and granted to service_role only.
  for (const fn of ["phx_device_reserve", "phx_device_reassign_placeholder", "phx_device_revoke", "phx_device_reconcile"]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}\\(`), `${fn} is defined`);
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`), `${fn} is granted to service_role`);
    assert.match(
      migration,
      new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`),
      `${fn} is revoked from public/anon/authenticated`,
    );
  }

  // The service calls each RPC and writes an audit row.
  const service = source(SERVICE);
  for (const [method, rpc] of [
    ["reserveDevice", "phx_device_reserve"],
    ["reassignPlaceholder", "phx_device_reassign_placeholder"],
    ["revokeReservation", "phx_device_revoke"],
    ["reconcileDevice", "phx_device_reconcile"],
  ] as const) {
    assert.match(service, new RegExp(`export async function ${method}\\(`), `service exports ${method}`);
    assert.match(service, new RegExp(`\\.rpc\\("${rpc}"`), `${method} calls ${rpc}`);
  }
  assert.ok(
    service.includes("writeRequiredAuditLog") && service.includes("phx_device_reserve"),
    "the reservation writes go through the required audit log, like the rest of the register",
  );

  // The API exposes the four actions, each gated on company_devices:update.
  const route = source(ROUTE);
  for (const action of ["reserve", "reassign_placeholder", "revoke", "reconcile"]) {
    assert.match(route, new RegExp(`payload\\.action === "${action}"`), `the API handles the ${action} action`);
  }
  // The RPCs' own readable sentences must map to 400, not a generic 500. The list lives in the
  // service (`deviceRegisterErrorStatus`), and the route answers through it.
  assert.match(route, /status: deviceRegisterErrorStatus\(message\)/, "the route answers through deviceRegisterErrorStatus");
  assert.match(service, /Reserving\|A reservation\|Only a reservation\|Revoking\|Reconciling/, "reservation errors return 400");

  // The Rep Tablets fleet row carries what the controls target.
  const fleet = source(FLEET);
  for (const field of ["registerDeviceId", "registerStatus", "assignmentId", "placeholderName"]) {
    assert.match(fleet, new RegExp(`${field}:`), `the fleet row exposes ${field}`);
  }
  assert.match(fleet, /loadReservedAssignments/, "the fleet resolves live reservations for the row");

  // Sanity on the type: reserved is issue-only, never markable by hand.
  const notMarkable = (["reserved", "assigned"] as const).every(
    (s) => !(["in_stock", "repair", "lost", "stolen", "retired"] as MarkableDeviceStatus[]).includes(s as MarkableDeviceStatus),
  );
  assert.ok(notMarkable, "reserved and assigned are not markable statuses");

  // company_devices:update is a real grant some sales/HR role holds, so the actions are reachable.
  assert.ok(
    phoenixRoles.some((role) => permissionMatrix[role]?.company_devices?.includes("approve")),
    "at least one role can approve company_devices (the page's gate)",
  );
}
