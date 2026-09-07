import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildDeviceStats,
  buildLeaversHolding,
  computeDeviceHolderFlags,
  deviceIdentifier,
  isDeviceCategory,
  isDeviceRegisterSchemaMissing,
  isMarkableDeviceStatus,
  isReturnCondition,
  parseAmount,
} from "../src/lib/devices/service.ts";
import type { CompanyDevice, DeviceStatus, HolderEmploymentState } from "../src/lib/devices/types.ts";

/**
 * The company device register — the asset half of the custody receipt (إقرار استلام عهدة).
 *
 * WHAT THIS FILE PROVES, and why each of them rather than something else:
 *
 *  1. `isHeldByLeaver` — the flag the whole register exists to raise, and the one number the page
 *     leads with. It is DERIVED rather than stored precisely so it can never drift from the
 *     employment record beneath it; that only helps if the derivation itself is pinned.
 *  2. An UNKNOWN holder counts as a leaver. A device signed out to an hr_id matching no directory
 *     row is a holder nobody can contact — strictly worse than a recorded leaver, and treating it
 *     as active would hide it on the one screen built to find it.
 *  3. The migration's own rules, read out of the SQL: البند (10)'s settlement cap, the refusal to
 *     release a holder when a device is marked lost, the one-live-holder index, and the
 *     SECURITY DEFINER revokes. These live in the database on purpose — a rule in a page is
 *     bypassed by the next page, and two of these decide how much comes out of somebody's wages.
 *
 * WHY THE SQL IS READ AS TEXT. There is no database in this suite, and the alternative — asserting
 * the same rules in TypeScript — would pin a SECOND implementation of them, which is exactly the
 * duplication the "rules live in the database" decision exists to avoid. Reading the migration
 * catches the change that matters: somebody quietly relaxing a clause. It is the same technique
 * `tests/mailbox-offboarding.test.ts` uses on `phx_mailbox_offboarding_refresh_status`.
 */

const MIGRATION = "supabase/migrations/20260907220000_company_device_register.sql";
const TODAY = "2026-09-07";

