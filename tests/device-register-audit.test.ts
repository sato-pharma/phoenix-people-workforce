import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  declarationYear,
  deviceRegisterErrorStatus,
  holderRefusal,
  markRefusal,
  reconcileRefusal,
} from "../src/lib/devices/service.ts";
import {
  findRegistrationClash,
  imeiDuplicateKey,
  serialDuplicateKey,
  type IdentityEntry,
} from "../src/lib/devices/device-identity.ts";
import {
  buildDeviceImportPreviewFrom,
  cellDate,
  isCalendarDate,
  type DeviceImportRow,
  type DirectoryEntry,
  type ExistingRegisterKeys,
} from "../src/lib/devices/bulk-import.ts";
import { importActor } from "../src/lib/devices/import-attempt-log.ts";
import { resolveAction1NextPage } from "../src/lib/devices/action1.ts";
import { GOOGLE_TOKEN_TIMEOUT_MS, mintAndroidManagementToken } from "../src/lib/devices/android-management-auth.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * The device register audit of 9 Nov 2026 — one assertion per defect it fixed.
 *
 *  1. A handover dated 30 December keeps its year in its declaration number (the `/^d{4}/` typo).
 *  2. A new custody — issued or reconciled — never names somebody who has left; the import alone may.
 *  3. A reserved device is never marked (its reservation would be stranded), and a reservation is
 *     only reconciled while its device is still reserved — in the service AND in the database.
 *  4. One machine never enters the register twice because its serial or IMEI was typed differently.
 *  5. An import date is never guessed month-first, and "2026-02-30" is not a date.
 *  6. Every import press files the same person under the same actor.
 *  7. Action1's bearer token never follows a next-page link to another server.
 *  8. Google's token exchange cannot hang a request forever.
 *  9. The Android Enterprise signup is refused once Phoenix is bound — the route and the callback.
 * 10. A failed holder read raises rather than flagging a current employee as a leaver.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const code = (path: string) => stripComments(read(path));

function testDeclarationYearReadsTheHandoverDate(): void {
  const january = new Date("2027-01-02T10:00:00Z");
  assert.equal(
    declarationYear("2026-12-30", january),
    "2026",
    "a handover dated 30 Dec 2026 and saved on 2 Jan 2027 must be numbered in 2026's series",
  );
  assert.equal(declarationYear(null, january), "2027", "no handover date counts in this year (Cairo)");
  assert.equal(declarationYear("not a date", january), "2027", "an unreadable date counts in this year");
}

function testLeaversNeverReceiveANewCustody(): void {
  const leaver = { state: "left" as const, name: "Nour Adel", employmentStatus: "Resigned" };
  const issue = holderRefusal(leaver, "issue");
  assert.ok(issue && issue.startsWith("Issuing a device to Nour Adel is refused"), `issue to a leaver must be refused, got: ${issue}`);
  assert.ok(issue.includes("(resigned)"), "the status is named, lower-cased");
  const reconcile = holderRefusal(leaver, "reconcile");
  assert.ok(
    reconcile && reconcile.startsWith("Reconciling a reservation to Nour Adel is refused"),
    `reconcile to a leaver must be refused, got: ${reconcile}`,
  );
  assert.equal(holderRefusal({ state: "active", name: "Mona", employmentStatus: "Active" }, "issue"), null);
  assert.equal(holderRefusal(undefined, "issue"), null, "a person with no directory row is the database's to refuse");
  assert.equal(deviceRegisterErrorStatus(issue), 400, "a leaver refusal is the caller's mistake (400)");
  assert.equal(deviceRegisterErrorStatus(reconcile), 400);

  const service = code("src/lib/devices/service.ts");
  assert.match(
    service,
    /export async function issueDevice\([^)]*options: \{ allowLeaver\?: boolean \} = \{\}[\s\S]{0,200}if \(!options\.allowLeaver\)/,
    "issueDevice must refuse a leaver unless the caller passes allowLeaver",
  );
  assert.match(
    code("src/lib/devices/bulk-import.ts"),
    /\{ allowLeaver: true \}/,
    "the bulk import — custody that already exists — is the one door that may name a leaver",
  );
}

