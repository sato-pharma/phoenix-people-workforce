import { strict as assert } from "node:assert";

import {
  action1AssetTag,
  action1Category,
  action1KeySample,
  flattenAction1Record,
  mapAction1Record,
  mapAction1Records,
  normalizeInstalledRam,
  normalizeSystemType,
} from "../src/lib/devices/action1.ts";
import { buildDeviceImportPreviewFrom } from "../src/lib/devices/bulk-import.ts";
import type { DirectoryEntry, ExistingRegisterKeys } from "../src/lib/devices/bulk-import.ts";

// The Action1 pull turns an endpoint into a row the device register's own import pipeline writes.
// Everything pinned here is PURE — the mapping, the unit conversions and the two properties that
// make the automation safe to leave switched on. Nothing reaches a network or a database, which is
// not merely convenient: this suite runs with PRODUCTION credentials (AGENTS.md §2.1), so a test
// that needed a live Action1 tenant to check a megabyte conversion would be calling somebody's API
// to assert arithmetic.
//
// THE TWO PROPERTIES WORTH BREAKING THE BUILD OVER:
//
//   1. A pull never signs anybody for anything. Action1 knows which account last logged into a
//      machine; it does not know who signed a custody receipt for it, and البند (10) prices what
//      the name on that receipt owes. So `heldBy` is null on every row by construction, and the
//      handover stays a press a person makes with the device in front of them.
//
//   2. A pull is add-only. The register refuses a serial it already holds, so running it again on
//      Tuesday reports skips rather than writing a second row against one physical laptop. That is
//      what makes "press it whenever a machine is set up" true instead of a habit that slowly
//      duplicates the fleet.

const EMPTY_REGISTER: ExistingRegisterKeys = { imeis: new Set(), serials: new Set(), tags: new Set() };
const EMPTY_DIRECTORY = new Map<string, DirectoryEntry>();

/** A Windows laptop as Action1 might return it, in the snake_case spelling its docs use. */
const WINDOWS_ENDPOINT = {
  cpu: "Intel(R) Core(TM) i7-1255U @ 1.70GHz",
  id: "e3f1a9c2-77bd-4a11-9c30-5f2b6d0a1e44",
  manufacturer: "Dell Inc.",
  model: "Latitude 5440",
  name: "sato-lap-07",
  os_architecture: "x64",
  os_name: "Windows 11 Pro",
  serial_number: "7QK4LM3",
  total_memory: 17179869184,
};

function firstRow(record: Record<string, unknown>) {
  return mapAction1Record(record, 0, "2026-09-11");
}

function assertWindowsLaptopMapping(): void {
  const row = firstRow(WINDOWS_ENDPOINT);

  // The hostname becomes the asset tag. It is what IT already calls the machine and what is on the
  // Action1 screen, and uppercasing it stops `sato-lap-07` and `SATO-LAP-07` entering as two
  // devices.
  assert.equal(row.assetTag, "SATO-LAP-07");
  assert.equal(row.category, "laptop");
  assert.equal(row.manufacturer, "Dell Inc.");
  assert.equal(row.model, "Latitude 5440");
  assert.equal(row.serialNumber, "7QK4LM3");

  // The Windows "About" block — the technical half of نموذج رقم 1.
  assert.equal(row.deviceName, "sato-lap-07");
  assert.equal(row.processor, "Intel(R) Core(TM) i7-1255U @ 1.70GHz");
  assert.equal(row.installedRam, "16.0 GB");
  assert.equal(row.systemType, "64-bit operating system");

  // Provenance, so a later reader can tell a machine-made row from a typed one and trace it back.
  assert.ok(row.note?.includes("Action1"), "the note should say where the row came from");
  assert.ok(row.note?.includes("2026-09-11"), "the note should carry the pull date");

  // Not knowable from an endpoint, and deliberately left for the pen rather than filled with
  // something adjacent: the Product ID is a licensing field, and a value is a money figure.
  assert.equal(row.windowsProductId, null);
  assert.equal(row.estimatedValueEgp, null);
  assert.equal(row.rowNumber, 1);
}

/**
 * The spelling tolerance the mapping is built on.
 *
 * Action1's published documentation gives the paths but not the JSON keys, so every field is read
 * through a candidate list against a punctuation-insensitive view of the record. If that is ever
 * "simplified" to one guessed spelling, this goes red rather than a column quietly going blank.
 */