function deviceFixture(overrides: Partial<CompanyDevice> = {}): CompanyDevice {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    assetTag: "PHX-LAP-0001",
    category: "laptop",
    manufacturer: "Dell",
    model: "Latitude 5440",
    serialNumber: "7XKQ2V3",
    imei: null,
    deviceName: null,
    processor: null,
    installedRam: null,
    systemType: null,
    windowsDeviceId: null,
    windowsProductId: null,
    simNumber: null,
    lineNumber: null,
    estimatedValueEgp: 25000,
    purchasedOn: null,
    status: "assigned",
    statusReason: null,
    statusChangedAt: null,
    note: null,
    assignmentId: "22222222-2222-2222-2222-222222222222",
    holderHrId: "B-155",
    holderName: "Nour Adel",
    holderJobTitle: "Medical Representative",
    issuedOn: "2026-01-15",
    agreedValueEgp: 25000,
    declarationNo: null,
    holderState: "active",
    holderLastWorkingDate: null,
    daysSinceHolderLeft: 0,
    isHeldByLeaver: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// The flag the register exists to raise
// ---------------------------------------------------------------------------------------------

function testAnActiveHoldersDeviceIsNotFlagged(): void {
  const flags = computeDeviceHolderFlags(
    { assignmentOutstanding: true, holderState: "active", holderLastWorkingDate: null },
    TODAY,
  );
  assert.equal(flags.isHeldByLeaver, false, "somebody who still works here is not a leaver");
  assert.equal(flags.daysSinceHolderLeft, 0);
}

function testALeaversDeviceIsFlaggedAndAged(): void {
  const flags = computeDeviceHolderFlags(
    { assignmentOutstanding: true, holderState: "left", holderLastWorkingDate: "2026-08-08" },
    TODAY,
  );
  assert.equal(flags.isHeldByLeaver, true, "a device still out with somebody who has left is the whole point");
  assert.equal(flags.daysSinceHolderLeft, 30, "30 whole days from 8 August to 7 September");
}

/**
 * An hr_id matching no directory row counts as a leaver.
 *
 * The tempting reading is "we do not know, so do not alarm anybody". It is the wrong one: an
 * unknown holder is somebody the company cannot contact about a machine it owns, which is worse
 * than a recorded leaver, not better. Treating it as active would hide the row on the one screen
 * built to surface exactly this.
 */
function testAnUnknownHolderCountsAsALeaver(): void {
  const flags = computeDeviceHolderFlags(
    { assignmentOutstanding: true, holderState: "unknown", holderLastWorkingDate: null },
    TODAY,
  );
  assert.equal(flags.isHeldByLeaver, true, "a holder nobody can find is not a safe state");
}

/** Nothing is owed on a device nobody holds, whatever the directory says about anybody. */
function testADeviceInStockIsNeverFlagged(): void {
  for (const state of ["active", "left", "unknown"] as HolderEmploymentState[]) {
    const flags = computeDeviceHolderFlags(
      { assignmentOutstanding: false, holderState: state, holderLastWorkingDate: "2026-01-01" },
      TODAY,
    );
    assert.equal(flags.isHeldByLeaver, false, `a returned device owes nothing (holder ${state})`);
    assert.equal(flags.daysSinceHolderLeft, 0, "and its former holder's dates are not counted");
  }
}

/** A last working day in the FUTURE is a notice period, not an overdue return. */
function testANoticePeriodIsNotOverdue(): void {
  const flags = computeDeviceHolderFlags(
    { assignmentOutstanding: true, holderState: "left", holderLastWorkingDate: "2026-12-31" },
    TODAY,
  );
  assert.equal(flags.daysSinceHolderLeft, 0, "a future last day counts zero days, never negative");
}

// ---------------------------------------------------------------------------------------------
// What the page counts
// ---------------------------------------------------------------------------------------------

function testStatsCountWhatIsAtRisk(): void {
  const stats = buildDeviceStats([
    deviceFixture({ id: "a", status: "in_stock", assignmentId: null, holderHrId: null, agreedValueEgp: null }),
    deviceFixture({ id: "b", status: "assigned" }),
    deviceFixture({ id: "c", status: "assigned", isHeldByLeaver: true, agreedValueEgp: 25000 }),
    deviceFixture({ id: "d", status: "stolen", isHeldByLeaver: true, agreedValueEgp: 12000 }),
    deviceFixture({ id: "e", status: "lost", assignmentId: null, holderHrId: null }),
    deviceFixture({ id: "f", status: "repair", assignmentId: null, holderHrId: null }),
    deviceFixture({ id: "g", status: "retired", assignmentId: null, holderHrId: null, estimatedValueEgp: null }),
  ]);

  assert.equal(stats.total, 7);
  assert.equal(stats.inStock, 1);
  assert.equal(stats.assigned, 2);
  assert.equal(stats.repair, 1);
  assert.equal(stats.missing, 2, "lost and stolen are counted together — both mean it cannot be seen");
  assert.equal(stats.retired, 1);
  assert.equal(stats.heldByLeavers, 2);
  assert.equal(
    stats.valueHeldByLeaversEgp,
    37000,
    "the value at risk is the AGREED value on each signed receipt, summed",
  );
  assert.equal(
    stats.withoutValue,
    1,
    "a device with no estimated value is one البند (10) can recover nothing against, and is counted",
  );
}

/**
 * The clearance view groups by PERSON, not by device.
 *
 * The question at an exit is not "where is PHX-LAP-0007" but "what does this person still have and
 * what is it worth" — the return protocol says final dues are not paid before it is completed, so
 * this is the shape somebody preparing a settlement needs.
 */
function testLeaversAreGroupedWithTheirTotals(): void {
  const leavers = buildLeaversHolding(
    [
      deviceFixture({
        id: "a",
        assetTag: "PHX-LAP-0001",
        assignmentId: "as-1",
        holderHrId: "B-155",
        holderName: "Nour Adel",
        isHeldByLeaver: true,
        holderLastWorkingDate: "2026-08-08",
        daysSinceHolderLeft: 30,
        agreedValueEgp: 25000,
      }),
      deviceFixture({
        id: "b",
        assetTag: "PHX-TAB-0042",
        category: "tablet",
        serialNumber: null,
        imei: "356938035643809",
        assignmentId: "as-2",
        // MIXED CASE on purpose — hr_id is mixed case in this database, and a grouping that keyed
        // on the raw value would split one person into two rows owing half each.
        holderHrId: "b-155",
        holderName: "Nour Adel",
        isHeldByLeaver: true,
        holderLastWorkingDate: "2026-08-08",
        daysSinceHolderLeft: 30,
        agreedValueEgp: 9000,
      }),
      deviceFixture({
        id: "c",
        assignmentId: "as-3",
        holderHrId: "A-8",
        holderName: "Rasha Kamel",
        isHeldByLeaver: true,
        holderLastWorkingDate: "2026-09-01",
        daysSinceHolderLeft: 6,
        agreedValueEgp: 25000,
      }),
      // Not a leaver — must not appear at all.
      deviceFixture({ id: "d", assignmentId: "as-4", holderHrId: "C-9", holderName: "Still Here" }),
    ],
    TODAY,
  );

  assert.equal(leavers.length, 2, "two people, not four devices and not three");

  const nour = leavers.find((leaver) => leaver.employeeHrId.toLowerCase() === "b-155");
  assert.ok(nour, "B-155 must be grouped once");
  assert.equal(nour.devices.length, 2, "B-155 and b-155 are one person holding two devices");
  assert.equal(nour.totalValueEgp, 34000, "and one total across both");

  // The identifier is what a police report asks for, and it differs per device.
  const identifiers = nour.devices.map((device) => device.identifier).sort();
  assert.deepEqual(identifiers, ["356938035643809", "7XKQ2V3"]);

  assert.equal(leavers[0].employeeHrId.toLowerCase(), "b-155", "longest outstanding first");
  assert.ok(
    !leavers.some((leaver) => leaver.employeeName === "Still Here"),
    "somebody who still works here is not on the clearance list",
  );
}

/** Serial, or IMEI when there is no serial. Both are refused as absent by the table's CHECK. */
function testTheIdentifierPrefersTheSerial(): void {
  assert.equal(deviceIdentifier({ serialNumber: "7XKQ2V3", imei: "356938035643809" }), "7XKQ2V3");
  assert.equal(deviceIdentifier({ serialNumber: null, imei: "356938035643809" }), "356938035643809");
  assert.equal(deviceIdentifier({ serialNumber: null, imei: null }), "");
}

// ---------------------------------------------------------------------------------------------
// Boundary guards — the API takes arbitrary JSON
// ---------------------------------------------------------------------------------------------

function testTheBoundaryGuardsRefuseAnUnknownString(): void {
  assert.equal(isDeviceCategory("laptop"), true);
  assert.equal(isDeviceCategory("desktop"), false);
  assert.equal(isReturnCondition("damaged"), true);
  assert.equal(isReturnCondition("fine"), false);

  /**
   * `assigned` is deliberately NOT markable. A device becomes assigned by being ISSUED — that is
   * what `phx_device_issue` means — and letting it be typed would produce a device recorded as
   * held by nobody in particular, which is the state the paper filing cabinet is already in.
   */
  assert.equal(isMarkableDeviceStatus("lost"), true);
  assert.equal(isMarkableDeviceStatus("in_stock"), true);
  assert.equal(
    isMarkableDeviceStatus("assigned"),
    false,
    "a device is made assigned by issuing it, never by marking it",
  );
}

/** Money from JSON. A negative recovery is not a correction, it is a payment to the leaver. */
function testAmountParsingRefusesNonsense(): void {
  assert.equal(parseAmount(25000), 25000);
  assert.equal(parseAmount("25000"), 25000);
  assert.equal(parseAmount(""), null, "an empty field means no value, not zero");
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(-1), null, "a negative settlement would pay the leaver to keep the laptop");
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount(Number.POSITIVE_INFINITY), null);
}