function testReservedDevicesAreNotMarkedAndReconcileNeedsAReservedDevice(): void {
  const mark = markRefusal({ status: "reserved", assetTag: "PHX-TAB-0042" });
  assert.ok(mark && mark.startsWith("Marking PHX-TAB-0042 is refused while it is reserved"), `got: ${mark}`);
  assert.equal(deviceRegisterErrorStatus(mark), 400);
  assert.equal(markRefusal({ status: "in_stock", assetTag: "PHX-TAB-0042" }), null, "a device that is not reserved may be marked");

  const lost = reconcileRefusal({ status: "lost", assetTag: "PHX-TAB-0042" });
  assert.ok(lost && lost.includes("the device is lost now, not reserved"), `a lost device must not be reconciled, got: ${lost}`);
  assert.equal(deviceRegisterErrorStatus(lost), 400);
  assert.equal(reconcileRefusal({ status: "reserved", assetTag: "PHX-TAB-0042" }), null, "a reserved device may be reconciled");
  assert.ok(reconcileRefusal(null), "a reservation whose device is gone is refused");

  assert.equal(
    deviceRegisterErrorStatus("That custody record is closed, so its items can no longer be priced."),
    400,
    "pricing a closed handover is the caller's mistake, not a server failure",
  );
  assert.equal(deviceRegisterErrorStatus("connection reset"), 500);
}

function testTheServiceRefusesBeforeItWrites(): void {
  const service = code("src/lib/devices/service.ts");
  assert.match(
    service,
    /export async function markDevice[\s\S]{0,900}if \(readError\) throw new Error\(deviceErrorMessage\(readError\)\);/,
    "markDevice must raise a failed read rather than treat an unreadable device as not reserved",
  );
  assert.match(
    service,
    /export async function markDevice[\s\S]{0,1200}markRefusal\([^;]*\);\s*if \(refusal\) throw new Error\(refusal\);[\s\S]{0,600}writeRequiredAuditLog/,
    "markDevice must refuse a reserved device before the audit and the write",
  );
  assert.match(
    service,
    /export async function reconcileDevice[\s\S]{0,2400}reconcileRefusal\([^;]*\);\s*if \(deviceRefusal\) throw new Error\(deviceRefusal\);[\s\S]{0,400}holderRefusal\([^;]*\);\s*if \(leaverRefusal\) throw new Error\(leaverRefusal\);[\s\S]{0,400}writeRequiredAuditLog/,
    "reconcileDevice must refuse a non-reserved device and a leaver before the audit and the write",
  );
}

function testTheDatabaseRefusesTheSame(): void {
  const sql = stripSqlComments(read("supabase/migrations/20261109030915_device_custody_state_guards.sql"));
  assert.match(sql, /from public\.company_devices where id = p_device_id for update/, "mark locks the device row");
  assert.match(
    sql,
    /if v_device\.status = 'reserved' or exists \(\s*select 1 from public\.device_assignments\s*where device_id = p_device_id and status = 'reserved'\s*\) then\s*raise exception\s*'Marking % is refused while it is reserved for somebody/,
    "mark refuses a reserved device, or one with a live reservation row, in the database",
  );
  assert.match(sql, /from public\.device_assignments where id = p_assignment_id for update/, "reconcile locks the reservation");
  assert.match(sql, /if v_device\.status <> 'reserved' then\s+raise exception\s+'Reconciling % is refused/, "reconcile refuses a device no longer reserved");
  assert.match(sql, /in \('resigned', 'terminated'\) then\s+raise exception\s+'Reconciling a reservation to % is refused/, "reconcile refuses a leaver");
  for (const fn of ["phx_device_mark", "phx_device_reconcile"]) {
    assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`), `${fn} stays closed to the public`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`), `${fn} stays open to the server`);
  }
}

