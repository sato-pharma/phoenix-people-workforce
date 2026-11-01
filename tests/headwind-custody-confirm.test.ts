import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { HeadwindDevice } from "../src/lib/devices/headwind/devices.ts";
import { headwindRegisterOneDecision } from "../src/lib/devices/headwind/register-sync.ts";
import type { RegisterTablet } from "../src/lib/devices/managed-tablets.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * NEW TABLETS ENTER DEVICE CUSTODY ONLY WHEN A PERSON CONFIRMS THEM (owner, 2026-10-22).
 *
 * Until that day a managed Headwind tablet added ITSELF to the custody register the next time the
 * fleet was read. This proves the four halves of the decision that removed:
 *
 *   1. the fleet read no longer creates a custody row — the bulk auto-create is gone, replaced by a
 *      COUNT of the tablets waiting (pinned at the source, since the read itself touches the database);
 *   2. `registerOneHeadwindTablet` adds EXACTLY the one named, unregistered tablet carrying a serial —
 *      its facts, and no other tablet's — through the one shared write path, once;
 *   3. a tablet reporting neither a serial nor an IMEI is refused, because nothing would tell it apart;
 *   4. a tablet the register already holds is refused rather than given a second tag.
 *
 * The decision is tested through the PURE `headwindRegisterOneDecision`, which takes the fleet and the
 * register as data and does no I/O — so every refusal is proven without a database and, crucially,
 * without writing a PHX-TAB row to production (the suite runs with production credentials). The one
 * step that needs the database — the `registerTablet` write itself — is pinned at the source, the same
 * way the rest of this bridge pins every write path.
 */

function device(overrides: Partial<HeadwindDevice>): HeadwindDevice {
  return {
    agentVersion: null,
    batteryCharging: null,
    batteryLevel: null,
    configurationId: null,
    configurationName: null,
    deviceId: "1",
    deviceNumber: "PHX-TAB-0002",
    enrollmentStatus: "Enrolled",
    imei: null,
    info: {},
    isAndroid: true,
    lastContactAt: null,
    latitude: null,
    launcherVersion: null,
    locatedAt: null,
    longitude: null,
    manufacturer: null,
    model: null,
    name: "PHX-TAB-0002",
    osVersion: null,
    phone: null,
    platformLabel: "Android",
    rustDeskId: null,
    serialNumber: null,
    ...overrides,
  };
}

function register(overrides: Partial<RegisterTablet>): RegisterTablet {
  return {
    assetTag: "PHX-TAB-0001",
    category: "tablet",
    holderJobTitle: null,
    holderName: null,
    id: "reg-1",
    imei: null,
    lineNumber: null,
    manufacturer: null,
    model: null,
    serialNumber: null,
    simNumber: null,
    status: "in_stock",
    ...overrides,
  };
}

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