function assertKeySpellingTolerance(): void {
  const camel = firstRow({
    Manufacturer: "Apple Inc.",
    hostName: "sato-mac-02",
    osName: "macOS 15.1",
    serialNumber: "C02XY1234ABC",
  });
  assert.equal(camel.assetTag, "SATO-MAC-02");
  assert.equal(camel.serialNumber, "C02XY1234ABC");
  assert.equal(camel.manufacturer, "Apple Inc.");
  assert.equal(camel.category, "laptop");

  // Nested detail, which is the shape `?fields=*` returns.
  const nested = firstRow({
    hardware: { bios_serial_number: "ZZ99TOP", system_manufacturer: "Lenovo" },
    name: "sato-lap-11",
    os: { name: "Windows 10 Pro" },
  });
  assert.equal(nested.serialNumber, "ZZ99TOP");
  assert.equal(nested.manufacturer, "Lenovo");
  assert.equal(nested.category, "laptop");

  // Shallowest wins: the endpoint's own name must outrank a name nested inside something it
  // contains, or a laptop gets filed under its network adapter.
  const shadowed = firstRow({ name: "sato-lap-09", nic: { name: "Intel Wi-Fi 6E" }, serial: "AAA111" });
  assert.equal(shadowed.assetTag, "SATO-LAP-09");

  // The flattener is what makes all of the above one lookup.
  const flat = flattenAction1Record({ Serial_Number: "  X1  " });
  assert.equal(flat.get("serialnumber"), "X1", "keys normalize and values trim");
}

/** A unitless number carries only its magnitude, so that is what decides the unit. */
function assertMemoryNormalization(): void {
  assert.equal(normalizeInstalledRam("17179869184"), "16.0 GB", "bytes");
  assert.equal(normalizeInstalledRam("16777216"), "16.0 GB", "kilobytes");
  assert.equal(normalizeInstalledRam("16384"), "16.0 GB", "megabytes");
  assert.equal(normalizeInstalledRam("16"), "16.0 GB", "already gigabytes");

  // Already human-readable, so it is passed through rather than re-derived — re-deriving could
  // only lose precision, and this is a value that gets printed on a signed page.
  assert.equal(normalizeInstalledRam("16.0 GB"), "16.0 GB");
  assert.equal(normalizeInstalledRam("8 GB"), "8 GB");

  assert.equal(normalizeInstalledRam(null), null);
  assert.equal(normalizeInstalledRam("   "), null);
  assert.equal(normalizeInstalledRam("0"), null);

  assert.equal(normalizeSystemType("x64"), "64-bit operating system");
  assert.equal(normalizeSystemType("AMD64"), "64-bit operating system");
  // x86_64 contains "x86" and is 64-bit. Read the wrong way round it prints the wrong architecture
  // on the form, so the 64-bit test has to come first in the implementation.
  assert.equal(normalizeSystemType("x86_64"), "64-bit operating system");
  assert.equal(normalizeSystemType("arm64"), "64-bit operating system");
  assert.equal(normalizeSystemType("x86"), "32-bit operating system");
  assert.equal(normalizeSystemType(null), null);
}

/**
 * The category decides WHICH FORM PRINTS — نموذج رقم 1 for a laptop, نموذج رقم 2 for everything
 * else — so this is not a label in a dropdown.
 */
function assertCategoryDecidesTheForm(): void {
  assert.equal(action1Category("Windows 11 Pro", "Latitude 5440"), "laptop");
  assert.equal(action1Category("macOS 15.1", "MacBook Air"), "laptop");
  assert.equal(action1Category("Ubuntu 24.04", null), "laptop");
  assert.equal(action1Category("Android 14", "Galaxy S23"), "phone");
  assert.equal(action1Category("iPadOS 18", "iPad Air"), "tablet");

  // Unrecognised stays `other`, which prints the portable form with ruled blanks somebody completes
  // at the desk. Guessing it into `laptop` would print a Windows "About" block for a machine
  // nobody can describe, which is the worse of the two mistakes.
  assert.equal(action1Category(null, null), "other");

  // A phone carries no Windows "About" block, so those fields stay empty rather than travelling to
  // a form that has nowhere to print them.
  const phone = firstRow({ imei: "356938035643809", name: "sato-phone-03", os: "Android 14", ram: 8192 });
  assert.equal(phone.category, "phone");
  assert.equal(phone.imei, "356938035643809");
  assert.equal(phone.processor, null);
  assert.equal(phone.installedRam, null);
  assert.equal(phone.systemType, null);
  assert.equal(phone.deviceName, null);
}