/**
 * A missing table must read as "not ready", never as "the company owns no devices".
 *
 * AGENTS.md §7: when a data source is unavailable the UI says so rather than showing a misleading
 * zero — and an empty asset register is the most misleading zero this module could produce, because
 * it is indistinguishable from a correct answer.
 */
function testAMissingSchemaIsDistinguishedFromAnEmptyRegister(): void {
  assert.equal(
    isDeviceRegisterSchemaMissing(new Error('relation "public.company_devices" does not exist')),
    true,
  );
  assert.equal(
    isDeviceRegisterSchemaMissing(new Error("Could not find the function public.phx_device_issue")),
    true,
  );
  assert.equal(
    isDeviceRegisterSchemaMissing(new Error("Device PHX-LAP-0001 is already signed out to somebody.")),
    false,
    "a working guard refusing a bad request is not a missing schema",
  );
}

// ---------------------------------------------------------------------------------------------
// The rules that live in the database
// ---------------------------------------------------------------------------------------------

function migrationSql(): string {
  return readFileSync(MIGRATION, "utf8");
}

/**
 * البند (10) caps recovery at the estimated value shown at signature, and the cap is enforced in
 * BOTH places a settlement can be written.
 *
 * This is money coming out of somebody's wages under a signed instrument. A cap enforced only in
 * the service is a cap the next caller does not have.
 */
