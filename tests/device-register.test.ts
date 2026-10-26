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
import {
  DEVICE_NEEDS_AN_IDENTITY,
  DeviceIdentityCorrectionError,
  imeiFieldHolds,
  imeisMatch,
  parseTypedImei,
  planIdentityCorrection,
  type IdentityCorrectionRequest,
  type IdentityEntry,
} from "../src/lib/devices/device-identity.ts";
import { permissionMatrix, phoenixRoles } from "../src/lib/auth/permissions.ts";
import { stripComments } from "./support/comment-strip.ts";
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
    itemValuesEgp: null,
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

/**
 * The custody receipt printed from a row carries THAT device, and the right one of the two forms.
 *
 * This is where the register pays for itself, and it is a link that is easy to leave half-built:
 * `getHiringPack` grew a `custodyDeviceId` parameter and `renderHiringPaper` forwards it, but until
 * something actually PASSES one the whole path is unreachable and the form keeps printing blanks
 * while every unit test stays green. So the assertion is on the caller, not on the plumbing.
 *
 * `custodyLaptop` is نموذج رقم 1 with the Windows block; everything portable takes `custodyMobile`,
 * نموذج رقم 2 with IMEI and SIM. The register already knows which, so nobody has to choose — and
 * choosing wrong would print a page asking for an IMEI about a laptop.
 */