/** Falls back only as far as it can, and refuses to invent a handle it has no basis for. */
function assertAssetTagFallback(): void {
  assert.equal(action1AssetTag("sato-lap-07", "7QK4LM3", "e3f1"), "SATO-LAP-07");
  assert.equal(action1AssetTag(null, "7qk4lm3", "e3f1"), "7QK4LM3", "serial when there is no hostname");
  assert.equal(action1AssetTag(null, null, "e3f1a9c2-77bd"), "A1-E3F1A9C277BD", "the endpoint id last");
  assert.equal(action1AssetTag(null, null, null), null, "nothing to build a handle from");

  // A record with nothing identifying in it is still emitted, and the preview is what refuses it —
  // so the endpoint is reported by name rather than silently dropped from the pull.
  const anonymous = firstRow({ description: "unknown device" });
  assert.equal(anonymous.assetTag, null);
  const preview = buildDeviceImportPreviewFrom([anonymous], EMPTY_DIRECTORY, EMPTY_REGISTER);
  assert.equal(preview.rows[0]?.canImport, false);
  assert.ok(
    preview.rows[0]?.errors.some((error) => error.includes("asset tag")),
    "the missing handle is reported",
  );
  assert.ok(
    preview.rows[0]?.errors.some((error) => error.includes("serial number or an IMEI")),
    "so is the missing identity",
  );
}

/**
 * PROPERTY 1 — a pull never opens a custody record.
 *
 * This is the one that must not be "improved" by wiring Action1's last-logged-in user into the
 * holder column. That account is a helpdesk session as often as it is the owner, and a custody
 * record opened from it puts a name on a signed instrument that nobody put there.
 */
function assertNeverAssignsCustody(): void {
  const rows = mapAction1Records(
    [WINDOWS_ENDPOINT, { last_logged_on_user: "SATO\\hoda", name: "sato-lap-08", serial: "BB22CC" }],
    "2026-09-11",
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.heldBy, null, "a pull must never name a holder");
    assert.equal(row.issuedOn, null);
    assert.equal(row.declarationNo, null);
    assert.equal(row.handoverPlace, null);
  }

  // And the pipeline agrees: with no holder named, nothing resolves and nothing would be issued.
  const preview = buildDeviceImportPreviewFrom(rows, EMPTY_DIRECTORY, EMPTY_REGISTER);
  assert.equal(preview.summary.canImport, 2);
  assert.equal(preview.summary.willBeIssued, 0, "a pull registers devices and issues none of them");
  for (const row of preview.rows) assert.equal(row.resolvedHolderHrId, null);
}

/**
 * PROPERTY 2 — running it again adds only what is new.
 *
 * Add-only by construction rather than by a flag somebody remembers to set: the register's own
 * duplicate rules refuse the serial, so the second pull reports a skip.
 */
function assertRepeatPullIsAddOnly(): void {
  const rows = mapAction1Records(
    [WINDOWS_ENDPOINT, { name: "sato-lap-12", os: "Windows 11 Pro", serial_number: "NEW999" }],
    "2026-09-11",
  );

  // The register already holds the first machine, from the pull that was run last week.
  const registered: ExistingRegisterKeys = {
    imeis: new Set(),
    serials: new Set(["7qk4lm3"]),
    tags: new Set(["sato-lap-07"]),
  };

  const preview = buildDeviceImportPreviewFrom(rows, EMPTY_DIRECTORY, registered);
  assert.equal(preview.summary.canImport, 1, "only the new machine is importable");
  assert.equal(preview.rows[0]?.canImport, false);
  assert.ok(
    preview.rows[0]?.errors.some((error) => error.includes("already in the register")),
    "the known machine is reported as already registered, not written again",
  );
  assert.equal(preview.rows[1]?.canImport, true);
  assert.equal(preview.rows[1]?.assetTag, "SATO-LAP-12");

  // Two endpoints returning one serial is Action1's problem to fix, not something to write twice.
  const collided = mapAction1Records(
    [
      { name: "sato-lap-20", os: "Windows 11 Pro", serial_number: "DUP1" },
      { name: "sato-lap-21", os: "Windows 11 Pro", serial_number: "DUP1" },
    ],
    "2026-09-11",
  );
  const collision = buildDeviceImportPreviewFrom(collided, EMPTY_DIRECTORY, EMPTY_REGISTER);
  assert.equal(collision.summary.canImport, 0, "both halves of a duplicate pair are refused");
}

/** The dry run shows what Action1 actually sent, which is how a blank column gets diagnosed. */
function assertKeySampleIsReported(): void {
  const sample = action1KeySample([WINDOWS_ENDPOINT]);
  assert.ok(sample.includes("serialnumber"), "the sample names the keys the response carried");
  assert.ok(sample.includes("totalmemory"));
  assert.deepEqual([...sample].sort(), sample, "sorted, so two pulls are comparable by eye");
  assert.deepEqual(action1KeySample([]), []);
}

export async function runDeviceAction1SyncTests(): Promise<void> {
  assertWindowsLaptopMapping();
  assertKeySpellingTolerance();
  assertMemoryNormalization();
  assertCategoryDecidesTheForm();
  assertAssetTagFallback();
  assertNeverAssignsCustody();
  assertRepeatPullIsAddOnly();
  assertKeySampleIsReported();
}
