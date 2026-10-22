import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import type { AmapiDevice, RegisterTablet } from "../src/lib/devices/managed-tablets.ts";
import {
  findRegisteredTablet,
  nextTabletAssetTag,
  tabletsToAutoRegister,
} from "../src/lib/devices/tablet-auto-register.ts";

const POLICY = "enterprises/LC00abc/policies/rep-tablet";

function entry(overrides: Partial<RegisterTablet>): RegisterTablet {
  return {
    assetTag: "PHX-TAB-0001",
    category: "tablet",
    holderJobTitle: null,
    holderName: null,
    id: "reg-1",
    imei: null,
    manufacturer: null,
    model: null,
    serialNumber: null,
    status: "in_stock",
    ...overrides,
  };
}

function device(overrides: Partial<AmapiDevice>): AmapiDevice {
  return {
    appliedPolicyName: POLICY,
    hardwareInfo: { manufacturer: "samsung", model: "SM-X200", serialNumber: "R52W1234ABC" },
    name: "enterprises/LC00abc/devices/1",
    networkInfo: { imei: "356789012345678" },
    state: "ACTIVE",
    ...overrides,
  };
}

function runTagTests() {
  assert.equal(nextTabletAssetTag([]), "PHX-TAB-0001", "the first tablet is PHX-TAB-0001");
  assert.equal(nextTabletAssetTag(["DESKTOP-TU4PJGN", "PHX-TAB-0001", "phx-tab-0007"]), "PHX-TAB-0008", "numbering follows the highest tag, ignoring case and other devices");
  assert.equal(nextTabletAssetTag(["PHX-TAB-9999"]), "PHX-TAB-10000", "numbering keeps going past four digits");
}

function runSelectionTests() {
  const fresh = device({});
  assert.deepEqual(tabletsToAutoRegister([fresh], []), [
    { imei: "356789012345678", manufacturer: "samsung", model: "SM-X200", serialNumber: "R52W1234ABC" },
  ], "an enrolled rep tablet the register does not know is added with Google's facts");

  assert.equal(
    tabletsToAutoRegister([fresh], [entry({ serialNumber: "r52w-1234-abc" })]).length,
    0,
    "a tablet already in the register by serial (plugged in by USB first) is never added twice",
  );
  assert.equal(
    tabletsToAutoRegister([fresh], [entry({ imei: "35678901234567" })]).length,
    0,
    "a tablet already in the register by IMEI is never added twice",
  );
  assert.equal(tabletsToAutoRegister([device({ appliedPolicyName: "enterprises/LC00abc/policies/kiosk" })], []).length, 0, "only tablets on the rep tablet rules");
  assert.equal(tabletsToAutoRegister([device({ state: "DELETED" })], []).length, 0, "a removed device is not added");
  assert.equal(
    tabletsToAutoRegister([device({ hardwareInfo: { model: "X" }, networkInfo: {} })], []).length,
    0,
    "a device with neither serial nor IMEI cannot be told apart, so the register would refuse it",
  );
  assert.equal(tabletsToAutoRegister([fresh, device({ name: "enterprises/LC00abc/devices/2" })], []).length, 1, "one entry per serial");
}

function runLookupTests() {
  const register = [entry({ id: "a", serialNumber: "HS1A2B3" }), entry({ assetTag: "PHX-TAB-0002", id: "b", imei: "356789012345678" })];
  assert.equal(findRegisteredTablet({ imei: null, manufacturer: null, model: null, serialNumber: "hs1 a-2b3" }, register)?.id, "a");
  assert.equal(findRegisteredTablet({ imei: "35678901234567", manufacturer: null, model: null, serialNumber: null }, register)?.id, "b");
  assert.equal(findRegisteredTablet({ imei: null, manufacturer: null, model: null, serialNumber: "OTHER" }, register), null);
}

/**
 * 🔴 THE GOOGLE PAGE COUNTS NEW TABLETS AND NEVER ADDS THEM (owner, 2026-10-22: new tablets enter
 * Device Custody only when a person confirms them). The Headwind half was changed the same day; this
 * pins the Google half. BREAK-TEST: put the `registerTablet(facts, "enrollment", ...)` loop back into
 * getRepTabletsState and the first assertion fires.
 */
function runGooglePageCountsOnlyTests() {
  const service = stripComments(readFileSync("src/lib/devices/rep-tablets-service.ts", "utf8"));
  assert.doesNotMatch(service, /registerTablet\(facts, "enrollment"/, "reading the page never adds a tablet to custody");
  assert.match(service, /registerTablet\(facts, "usb", actor, devices\)/, "the person-confirmed USB register is the one door left");
  assert.match(
    service,
    /pendingRegistration = register\.error \? 0 : tabletsToAutoRegister\(devices, register\.entries\)\.length/,
    "the page counts the tablets waiting instead",
  );
  assert.doesNotMatch(service, /autoRegistered|autoRegisterError/, "and the state that reported self-added tablets is gone");
  const ui = stripComments(readFileSync("src/components/devices/rep-tablets-console.tsx", "utf8"));
  assert.doesNotMatch(ui, /Added to the custody register by themselves/, "the banner that claimed tablets added themselves is gone");
  assert.match(ui, /data\.pendingRegistration > 0/, "replaced by the count, pointing at the USB register");
}

/**
 * A Headwind tablet is added only when a Super Admin confirms it (`registerOneHeadwindTablet`, owner
 * rule 2026-10-22), so the note on its entry must not say it was added automatically. BREAK-TEST: put
 * "Added automatically" back into the headwind note and the first assertion fires.
 */
function runHeadwindNoteTests() {
  const source = readFileSync("src/lib/devices/tablet-auto-register.ts", "utf8");
  const headwindNote = /headwind: "([^"]*)"/.exec(source)?.[1] ?? "";
  assert.doesNotMatch(headwindNote, /automatically/i, "a person-confirmed Headwind tablet is never described as added automatically");
  assert.match(headwindNote, /^Added to custody from the Rep Tablets page after it enrolled on the company's own Headwind server\.$/);
}

export function runTabletAutoRegisterTests() {
  runHeadwindNoteTests();
  runTagTests();
  runSelectionTests();
  runLookupTests();
  runGooglePageCountsOnlyTests();
}