function testThePrintLinkCarriesTheDeviceAndPicksTheRightForm(): void {
  const source = readFileSync("src/components/devices/device-register-workspace.tsx", "utf8");

  // Since 2026-09-20 every print asks copies and address first, so the row no longer carries an
  // `href`: its Print button opens `PrintOptionsDialog`, and the dialog's confirm opens this URL.
  assert.ok(
    /<PrintOptionsDialog/.test(source),
    "the device row must ask copies and address before it prints a custody receipt",
  );
  const href = source.match(/`(\/api\/hiring-pack\/[^`]*)`/);
  assert.ok(href, "the device row must offer a link to print this device's custody receipt");

  assert.ok(
    href[1].includes("deviceId=${encodeURIComponent(device.id)}"),
    `the print link is "${href[1]}" — without deviceId the receipt prints ruled blanks and the ` +
      `register may as well not exist`,
  );
  assert.ok(
    /device\.category === "laptop" \? "custodyLaptop" : "custodyMobile"/.test(source),
    "a laptop must take نموذج رقم 1 and anything portable نموذج رقم 2",
  );
  assert.ok(
    /device\.holderHrId/.test(href[1]),
    "the receipt is printed for the HOLDER — a custody receipt naming nobody is not a receipt",
  );
  assert.ok(
    /\{device\.assignmentId && device\.holderHrId \?/.test(source),
    "and it is only offered while the device is signed out to somebody",
  );

  // The route must actually read the parameter the link sends. Two files, one contract — the
  // commonest way this breaks is renaming one end.
  const route = readFileSync("app/api/hiring-pack/[hrId]/print/route.ts", "utf8");
  assert.ok(
    /custodyDeviceId: url\.searchParams\.get\("deviceId"\)/.test(route),
    "the print route must forward deviceId= to the renderer, or the link is inert",
  );
  const renderer = readFileSync("src/lib/hiring-pack/render-paper.ts", "utf8");
  assert.ok(
    /getHiringPack\(hrId, input\.custodyDeviceId \?\? null\)/.test(renderer),
    "and renderHiringPaper must pass it on to getHiringPack",
  );
}

/**
 * The PDF of a custody receipt is the SAME paper as its page - the device facts are not dropped.
 *
 * `format=pdf` renders its own single copy, and it once listed the renderer's inputs by hand and
 * left `deviceId` out: the page filled the Manufacturer / Serial / Device name / Processor / RAM
 * block and the item values, the download printed them as ruled blanks (OF-0006, DEC-2026-0003,
 * 26 Oct 2026). The inputs that choose the paper are now written once (`paperInput`) and spread
 * into both renders, so this pins that shape: the object carries the device, both calls spread it,
 * and the PDF call lists nothing of its own but the two counts that differ by design.
 *
 * Reads CODE only - comments are stripped first, because a comment explaining the spread is
 * enough to satisfy a bare `includes` after the spread itself is deleted.
 */
function testThePdfOfACustodyReceiptCarriesTheSameDeviceAsThePage(): void {
  const raw = readFileSync("app/api/hiring-pack/[hrId]/print/route.ts", "utf8");
  const code = stripComments(raw);

  const input = code.match(/const paperInput = \{([\s\S]*?)\n {4}\};/);
  assert.ok(input, "the route must build the paper's inputs once, as `paperInput`");
  assert.ok(
    /custodyDeviceId: url\.searchParams\.get\("deviceId"\)/.test(input[1]),
    "paperInput must carry deviceId= - without it the PDF prints the custody receipt as ruled blanks",
  );

  const renders = [...code.matchAll(/await renderHiringPaper\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
  assert.equal(renders.length, 2, "the route renders twice: the page, and the single PDF copy");
  for (const body of renders) {
    assert.ok(
      /\.\.\.paperInput/.test(body),
      "both renders must spread paperInput, or the PDF and the page resolve different papers",
    );
  }

  const pdfStart = code.indexOf('url.searchParams.get("format") === "pdf"');
  assert.ok(pdfStart > 0, "the format=pdf branch must exist");
  const pdfRender = renders.find((body) => code.indexOf(body) > pdfStart);
  assert.ok(pdfRender, "the format=pdf branch must render its own copy");
  const own = [...pdfRender.matchAll(/^\s*([A-Za-z]+)[:,]/gm)].map((m) => m[1]).sort();
  assert.deepEqual(
    own,
    ["copies", "statedCopies"],
    "the PDF render may add only the counts that differ by design - any other hand-listed " +
      "input is how deviceId was dropped",
  );
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

// ---------------------------------------------------------------------------------------------
// Correcting an existing entry's serial number and IMEI
// ---------------------------------------------------------------------------------------------

/**
 * WHY THIS EXISTS. `createDevice` wrote an entry's serial and IMEI once and nothing could change
 * them, so a wrong IMEI stayed wrong for good — and Rep Tablets' "the register has a different
 * IMEI" warning (`register_differs`) told the operator to dial *#06# with no screen to act on the
 * answer. The correction is Super Admin only and needs a reason (owner, 2026-09-18).
 */
const ENTRY: IdentityEntry = {
  assetTag: "PHX-TAB-0007",
  id: "device-7",
  imei: "351234567890124",
  serialNumber: "R52W1234ABC",
};

/** The sentence a correction is refused with — or a failure if it was not refused, or refused as a 500. */
function refusal(run: () => unknown): string {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof DeviceIdentityCorrectionError,
    caught === null
      ? "expected the correction to be refused, and it was accepted"
      : `a caller-wrong correction must refuse with DeviceIdentityCorrectionError (the route answers it 400), got ${String(caught)}`,
  );
  return caught.message;
}

/** A correction saved from an editor that opened on `current` as it is — what the register sends. */
function correct(
  current: IdentityEntry,
  request: Pick<IdentityCorrectionRequest, "serialNumber" | "imei" | "reason">,
  others: readonly IdentityEntry[],
) {
  return planIdentityCorrection(
    current,
    { ...request, shownImei: current.imei, shownSerialNumber: current.serialNumber },
    others,
  );
}

/** An IMEI as typed is read as its digits; anything that is not 14 or 15 digits is refused. */
function testATypedImeiIsReadAsItsDigits(): void {
  assert.equal(parseTypedImei("35-123456-789012-3"), "351234567890123");
  assert.equal(parseTypedImei(" 35 123456 789012 3 "), "351234567890123");
  assert.equal(parseTypedImei("35.123456.789012.3"), "351234567890123");
  assert.equal(parseTypedImei("35123456789012"), "35123456789012", "14 digits — the check digit left off — is an IMEI the register has always carried");
  assert.equal(parseTypedImei("٣٥١٢٣٤٥٦٧٨٩٠١٢٣"), "351234567890123", "Arabic-Indic digits are the same digits");
  assert.equal(parseTypedImei("   "), null, "a blank IMEI is no IMEI, not a malformed one");
  assert.equal(parseTypedImei(null), null);
  assert.match(refusal(() => parseTypedImei("35123456789012O")), /not an IMEI/, "a letter O typed for a zero is refused, never dropped");
  assert.match(refusal(() => parseTypedImei("3512345678901")), /13 digits/);
  assert.match(refusal(() => parseTypedImei("3512345678901234")), /16 digits/);
}

/**
 * THE HEADLINE. Another entry's IMEI is refused when the DIGITS match, however either was typed.
 * `uq_company_devices_imei` compares `lower(imei)` — text — so it lets "35-123456-789012-3" and
 * "351234567890123" sit on two entries; this is the check that does not.
 */
function testAnImeiAnotherEntryHoldsIsRefusedOnDigits(): void {
  assert.notEqual(
    "35-123456-789012-3".toLowerCase(),
    "351234567890123".toLowerCase(),
    "the database's unique index compares these as different text — which is why this check is on digits",
  );

  const dashed: IdentityEntry = { assetTag: "PHX-TAB-0003", id: "device-3", imei: "35-123456-789012-3", serialNumber: "R52W0003" };
  const message = refusal(() =>
    correct(
      ENTRY,
      { imei: "351234567890123", reason: "Typed wrong at registration", serialNumber: ENTRY.serialNumber },
      [ENTRY, dashed],
    ),
  );
  assert.match(message, /PHX-TAB-0003/, "the refusal names the entry that already holds the IMEI");

  const checkDigitDropped: IdentityEntry = { ...dashed, imei: "35123456789012" };
  refusal(() =>
    correct(
      ENTRY,
      { imei: "351234567890123", reason: "Typed wrong at registration", serialNumber: ENTRY.serialNumber },
      [checkDigitDropped],
    ),
  );
  assert.ok(imeisMatch("35123456789012", "351234567890123"), "14 digits match their own 15-digit IMEI");
  assert.ok(!imeisMatch("35123456789012", "351234567890993"), "and nothing else");
}

/**
 * The other entry's IMEI field is FREE TEXT — the register form and the bulk import store what they
 * are given. A label, a dual-SIM phone's second IMEI or Arabic-Indic digits must not hide the IMEI
 * it holds: reduced to one number they did ("IMEI1: 351…" is sixteen digits, the "1" kept; a
 * dual-SIM pair is thirty; Arabic-Indic digits are no digits at all), and the text-based unique
 * index lets every one of them through.
 */
function testAnImeiIsFoundWhereverAnotherEntryWroteIt(): void {
  const request = { imei: "351234567890123", reason: "Dialled *#06# on the tablet", serialNumber: ENTRY.serialNumber };
  const shapes: Array<[string, string]> = [
    ["IMEI1: 351234567890123", "a labelled IMEI"],
    ["351234567890123 / 351234567890131", "the first of a dual-SIM pair"],
    ["351234567890131 / 35-123456-789012-3", "the second of a dual-SIM pair, dashed"],
    ["٣٥١٢٣٤٥٦٧٨٩٠١٢٣", "Arabic-Indic digits"],
    ["35123456789012", "the check digit left off"],
  ];
  for (const [field, shape] of shapes) {
    const holder: IdentityEntry = { assetTag: "PHX-PHN-0002", id: "device-2", imei: field, serialNumber: "RF8N0002" };
    assert.ok(imeiFieldHolds(field, request.imei), `${shape} holds the IMEI: ${field}`);
    assert.match(
      refusal(() => correct(ENTRY, request, [ENTRY, holder])),
      /PHX-PHN-0002 already holds the IMEI/,
      `${shape} is refused, naming the entry that holds it: ${field}`,
    );
  }
  assert.ok(!imeiFieldHolds("351234567890131 / 356938035643809", "351234567890123"), "a different pair does not hold it");
  assert.ok(!imeiFieldHolds(null, "351234567890123"));
}

/**
 * An IMEI left exactly as it is stored is kept as it is — never read as one number. Otherwise a
 * dual-SIM phone's serial could not be fixed without deleting one of its IMEIs from the register.
 */
function testAStoredImeiThatIsNotOneNumberSurvivesASerialFix(): void {
  const dualSim: IdentityEntry = { ...ENTRY, imei: "351234567890123 / 351234567890131" };
  const plan = correct(dualSim, { imei: ` ${dualSim.imei} `, reason: "Serial read off the box", serialNumber: "R52W1234ABD" }, [dualSim]);
  assert.equal(plan.imei, dualSim.imei);
  assert.equal(plan.imeiChanged, false);
  assert.equal(plan.serialChanged, true);
}

/**
 * The editor sends the pair it opened on, and a save is refused when the entry holds something else
 * now. Rep Tablets copies a tablet's IMEI into an empty register entry by itself; a correction saved
 * from a form opened before that copy would have erased it, with no refusal.
 */
function testAFormOpenedOnOldValuesIsRefused(): void {
  const beforeTheCopy = { imei: "", reason: "Serial read off the box", serialNumber: "R52W1234ABD" };
  const message = refusal(() =>
    planIdentityCorrection(ENTRY, { ...beforeTheCopy, shownImei: null, shownSerialNumber: ENTRY.serialNumber }, [ENTRY]),
  );
  assert.match(message, /PHX-TAB-0007 changed after this form was opened/);
  assert.match(message, /IMEI 351234567890124/, "the refusal shows what the entry holds now");
  refusal(() =>
    planIdentityCorrection(
      ENTRY,
      { ...beforeTheCopy, imei: ENTRY.imei, shownImei: ENTRY.imei, shownSerialNumber: "R52W0000" },
      [ENTRY],
    ),
  );
  // Missing reads as "nothing recorded": a caller that leaves the pair out is refused, not waved through.
  refusal(() =>
    planIdentityCorrection(ENTRY, { ...beforeTheCopy, shownImei: undefined, shownSerialNumber: undefined }, [ENTRY]),
  );

  const route = readFileSync("app/api/devices/identity/route.ts", "utf8");
  assert.match(route, /shownSerialNumber: textOrNull\(payload\?\.shownSerialNumber\)/);
  assert.match(route, /shownImei: textOrNull\(payload\?\.shownImei\)/);
  const workspace = readFileSync("src/components/devices/device-register-workspace.tsx", "utf8");
  assert.match(workspace, /shownSerialNumber: shown\.serialNumber,\s*shownImei: shown\.imei,/, "the editor sends the pair it opened on");
  assert.match(workspace, /setShown\(\{ serialNumber: device\.serialNumber, imei: device\.imei \}\)/, "taken again each time it opens");
}

/** Serial numbers compare on letters and digits, ignoring case, spaces and dashes. */
function testASerialAnotherEntryHoldsIsRefused(): void {
  const other: IdentityEntry = { assetTag: "PHX-LAP-0011", id: "device-11", imei: null, serialNumber: "hs1-a2b3" };
  const message = refusal(() =>
    correct(ENTRY, { imei: ENTRY.imei, reason: "Serial read off the box", serialNumber: "HS1A2B3" }, [other]),
  );
  assert.match(message, /PHX-LAP-0011/);
}

/** The entry being corrected is never its own duplicate — adding a dropped check digit is allowed. */
function testTheEntryIsNotItsOwnDuplicate(): void {
  const current: IdentityEntry = { ...ENTRY, imei: "35123456789012" };
  const plan = correct(
    current,
    { imei: "351234567890123", reason: "Added the check digit from *#06#", serialNumber: current.serialNumber },
    [current],
  );
  assert.equal(plan.imei, "351234567890123");
  assert.equal(plan.imeiChanged, true);
  assert.equal(plan.serialChanged, false);
}

/** A written reason is required (owner, 2026-09-18), and kept to a length somebody can read. */
function testAReasonIsRequired(): void {
  for (const reason of [undefined, null, "", "   "]) {
    assert.match(
      refusal(() => correct(ENTRY, { imei: "351234567890125", reason, serialNumber: ENTRY.serialNumber }, [ENTRY])),
      /Say why/,
    );
  }
  refusal(() =>
    correct(ENTRY, { imei: "351234567890125", reason: "x".repeat(501), serialNumber: ENTRY.serialNumber }, [ENTRY]),
  );
  const plan = correct(
    ENTRY,
    { imei: "351234567890125", reason: "  Dialled *#06# on the tablet  ", serialNumber: ENTRY.serialNumber },
    [ENTRY],
  );
  assert.equal(plan.reason, "Dialled *#06# on the tablet");
}

/** `company_devices_identifiable`: a serial number or an IMEI must remain, in the same sentence as `createDevice`. */
function testACorrectionKeepsTheDeviceIdentifiable(): void {
  assert.equal(
    refusal(() => correct(ENTRY, { imei: " ", reason: "Clearing both", serialNumber: "" }, [ENTRY])),
    DEVICE_NEEDS_AN_IDENTITY,
  );
  const service = readFileSync("src/lib/devices/service.ts", "utf8");
  assert.ok(
    service.includes(DEVICE_NEEDS_AN_IDENTITY),
    "createDevice and the correction refuse an unidentifiable device with one sentence",
  );

  const serialOnly = correct(ENTRY, { imei: "", reason: "The IMEI belonged to another tablet", serialNumber: ENTRY.serialNumber }, [ENTRY]);
  assert.equal(serialOnly.imei, null, "removing one of the two is allowed while the other remains");
  assert.equal(serialOnly.serialNumber, ENTRY.serialNumber);
}

/**
 * Only what changed changes. An unchanged pair is refused rather than audited as a change, and an
 * IMEI whose digits are unchanged keeps the text already stored — fixing a serial does not quietly
 * rewrite a dashed IMEI into bare digits.
 */
function testOnlyWhatChangedIsWritten(): void {
  assert.match(
    refusal(() => correct(ENTRY, { imei: ENTRY.imei, reason: "No change", serialNumber: ` ${ENTRY.serialNumber} ` }, [ENTRY])),
    /nothing to correct/,
  );

  const dashed: IdentityEntry = { ...ENTRY, imei: "35-123456-789012-4" };
  const plan = correct(
    dashed,
    { imei: "351234567890124", reason: "Serial read off the box", serialNumber: "R52W1234ABD" },
    [dashed],
  );
  assert.equal(plan.imei, "35-123456-789012-4");
  assert.equal(plan.imeiChanged, false);
  assert.equal(plan.serialChanged, true);

  const typed = correct(ENTRY, { imei: "35 123456 789012 5", reason: "Dialled *#06#", serialNumber: ENTRY.serialNumber }, [ENTRY]);
  assert.equal(typed.imei, "351234567890125", "a changed IMEI is stored as its digits");
}

/**
 * The service refuses before it writes, writes the REQUIRED audit row with the old values BEFORE
 * the entry changes, and changes it only while it still holds what was read.
 */
function testTheCorrectionIsAuditedBeforeTheEntryChanges(): void {
  const service = readFileSync("src/lib/devices/service.ts", "utf8");
  const start = service.indexOf("export async function correctDeviceIdentity(");
  assert.ok(start !== -1, "correctDeviceIdentity must exist in the register's service");
  const body = service.slice(start, service.indexOf("\nexport ", start + 1));

  const planned = body.indexOf("planIdentityCorrection(");
  const audited = body.indexOf("await writeRequiredAuditLog({");
  const updated = body.indexOf(".update(");
  assert.ok(planned !== -1 && audited !== -1 && updated !== -1);
  assert.ok(planned < audited, "every refusal happens before anything is written");
  assert.ok(audited < updated, "the audit row is written BEFORE the register changes — no audit row, no change");
  assert.match(body, /oldValues: \{ serialNumber: row\.serial_number, imei: row\.imei \}/, "the audit row keeps the old values");
  assert.match(body, /newValues: \{ serialNumber: plan\.serialNumber, imei: plan\.imei, reason: plan\.reason \}/);
  // The change's own record is the REQUIRED writer. The best-effort one may appear only in the
  // failure path, after the update, to say a correction the first row announced did not land.
  const failurePath = body.indexOf("} catch (failure) {", updated);
  const bestEffort = body.indexOf("writeAuditLog(");
  assert.ok(failurePath !== -1, "a correction that fails after its audit row is caught");
  assert.ok(
    bestEffort === -1 || bestEffort > failurePath,
    "the best-effort audit writer would let the change land without its record — only the failure row may use it",
  );
  const failure = body.slice(failurePath);
  assert.match(failure, /was not applied/, "the failure row says the correction did not land");
  assert.match(failure, /const unchanged = !updateSent \|\| failure instanceof DeviceIdentityCorrectionError;/);
  assert.match(failure, /throw failure;/, "and the failure still reaches the person who pressed Save");
  assert.ok(body.indexOf("updateSent = true;") < body.indexOf('await update.select("id")'));
  assert.match(body, /update\.is\("serial_number", null\)/, "the update is conditional on the serial still being what was read");
  assert.match(body, /update\.eq\("imei", row\.imei\)/, "and on the IMEI still being what was read");
  assert.doesNotMatch(body, /\.upsert\(|\.insert\(|\.delete\(/);
  assert.match(
    service,
    /\.select\("id,asset_tag,serial_number,imei"\)[\s\S]{0,120}\.range\(/,
    "the duplicate check reads the whole register page by page, never a first page",
  );
}

/** The route: CSRF first, then the Super Admin permission, before the body is read or anything written. */
function testTheCorrectionRouteIsGuardedBeforeAnyWrite(): void {
  const route = readFileSync("app/api/devices/identity/route.ts", "utf8");
  const csrf = route.indexOf("assertSameOriginMutation(request)");
  const permission = route.indexOf('assertPermission(access, "company_devices", "approve")');
  const body = route.indexOf("request.json(");
  const write = route.indexOf("await correctDeviceIdentity(");
  assert.ok(csrf !== -1 && permission !== -1 && body !== -1 && write !== -1);
  assert.ok(csrf < permission, "the same-origin check runs first");
  assert.ok(permission < body && permission < write, "the permission is asserted before the body is read or anything written");
  assert.doesNotMatch(
    route,
    /"company_devices", "(update|create)"/,
    "HR Operations' update/create grant must not open this route — it is Super Admin only",
  );
  assert.match(route, /error instanceof DeviceIdentityCorrectionError\) return \{ message: error\.message, status: 400 \}/);
}

/** Declared as an audited, CSRF-guarded mutation on `company_devices:approve`. */
function testTheCorrectionIsDeclaredInTheAccessRegistry(): void {
  const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
  const rows = registry.split("\n").filter((line) => line.includes('pattern: "/api/devices/identity"'));
  assert.equal(rows.length, 1, "one declaration for the correction route");
  const [row] = rows;
  assert.ok(row.includes('methods: ["POST"]'));
  assert.ok(row.includes("csrfRequired: true"), "the correction must be CSRF-guarded");
  assert.ok(row.includes('audit: { classification: "mutation", required: true }'), "and its audit row required");
  assert.ok(row.includes('permission: { resource: "company_devices", action: "approve" }'), "on the Super Admin's action");
}

/** `company_devices:approve` is the Super Admin's alone — the owner's answer to who may correct. */
function testOnlyTheSuperAdminMayCorrect(): void {
  const holders = phoenixRoles.filter((role) => (permissionMatrix[role]?.company_devices ?? []).includes("approve"));
  assert.deepEqual(holders, ["Super Admin"]);

  const page = readFileSync("app/(admin)/devices/page.tsx", "utf8");
  assert.match(page, /canCorrectIdentity = await canAccess\(access, "company_devices", "approve"\)/);
  const workspace = readFileSync("src/components/devices/device-register-workspace.tsx", "utf8");
  assert.match(workspace, /fetch\("\/api\/devices\/identity"/);
  assert.match(workspace, /correctIdentity=\{canCorrectIdentity \? correctIdentity : null\}/);

  // Rep Tablets' warning links to the correction instead of leaving the operator with no screen.
  const repTablets = readFileSync("src/components/devices/rep-tablets-console.tsx", "utf8");
  assert.match(repTablets, /href: `\/devices\?correct=\$\{encodeURIComponent\(row\.registerDeviceId\)\}`/);
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
  testThePrintLinkCarriesTheDeviceAndPicksTheRightForm();
  testThePdfOfACustodyReceiptCarriesTheSameDeviceAsThePage();
  testTheResourceIsDeclaredAndScoped();
  testTheApiIsDeclaredInTheAccessRegistry();
  testATypedImeiIsReadAsItsDigits();
  testAnImeiAnotherEntryHoldsIsRefusedOnDigits();
  testAnImeiIsFoundWhereverAnotherEntryWroteIt();
  testAStoredImeiThatIsNotOneNumberSurvivesASerialFix();
  testAFormOpenedOnOldValuesIsRefused();
  testASerialAnotherEntryHoldsIsRefused();
  testTheEntryIsNotItsOwnDuplicate();
  testAReasonIsRequired();
  testACorrectionKeepsTheDeviceIdentifiable();
  testOnlyWhatChangedIsWritten();
  testTheCorrectionIsAuditedBeforeTheEntryChanges();
  testTheCorrectionRouteIsGuardedBeforeAnyWrite();
  testTheCorrectionIsDeclaredInTheAccessRegistry();
  testOnlyTheSuperAdminMayCorrect();
  testABlankDeclarationNumberIsNumberedAutomatically();
}

/** A blank declaration number is numbered by the system on a signed handover; a typed one is kept. */
function testABlankDeclarationNumberIsNumberedAutomatically(): void {
  const service = readFileSync("src/lib/devices/service.ts", "utf8");
  assert.ok(service.includes("async function nextDeclarationNo"), "the numbering helper must exist");
  assert.ok(service.includes("`DEC-${year}-`"), "numbers read DEC-<year>-NNNN");
  const numbered = service.split("trimmed(input.declarationNo) ?? (await nextDeclarationNo(input.issuedOn))").length - 1;
  assert.equal(numbered, 2, "issueDevice and reconcileDevice both keep a typed number and number a blank one");
  const reserveStart = service.indexOf("export async function reserveDevice");
  const reserve = service.slice(reserveStart, service.indexOf("\n}\n", reserveStart));
  assert.ok(
    reserve.includes("trimmed(input.declarationNo)") && !reserve.includes("nextDeclarationNo"),
    "a reservation is not a signed custody, so it takes no automatic number",
  );
}

// Silences the unused-import lint for a type used only in a cast above.
export type { DeviceStatus };