function testTheRegisterDoesNotOfferChangeStateOnAReservedDevice(): void {
  const workspace = code("src/components/devices/device-register-workspace.tsx");
  assert.match(
    workspace,
    /device\.status === "reserved" \? \([\s\S]{0,400}Revoke the reservation[\s\S]{0,400}\) : \([\s\S]{0,200}onOpen\(device\.id, "mark"\)/,
    "Change state must not be offered on a reserved device",
  );
}

function testOneMachineNeverEntersTwice(): void {
  const register: IdentityEntry[] = [
    { id: "1", assetTag: "PHX-TAB-0001", serialNumber: "HA255LN1", imei: "351234567890123" },
  ];
  const serialClash = findRegistrationClash({ assetTag: "PHX-TAB-0099", serialNumber: "ha255-ln1", imei: null }, register);
  assert.ok(serialClash && serialClash.includes("as PHX-TAB-0001"), `"ha255-ln1" is "HA255LN1", got: ${serialClash}`);
  const imeiClash = findRegistrationClash({ assetTag: "PHX-TAB-0099", serialNumber: null, imei: "35-123456-789012-3" }, register);
  assert.ok(imeiClash && imeiClash.includes("as PHX-TAB-0001"), `a dashed IMEI is the same IMEI, got: ${imeiClash}`);
  const tagClash = findRegistrationClash({ assetTag: "phx-tab-0001", serialNumber: "NEW1", imei: null }, register);
  assert.ok(tagClash, "an asset tag is compared without case");
  assert.equal(findRegistrationClash({ assetTag: "PHX-TAB-0099", serialNumber: "OTHER9", imei: null }, register), null);
  for (const message of [serialClash, imeiClash, tagClash]) {
    assert.equal(deviceRegisterErrorStatus(message), 400, `a clash is answered 400: ${message}`);
  }
  assert.equal(serialDuplicateKey("hs1 a-2b3"), "HS1A2B3");
  assert.equal(imeiDuplicateKey("35-123456-789012-3"), imeiDuplicateKey("351234567890123"));

  const service = code("src/lib/devices/service.ts");
  assert.match(
    service,
    /export async function createDevice[\s\S]{0,1800}findRegistrationClash\([\s\S]{0,200}if \(clash\) throw new Error\(clash\);[\s\S]{0,200}\.from\("company_devices"\)\s*\.insert/,
    "createDevice must check the normalised identity before inserting",
  );
  assert.match(
    service,
    /\.code === "23505"\) \{\s*throw new Error\(\s*"A device with this asset tag, serial number or IMEI was added to the register a moment ago/,
    "a unique-index race is answered as a sentence starting \"A device\" (400), never as the constraint's name",
  );
}

const EMPTY_DIRECTORY = new Map<string, DirectoryEntry>();

function importRow(overrides: Partial<DeviceImportRow>): DeviceImportRow {
  return {
    rowNumber: 6,
    assetTag: "PHX-TAB-0100",
    category: "tablet",
    manufacturer: null,
    model: null,
    serialNumber: null,
    imei: null,
    simNumber: null,
    lineNumber: null,
    estimatedValueEgp: 10000,
    purchasedOn: null,
    heldBy: null,
    issuedOn: null,
    declarationNo: null,
    handoverPlace: null,
    deviceName: null,
    processor: null,
    installedRam: null,
    systemType: null,
    windowsDeviceId: null,
    windowsProductId: null,
    note: null,
    ...overrides,
  };
}

function testImportDuplicatesAndDates(): void {
  const inFile = buildDeviceImportPreviewFrom(
    [
      importRow({ assetTag: "PHX-TAB-0100", serialNumber: "HA255LN1" }),
      importRow({ assetTag: "PHX-TAB-0101", rowNumber: 7, serialNumber: "ha255-ln1" }),
    ],
    EMPTY_DIRECTORY,
    { tags: new Set(), serials: new Set(), imeis: new Set() },
  );
  assert.ok(
    inFile.rows.every((row) => row.errors.some((error) => error.includes("used on more than one row"))),
    "two spellings of one serial in one file are a duplicate pair",
  );

  const existing: ExistingRegisterKeys = { tags: new Set(), serials: new Set(), imeis: new Set(["351234567890123"]) };
  const against = buildDeviceImportPreviewFrom(
    [importRow({ imei: "35-123456-789012-3" })],
    EMPTY_DIRECTORY,
    existing,
  );
  assert.ok(
    against.rows[0].errors.some((error) => error.includes("is already in the register")),
    "a dashed IMEI already in the register is refused",
  );

  assert.equal(cellDate("03/10/2026"), "03/10/2026", "slash dates are returned raw, never guessed month-first");
  assert.equal(cellDate("2026-10-03"), "2026-10-03");
  assert.equal(isCalendarDate("2026-02-30"), false, "30 February is not a day");
  assert.equal(isCalendarDate("2026-02-28"), true);
  const slashed = buildDeviceImportPreviewFrom(
    [importRow({ serialNumber: "S1", issuedOn: cellDate("03/10/2026") })],
    EMPTY_DIRECTORY,
    { tags: new Set(), serials: new Set(), imeis: new Set() },
  );
  assert.ok(
    slashed.rows[0].errors.some((error) => error.includes("is not a date. Use YYYY-MM-DD")),
    "a slash date is sent back to be retyped",
  );
  const impossible = buildDeviceImportPreviewFrom(
    [importRow({ serialNumber: "S1", purchasedOn: "2026-02-30" })],
    EMPTY_DIRECTORY,
    { tags: new Set(), serials: new Set(), imeis: new Set() },
  );
  assert.ok(
    impossible.rows[0].errors.some((error) => error.includes('"2026-02-30" is not a date')),
    "an impossible date is refused by the preview",
  );
}

function testEveryImportPressFilesOneActor(): void {
  // A caller with no HR id: the check used to file the raw login ("B-10") and the import the
  // normalised one ("b-10") — one person, two actors. Both now file the normalised id.
  assert.equal(
    importActor({ hrId: null, loginId: "B-10", role: "super_admin" }),
    "b-10",
    "a login that is an HR id is normalised, the way the import press always filed it",
  );
  assert.equal(importActor({ hrId: "b-155", loginId: "someone", role: "hr" }), "B-155");
  for (const route of [
    "app/api/devices/import/dry-run/route.ts",
    "app/api/devices/import/confirm/route.ts",
    "app/api/devices/action1/dry-run/route.ts",
    "app/api/devices/action1/confirm/route.ts",
  ]) {
    assert.match(code(route), /const actor = importActor\(access\);/, `${route} must name the actor through importActor`);
  }
  assert.match(code("src/lib/devices/import-attempt-log.ts"), /const actor = importActor\(access\);/, "the gate log names the actor the same way");
}

function testAction1TokenStaysOnItsServer(): void {
  const base = "https://app.eu.action1.com/api/3.0";
  assert.equal(
    resolveAction1NextPage("/api/3.0/endpoints/managed/org?from=50", base),
    "https://app.eu.action1.com/api/3.0/endpoints/managed/org?from=50",
  );
  assert.throws(
    () => resolveAction1NextPage("https://collector.example.net/steal?from=50", base),
    /not the configured Action1 server/,
    "a next-page link to another origin must stop the pull before the bearer token is sent",
  );
  assert.match(
    code("src/lib/devices/action1.ts"),
    /url = next \? resolveAction1NextPage\(next, config\.baseUrl\) : null;/,
    "the endpoint pager must follow next links only through resolveAction1NextPage",
  );
}

async function testGoogleTokenExchangeHasATimeout(): Promise<void> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let seen: RequestInit | undefined;
  const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
    seen = init;
    return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
  }) as typeof fetch;
  const token = await mintAndroidManagementToken(
    { client_email: "svc@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    1_800_000_000,
    fakeFetch,
  );
  assert.equal(token, "t");
  assert.ok(seen?.signal instanceof AbortSignal, "the token exchange must carry an abort signal so it cannot hang");
  assert.equal(GOOGLE_TOKEN_TIMEOUT_MS, 30_000);
}

function testSignupIsRefusedOnceBound(): void {
  assert.match(
    code("app/api/devices/managed-play/signup/route.ts"),
    /if \(isAndroidManagementConfigured\(\)\) \{\s*return NextResponse\.json\(\{ message: ENTERPRISE_ALREADY_BOUND_MESSAGE \}, \{ status: 409 \}\);/,
    "the signup route must answer 409 once Phoenix is bound",
  );
  assert.match(
    code("app/api/devices/managed-play/callback/route.ts"),
    /if \(isAndroidManagementConfigured\(\)\) \{\s*pageUrl\.searchParams\.set\("signupError", ENTERPRISE_ALREADY_BOUND_MESSAGE\);\s*return NextResponse\.redirect\(pageUrl\);/,
    "the callback must not create a second enterprise once Phoenix is bound",
  );
}

function testFailedHolderReadRaises(): void {
  assert.match(
    code("src/lib/devices/service.ts"),
    /const \{ data, error \} = await supabase\s*\.from\("employees"\)[\s\S]{0,200}\.ilike\("hr_id", hrId\)\s*\.limit\(1\);\s*if \(error\) throw new Error\(deviceErrorMessage\(error\)\);/,
    "the case-insensitive holder fallback must raise a failed read, never leave the holder looking like a leaver",
  );
}

/**
 * Every part runs, and every failure is reported together — one defect returning must not hide a
 * second one behind it.
 */
export async function runDeviceRegisterAuditTests(): Promise<void> {
  const parts: Array<[string, () => void | Promise<void>]> = [
    ["declaration year", testDeclarationYearReadsTheHandoverDate],
    ["leavers", testLeaversNeverReceiveANewCustody],
    ["reserved-device refusals", testReservedDevicesAreNotMarkedAndReconcileNeedsAReservedDevice],
    ["service order", testTheServiceRefusesBeforeItWrites],
    ["database guards", testTheDatabaseRefusesTheSame],
    ["register button", testTheRegisterDoesNotOfferChangeStateOnAReservedDevice],
    ["one machine once", testOneMachineNeverEntersTwice],
    ["import duplicates and dates", testImportDuplicatesAndDates],
    ["import actor", testEveryImportPressFilesOneActor],
    ["Action1 next page", testAction1TokenStaysOnItsServer],
    ["Google token timeout", testGoogleTokenExchangeHasATimeout],
    ["enterprise signup", testSignupIsRefusedOnceBound],
    ["holder read", testFailedHolderReadRaises],
  ];
  const failures: string[] = [];
  for (const [name, run] of parts) {
    try {
      await run();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`device register audit — ${failures.join(" | ")}`);
}