function testTheSettlementCapIsInTheDatabase(): void {
  const sql = migrationSql();

  assert.ok(
    /constraint device_assignments_settlement_within_agreed check \(/i.test(sql),
    "the cap must exist as a table CONSTRAINT, not only as a function check",
  );
  assert.ok(
    /settlement_egp <= agreed_value_egp/.test(sql),
    "the constraint must actually compare the settlement to the agreed value",
  );

  const guards = sql.match(/p_settlement_egp > v_row\.agreed_value_egp/g) ?? [];
  assert.equal(
    guards.length,
    2,
    "both phx_device_return and phx_device_write_off must refuse a settlement above the agreed value — " +
      `found ${guards.length}`,
  );
}

/**
 * The value is FROZEN onto the assignment at issue.
 *
 * البند (9) makes the value the holder saw and accepted at signature the agreed one. Reading it
 * live off the device would let a later revaluation silently change what somebody had already
 * signed for — and change it in the direction of owing more.
 */
function testTheAgreedValueIsSnapshottedAtIssue(): void {
  const sql = migrationSql();

  const issueFn = sql.slice(
    sql.indexOf("function public.phx_device_issue"),
    sql.indexOf("function public.phx_device_return"),
  );
  assert.ok(issueFn.length > 0, "phx_device_issue must exist");
  assert.ok(
    /insert into public\.device_assignments \([\s\S]*?agreed_value_egp/.test(issueFn),
    "the insert must name agreed_value_egp",
  );
  assert.ok(
    /v_device\.estimated_value_egp/.test(issueFn),
    "and it must fill that column from the DEVICE's estimated value, at issue",
  );

  /**
   * The freeze: nothing after the issue may write `agreed_value_egp` again.
   *
   * Asserted over the whole file MINUS the issue function, because that is the property that
   * matters — not "the return path happens not to", but "no path does". A revaluation reaching a
   * signed assignment would change what somebody already accepted under البند (9), in the direction
   * of owing more.
   */
  const afterIssue = sql.replace(issueFn, "");
  assert.ok(
    !/agreed_value_egp\s*=/.test(afterIssue),
    "nothing after the issue may assign to agreed_value_egp — it is frozen at signature by البند (9)",
  );
}

/**
 * A lost or stolen device does NOT release its holder.
 *
 * The instinct is that losing the device ends the custody. البند (10) says the opposite — where it
 * is not returned, the holder owes its value — and البند (11) excuses him only once he has proved
 * force majeure and filed the محضر البند (5) requires. Closing the assignment on `lost` would erase
 * the debt at the exact moment it is incurred.
 */
function testMarkingADeviceLostLeavesTheCustodyOutstanding(): void {
  const sql = migrationSql();
  const markFn = sql.slice(sql.indexOf("function public.phx_device_mark"), sql.indexOf("function public.phx_device_write_off"));
  assert.ok(markFn.length > 0, "phx_device_mark must exist");

  assert.ok(
    !/update public\.device_assignments/i.test(markFn),
    "phx_device_mark must not touch device_assignments at all — losing a device does not end the custody",
  );

  // And the mirror image: a signed-out device cannot be quietly returned to stock.
  assert.ok(
    /p_status = 'in_stock' and exists \(\s*select 1 from public\.device_assignments/i.test(markFn),
    "putting a device back in stock while it is signed out must be refused",
  );
}

/** One live holder per device, enforced by an index rather than by whoever wrote the last screen. */
function testOneLiveHolderPerDevice(): void {
  const sql = migrationSql();
  assert.ok(
    /create unique index if not exists uq_device_assignments_outstanding_device\s*\n\s*on public\.device_assignments \(device_id\)\s*\n\s*where status = 'outstanding';/i.test(
      sql,
    ),
    "a partial unique index must stop two people each holding a signed receipt for one machine",
  );
}

/** A device row that identifies nothing is refused, not stored as false coverage. */
function testADeviceMustBeIdentifiable(): void {
  const sql = migrationSql();
  assert.ok(
    /constraint company_devices_identifiable check \([\s\S]{0,300}serial_number is not null[\s\S]{0,300}or[\s\S]{0,300}imei is not null/i.test(
      sql,
    ),
    "a device with neither a serial nor an IMEI identifies nothing to anybody and must be refused",
  );
}

/**
 * Every SECURITY DEFINER function revokes EXECUTE from PUBLIC.
 *
 * A SECURITY DEFINER function runs as its owner and bypasses RLS by design, so the default ACL
 * granting EXECUTE to PUBLIC is a hole straight through the application-scoped posture these tables
 * rely on. `scripts/check-migrations.mjs` enforces the same rule; this pins it per function, so a
 * fifth function added later without a revoke is named rather than merely counted.
 */
function testEverySecurityDefinerFunctionIsLockedDown(): void {
  const sql = migrationSql();
  const defined = [...sql.matchAll(/create or replace function public\.(phx_device_[a-z_]+)\s*\(/g)].map(
    (match) => match[1],
  );
  assert.equal(defined.length, 4, `expected four device functions, found ${defined.join(", ")}`);

  for (const name of defined) {
    assert.ok(
      new RegExp(`security definer`, "i").test(sql),
      `${name} must be security definer`,
    );
    assert.ok(
      new RegExp(`revoke execute on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`, "i").test(sql),
      `${name} must revoke EXECUTE from public, anon and authenticated`,
    );
    assert.ok(
      new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role;`, "i").test(sql),
      `${name} must re-grant EXECUTE to service_role — revoking PUBLIC strips it too`,
    );
  }
}

/** Both tables carry RLS, matching the application-scoped posture the rest of this app uses. */
function testBothTablesEnableRowLevelSecurity(): void {
  const sql = migrationSql();
  for (const table of ["company_devices", "device_assignments"]) {
    assert.ok(
      new RegExp(`alter table public\\.${table} enable row level security;`, "i").test(sql),
      `${table} must have RLS enabled`,
    );
  }
  assert.ok(
    !/grant (select|insert|update|delete|all)[^;]*\bto\b[^;]*\bauthenticated\b/i.test(sql),
    "no authenticated grant — every read here goes through the service-role client behind assertPermission",
  );
}

/**
 * The register starts EMPTY, and that is the opposite call to the mailbox register's backfill.
 *
 * The mailbox register backfilled because those rows were a present exposure that could be DERIVED
 * from `employees.work_email`. There is no equivalent source here: no table, column or file records
 * which laptop anybody holds. A backfill would have to invent serials, and an invented serial in an
 * asset register is worse than an empty one, because it reads as evidence.
 */
function testTheRegisterIsNotBackfilled(): void {
  const sql = migrationSql();
  assert.ok(
    !/insert into public\.company_devices/i.test(sql),
    "nothing may seed the device register — an invented serial reads as evidence",
  );
  assert.ok(
    !/insert into public\.device_assignments/i.test(sql.replace(/create or replace function[\s\S]*/i, "")),
    "and nothing may seed custody records outside the issue function",
  );
}

// ---------------------------------------------------------------------------------------------
// The permission is its own, and it is not the personnel file
// ---------------------------------------------------------------------------------------------

/**
 * `company_devices` must be a resource of its own.
 *
 * Riding on `employees` would have forced one of two wrong outcomes: either HR Operations cannot
 * hand somebody a laptop, or handing somebody a laptop requires the permission that opens salaries
 * and national IDs. The same reasoning `crm_plans` and `territory` carry in that file.
 */
function testTheResourceIsDeclaredAndScoped(): void {
  const permissions = readFileSync("src/lib/auth/permissions.ts", "utf8");
  assert.ok(/\|\s*"company_devices"/.test(permissions), "the union must carry company_devices");
  assert.ok(
    /"company_devices",/.test(permissions),
    "and the runtime permissionResources array must carry it too — a key the lookup has never seen is treated as PERMITTED",
  );

  const scope = permissions.slice(permissions.indexOf('case "company_devices":'));
  const block = scope.slice(0, scope.indexOf("case ", 10));
  assert.ok(/role === "Super Admin"/.test(block) && /allActions/.test(block), "Super Admin holds it all");
  assert.ok(/role === "HR Operations"/.test(block), "HR Operations runs the custody paperwork");
  assert.ok(
    /role === "CEO"\) return \["read", "export"\]/.test(block),
    "the CEO observes, and does not record a handover or price a settlement",
  );
  assert.ok(
    !/"HR Operations"\) return allActions/.test(block),
    "HR Operations must NOT hold delete — a custody row is the basis of a wage deduction under البند (10)",
  );
}

/**
 * Every column this module reads from `employees` actually exists on that table.
 *
 * THIS TEST EXISTS BECAUSE THE OBVIOUS ONE SHIPPED. `loadAssignableEmployees` selected
 * `is_active` as a second guard beside `employment_status` — a reasonable-looking belt-and-braces,
 * and the column is real elsewhere in this database (`app_auth_users.is_active`,
 * `user_access_profiles.is_active`). It does not exist on `public.employees`, on staging or on
 * production. PostgREST answers an unknown column with an error rather than ignoring it, so the
 * register's entire read would have thrown and the page would have rendered its error state
 * instead of a person picker.
 *
 * Nothing in the suite could see that: there is no database here, the typecheck cannot type a
 * string, and every unit test passed. It was found by applying the migration to staging and asking
 * `information_schema` — which is the general lesson (AGENTS.md §1.2: verify against live reality,
 * not against a plan).
 *
 * The allowlist below was READ OFF BOTH DATABASES on 2026-09-07, not recalled. It is deliberately
 * short: a column added here without checking is the exact mistake this pins, so widening it is
 * meant to require going and looking.
 */
function testEveryEmployeesColumnThisModuleReadsExists(): void {
  // Verified 2026-09-07 against information_schema on staging (cifwmndunmlxjhyjugxa) AND
  // production (ozucdzovmcqvepbozvqf). `is_active` is NOT among them, deliberately.
  const KNOWN_EMPLOYEE_COLUMNS = new Set([
    "hr_id",
    "full_name",
    "nickname",
    "job_title",
    "employment_status",
    "last_working_date",
    "work_email",
  ]);

  const source = readFileSync("src/lib/devices/service.ts", "utf8");
  const selects = [
    ...source.matchAll(/\.from\("employees"\)\s*\n?\s*\.select\("([^"]+)"\)/g),
  ].map((match) => match[1]);

  assert.ok(selects.length > 0, "expected this module to read the employees table");

  for (const select of selects) {
    for (const column of select.split(",").map((value) => value.trim()).filter(Boolean)) {
      assert.ok(
        KNOWN_EMPLOYEE_COLUMNS.has(column),
        `src/lib/devices/service.ts selects "${column}" from employees, which is not in the set ` +
          `verified to exist on that table. PostgREST ERRORS on an unknown column, so this would ` +
          `take the whole register down rather than being ignored — go and read ` +
          `information_schema before adding it here.`,
      );
    }
  }
}

/** The API declares both gates in the access registry, and the mutation is CSRF-guarded. */
function testTheApiIsDeclaredInTheAccessRegistry(): void {
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  const rows = registry.split("\n").filter((line) => line.includes('pattern: "/api/devices"'));
  assert.equal(rows.length, 2, "one read declaration and one mutation declaration");

  const mutation = rows.find((row) => row.includes('"POST"'));
  assert.ok(mutation, "the POST must be declared");
  assert.ok(mutation.includes("csrfRequired: true"), "the mutation must be CSRF-guarded");
  assert.ok(
    mutation.includes("required: true"),
    "every device mutation is an attestation that somebody physically moved company property — the audit row is required",
  );
}

export function runDeviceRegisterTests(): void {
  testAnActiveHoldersDeviceIsNotFlagged();
  testALeaversDeviceIsFlaggedAndAged();
  testAnUnknownHolderCountsAsALeaver();
  testADeviceInStockIsNeverFlagged();
  testANoticePeriodIsNotOverdue();
  testStatsCountWhatIsAtRisk();
  testLeaversAreGroupedWithTheirTotals();
  testTheIdentifierPrefersTheSerial();
  testTheBoundaryGuardsRefuseAnUnknownString();
  testAmountParsingRefusesNonsense();
  testAMissingSchemaIsDistinguishedFromAnEmptyRegister();
  testTheSettlementCapIsInTheDatabase();
  testTheAgreedValueIsSnapshottedAtIssue();
  testMarkingADeviceLostLeavesTheCustodyOutstanding();
  testOneLiveHolderPerDevice();
  testADeviceMustBeIdentifiable();
  testEverySecurityDefinerFunctionIsLockedDown();
  testBothTablesEnableRowLevelSecurity();
  testTheRegisterIsNotBackfilled();
  testEveryEmployeesColumnThisModuleReadsExists();
  testTheResourceIsDeclaredAndScoped();
  testTheApiIsDeclaredInTheAccessRegistry();
}

// Silences the unused-import lint for a type used only in a cast above.
export type { DeviceStatus };