export function runHeadwindCustodyConfirmTests() {
  // (2) — the one named unregistered tablet carrying a serial is the one that would be added, with
  // exactly ITS facts. The second device in the fleet is never chosen, so this is one row, not two.
  const fleet = [
    device({ deviceNumber: "DEV-A", manufacturer: "Lenovo", model: "TB328XU", serialNumber: "NEW-SERIAL" }),
    device({ deviceNumber: "DEV-B", serialNumber: "OTHER-SERIAL" }),
  ];
  const picked = headwindRegisterOneDecision("DEV-A", fleet, []);
  assert.ok(picked.ok, "a named, unregistered tablet carrying a serial can be added to custody");
  assert.deepEqual(
    picked.ok ? picked.facts : null,
    { imei: null, manufacturer: "Lenovo", model: "TB328XU", serialNumber: "NEW-SERIAL" },
    "and exactly ITS facts are what would be written — the other tablet in the fleet is left alone",
  );

  // The device number is trimmed before it is matched — a stray space off a console must not turn a
  // known tablet into "not in the fleet".
  assert.ok(
    headwindRegisterOneDecision("  DEV-A  ", fleet, []).ok,
    "the device number is trimmed before it is matched",
  );

  // (3) — a tablet reporting neither a serial nor an IMEI is refused: nothing would tell it apart.
  const noIdentity = headwindRegisterOneDecision("DEV-C", [device({ deviceNumber: "DEV-C" })], []);
  assert.equal(noIdentity.ok, false, "a tablet reporting neither a serial nor an IMEI is refused");
  assert.match(
    noIdentity.ok ? "" : noIdentity.message,
    /neither a serial number nor an IMEI/,
    "and the refusal says why — it cannot be told apart from another tablet",
  );

  // (4) — a tablet the register already holds is refused rather than given a second tag, and the
  // refusal names the tag it already carries (names, never codes). The serial match is case-insensitive,
  // which is also the proof the shared register matcher is reused here, not re-implemented.
  const known = register({ assetTag: "PHX-TAB-0007", id: "reg-known", serialNumber: "HA1ABCDE" });
  const already = headwindRegisterOneDecision("DEV-A", [device({ deviceNumber: "DEV-A", serialNumber: "ha1abcde" })], [known]);
  assert.equal(already.ok, false, "a tablet already in the register is refused, never given a second tag");
  assert.match(
    already.ok ? "" : already.message,
    /already in the custody register as PHX-TAB-0007/,
    "and the refusal names the tag it already has",
  );

  // A device not in the live fleet cannot be added — resolved against the fleet, never the body.
  const ghost = headwindRegisterOneDecision("GHOST", [device({ deviceNumber: "DEV-A", serialNumber: "S1" })], []);
  assert.equal(ghost.ok, false, "a device number that is not in the live fleet cannot be added");
  assert.match(ghost.ok ? "" : ghost.message, /not in the Headwind fleet/, "and the refusal says the tablet is gone");

  // No device number named is refused before anything else.
  assert.equal(
    headwindRegisterOneDecision("   ", fleet, []).ok,
    false,
    "a blank device number is refused before anything is looked up",
  );

  // (2, continued) — the WRITE path, pinned at the source because it needs the database. One tablet is
  // added by exactly one `registerTablet` call (no loop that could create several), through the shared
  // write path that names headwind as the source, and never straight into the register via createDevice.
  const registerSync = stripComments(source("src/lib/devices/headwind/register-sync.ts"));
  assert.equal(
    (registerSync.match(/registerTablet\(/g) ?? []).length,
    1,
    "registerOneHeadwindTablet adds exactly one tablet — one registerTablet call, no bulk loop",
  );
  assert.match(
    registerSync,
    /registerTablet\(facts, "headwind", actor, register\)/,
    "through the one shared write path, naming headwind as the source",
  );
  assert.doesNotMatch(registerSync, /createDevice\(/, "never straight into the register — the parity every bridge keeps");
  assert.doesNotMatch(
    registerSync,
    /export async function autoRegisterHeadwindTablets/,
    "and the bulk auto-create function itself is removed, not merely left uncalled",
  );

  // (1) — THE HEADLINE. The fleet read no longer creates a custody row.
  //
  // 🔴 BREAK-TEST: restore the auto-create — put `autoRegisterHeadwindTablets(...)` back into
  // getHeadwindFleet — and this first assertion goes red, because the (comment-stripped) fleet source
  // would name it again. The banner words and the dropped state fields are pinned for the same reason.
  const fleetSource = stripComments(source("src/lib/devices/headwind/fleet.ts"));
  assert.doesNotMatch(
    fleetSource,
    /autoRegisterHeadwindTablets/,
    "the fleet read never auto-registers a tablet — new tablets wait for a person to confirm them",
  );
  assert.doesNotMatch(
    fleetSource,
    /autoRegistered|autoRegisterError/,
    "and the 'added themselves' state is gone with the behaviour it reported",
  );
  assert.match(fleetSource, /pendingRegistration/, "the read COUNTS the tablets waiting instead of adding them");

  // The route is the person's confirmation — Super Admin only, same-origin, and it only adds.
  const route = stripComments(source("app/api/devices/headwind/register/route.ts"));
  assert.match(route, /assertPermission\(access, "company_devices", "approve"\)/, "the route is the security boundary — Super Admin only");
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;/, "and same-origin only");
  assert.match(route, /registerOneHeadwindTablet\(/, "it calls the person-confirmed register-one service");
  assert.doesNotMatch(route, /export async function GET/, "there is nothing to read here — this route only adds");

  // And the route is declared in the access registry with the same gate and a required audit row, or
  // the access-registry coverage test fails: an app/api route that is not registered is refused by it.
  const registry = source("src/lib/security/access-registry.ts");
  assert.match(
    registry,
    /pattern: "\/api\/devices\/headwind\/register", permission: \{ resource: "company_devices", action: "approve" \}, csrfRequired: true/,
    "the register route is in the access registry with the same Super Admin gate as the rest of the bridge",
  );

  // The console posts to the route from a per-row button, and the old self-registration banner is gone.
  const ui = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.match(ui, /"\/api\/devices\/headwind\/register"/, "the console posts to the register route");
  assert.match(ui, /Add to custody/, "from a per-row button a person presses");
  assert.doesNotMatch(ui, /Added to the custody register by themselves/, "and the banner that claimed tablets added themselves is gone");
  assert.match(ui, /pendingRegistration/, "replaced by a count of the tablets waiting for a person");
}
