import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resetHeadwindTokenCache } from "../src/lib/devices/headwind/auth.ts";
import { headwindCommandSentMessage } from "../src/lib/devices/headwind/commands.ts";
import { fleetLauncherTarget, summarizeFleet, tabletSetupReadiness } from "../src/lib/devices/headwind/dashboard.ts";
import { getHeadwindDeviceDetail } from "../src/lib/devices/headwind/detail.ts";
import { HeadwindDeviceNotFoundError, type HeadwindDevice } from "../src/lib/devices/headwind/devices.ts";
import { headwindFleetRow, type RepHeadwindRow } from "../src/lib/devices/headwind/fleet.ts";
import {
  assessTabletFleet,
  buildFleetWatchMessage,
  findFleetFaults,
  nextLauncherWantedSince,
  parseLauncherWantedSince,
  type FleetWatchRow,
} from "../src/lib/devices/headwind/fleet-watch.ts";
import { fleetWatchIdempotencyKey, fleetWatchTabletCount } from "../src/lib/devices/headwind/fleet-watch-alert.ts";
import {
  headwindNextAssetTag,
  headwindRegisterOneDecision,
  headwindTabletCanBeTold,
  headwindTabletsAwaitingHardwareReport,
  headwindTabletsToRegister,
  headwindTagDrift,
} from "../src/lib/devices/headwind/register-sync.ts";
import type { RegisterTablet } from "../src/lib/devices/managed-tablets.ts";
import { cairoDateTime } from "../src/lib/format/cairo-datetime.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * What the console says about each tablet's STATE — readiness, the detail panel, the register sync and
 * the fleet watch (the 9 Nov 2026 audit). Every assertion here was break-tested: the fix broken, this
 * assertion watched failing, the fix restored.
 */

const ENV = {
  HEADWIND_MDM_BASE_URL: "https://mdm.test.local",
  HEADWIND_MDM_LOGIN: "phoenix",
  HEADWIND_MDM_PASSWORD: "a-real-password",
} as unknown as NodeJS.ProcessEnv;

const NOW = Date.parse("2026-11-09T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function source(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

function device(overrides: Partial<HeadwindDevice>): HeadwindDevice {
  return {
    agentVersion: null,
    batteryCharging: null,
    batteryLevel: null,
    configurationId: null,
    configurationName: null,
    deviceId: "1",
    deviceNumber: "PHX-TAB-0009",
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
    name: "PHX-TAB-0009",
    osVersion: null,
    phone: null,
    platformLabel: "Android",
    rustDeskId: null,
    serialNumber: null,
    ...overrides,
  };
}

function entry(overrides: Partial<RegisterTablet>): RegisterTablet {
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

function row(overrides: Partial<RepHeadwindRow>): RepHeadwindRow {
  return { ...headwindFleetRow(device({}), [], new Map(), false, null), ...overrides };
}

function watched(overrides: Partial<FleetWatchRow> & { deviceNumber: string }): FleetWatchRow {
  return {
    assetTag: `TAG-${overrides.deviceNumber}`,
    holderName: "A Rep",
    lastContactAt: ago(1),
    latitude: 30.05,
    locatedAt: ago(1),
    longitude: 31.24,
    name: overrides.deviceNumber,
    registerStatus: "assigned",
    ...overrides,
  };
}

/** A fetch stand-in: the sign-in answers a token, every API call answers `listing`. */
function listingFetch(listing: unknown): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    const body = url.includes("/rest/public/jwt/login") ? { data: { authToken: "jwt-1" }, status: "OK" } : listing;
    return { json: async () => body, ok: true, status: 200 } as unknown as Response;
  }) as unknown as typeof fetch;
}

function runLauncherReadinessTests() {
  // ── F8: the launcher bar is the higher of the newest RUNNING and the newest WANTED version ─────────
  // 🔴 A WHOLE FLEET STALLED ON ONE VERSION ALL READ CURRENT. Both tablets run 6.39 and their rules want
  // 6.48 (9 Nov 2026). BREAK-TEST: drop `row.agentVersion` from `fleetLauncherTarget` and the target
  // reads 6.39, so both read current and the first assertion fires.
  const stalled = [
    row({ agentVersion: "6.48", deviceNumber: "A", launcherVersion: "6.39" }),
    row({ agentVersion: "6.48", deviceNumber: "B", launcherVersion: "6.39" }),
  ];
  const target = fleetLauncherTarget(stalled);
  assert.equal(
    tabletSetupReadiness(stalled[0], { launcherTarget: target }).launcher,
    "behind",
    "a fleet stalled on 6.39 while its rules want 6.48 is behind, not level with itself",
  );
  assert.equal(tabletSetupReadiness(stalled[0], { launcherTarget: target }).launcherCurrent, false);
  // A tablet updated ahead of a stale target still sets the bar.
  assert.equal(
    tabletSetupReadiness(row({ agentVersion: "6.39", launcherVersion: "6.48" }), {
      launcherTarget: fleetLauncherTarget([row({ agentVersion: "6.39", launcherVersion: "6.48" })]),
    }).launcher,
    "current",
    "running ahead of the wanted version is current",
  );

  // 🔴 AN UNKNOWN RUNNING VERSION IS "NOT REPORTED", NEVER CURRENT. BREAK-TEST: put back
  // `myRank === null ||` as current in `tabletSetupReadiness` and this reads "current".
  const silentOnVersion = tabletSetupReadiness(row({ agentVersion: "6.48", launcherVersion: null }), { launcherTarget: target });
  assert.equal(silentOnVersion.launcher, "not_reported", "a tablet that names no launcher has not reported one");
  assert.equal(silentOnVersion.launcherCurrent, false, "and it is never counted current");

  // The fleet chip says which of the three it is, in words.
  const fleetUi = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.match(fleetUi, /"Launcher not reported"/, "the chip says the launcher was not reported");
  assert.match(fleetUi, /· behind`/, "and says behind in words, never by colour alone");
}

function runRegisterUnknownTests() {
  // 🔴 AN UNREAD REGISTER INVENTS NO CUSTODY FACT. A row read while the register was down has no match and
  // is not "unregistered"; it used to tick "In custody" and cross "SIM". BREAK-TEST: set `registerKnown`
  // to `true` in `tabletSetupReadiness` and the first assertion reads `true`.
  const unread = headwindFleetRow(device({ serialNumber: "HA1" }), [], new Map(), true, null);
  const readiness = tabletSetupReadiness(unread, { launcherTarget: null });
  assert.equal(readiness.inCustody, null, "custody is not known when the register was not read");
  assert.equal(readiness.simRecorded, null, "nor is the SIM");
  assert.equal(readiness.ready, false, "and a tablet with an unknown step is never fully set up");
  assert.equal(unread.unregistered, false, "an unread register calls no tablet unregistered");
  assert.equal(unread.canAddToCustody, false, "and nothing is offered to add");

  const overview = stripComments(source("src/components/devices/tablet-fleet-overview.tsx"));
  assert.match(
    overview,
    /value=\{registerError \? "—" : `\$\{summary\.fullySetUp\} \/ \$\{summary\.total\}`\}/,
    "the Fully set up tile shows a dash, not an invented 0 of N, when the register could not be read",
  );
  assert.match(overview, /label="Seen in 24 hours"/, "the tile counting check-ins in a day is not called online now");
  const chip = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.match(chip, /if \(done === null\)/, "a setup step that is not known draws neither a tick nor a cross");
}

function runHardwareReportTests() {
  // ── F21: a tablet that never sent its hardware report is counted, and its row says why ─────────────
  const known = entry({ assetTag: "PHX-TAB-0007", id: "reg-7", serialNumber: "HA255LN1" });
  const fleet = [
    device({ deviceNumber: "PHX-TAB-0007", serialNumber: "HA255LN1" }), // in the register
    device({ deviceNumber: "PHX-TAB-0009", serialNumber: "NEW-ONE" }), // waiting, can be added
    device({ deviceNumber: "PHX-TAB-0010" }), // enrolled, no serial, no IMEI
    device({ deviceNumber: "PHX-TAB-0011", imei: "35123456789" }), // an IMEI too short to tell apart
  ];
  // BREAK-TEST: make `headwindTabletsAwaitingHardwareReport` return [] and this reads 0, not 2.
  assert.deepEqual(
    headwindTabletsAwaitingHardwareReport(fleet, [known]).map((tablet) => tablet.deviceNumber),
    ["PHX-TAB-0010", "PHX-TAB-0011"],
    "the enrolled tablets with no serial and no usable IMEI are counted on their own",
  );
  assert.equal(headwindTabletsToRegister(fleet, [known]).length, 1, "and the waiting count stays the one that can be added");

  // 🔴 THE ROW'S "CAN ADD" IS THE SERVER'S OWN ANSWER. The console offered the button on any IMEI text
  // at all, and the route then refused an 11-digit one. BREAK-TEST: compute `told` as
  // `Boolean(device.serialNumber ?? device.imei)` in `headwindFleetRow` and the second assertion fires.
  const shortImei = headwindFleetRow(fleet[3], [known], new Map(), false, null);
  assert.equal(headwindTabletCanBeTold(fleet[3]), false, "an IMEI under 14 digits cannot tell a tablet apart");
  assert.equal(shortImei.canAddToCustody, false, "so its row offers no Add to custody the route would refuse");
  assert.equal(shortImei.awaitingHardwareReport, true, "and the row is flagged as waiting for its hardware report");
  const waiting = headwindFleetRow(fleet[1], [known], new Map(), false, null);
  assert.equal(waiting.canAddToCustody, true, "a tablet with a serial can be added from its row");
  assert.equal(waiting.awaitingHardwareReport, false);

  const refusal = headwindRegisterOneDecision("PHX-TAB-0010", fleet, [known]);
  assert.match(refusal.ok ? "" : refusal.message, /never sent its hardware report/, "the refusal says what the tablet did not send");
  assert.match(refusal.ok ? "" : refusal.message, /install link/, "and the likely reason, so the next step is clear");

  const fleetUi = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.match(fleetUi, /const canAddToCustody = row\.canAddToCustody;/, "the button follows the server's answer");
  assert.match(fleetUi, /data\.awaitingHardwareReport > 0/, "and the page says how many never sent their report");

  const summary = summarizeFleet([shortImei, waiting], NOW);
  assert.equal(summary.awaitingHardwareReport, 1, "the overview counts them too");
  assert.equal(summary.notInRegister, 2, "inside the not-in-register count, never instead of it");
}

function runTagDriftTests() {
  // ── Custody tag drift: the Headwind number and the custody tag naming the tablet differently ────────
  // BREAK-TEST: make `headwindTagDrift` return null always and the first two assertions fire.
  assert.match(
    headwindTagDrift("PHX-TAB-0009", "PHX-TAB-0008", null) ?? "",
    /Headwind numbers this tablet PHX-TAB-0009, but its custody tag is PHX-TAB-0008/,
    "a tablet whose custody tag is another number says so on its row",
  );
  const register = [entry({ assetTag: "PHX-TAB-0006" }), entry({ assetTag: "PHX-TAB-0008", id: "reg-8" })];
  assert.equal(headwindNextAssetTag(register), "PHX-TAB-0009", "the next tag is counted as the minting code counts it");
  assert.match(
    headwindTagDrift("PHX-TAB-0011", null, headwindNextAssetTag(register)) ?? "",
    /adding it to custody now gives it the tag PHX-TAB-0009/,
    "a tablet not yet added is warned BEFORE the press that would give it a different number",
  );
  assert.equal(headwindTagDrift("PHX-TAB-0009", "phx-tab-9", null), null, "the same number written differently is not a drift");
  assert.equal(headwindTagDrift("PHX-TAB-0009", null, "PHX-TAB-0009"), null, "the next tag matching the Headwind number is not a drift");
  assert.equal(headwindTagDrift("TABLET-A", "PHX-TAB-0004", null), null, "a device number that is not a PHX-TAB number has nothing to compare");

  const drifted = headwindFleetRow(
    device({ deviceNumber: "PHX-TAB-0009", serialNumber: "HA9" }),
    [entry({ assetTag: "PHX-TAB-0008", id: "reg-8", serialNumber: "HA9" })],
    new Map(),
    false,
    "PHX-TAB-0009",
  );
  assert.ok(drifted.tagWarning, "the fleet row carries the warning");
  assert.equal(
    headwindFleetRow(device({ deviceNumber: "PHX-TAB-0009", serialNumber: "HA9" }), [], new Map(), true, null).tagWarning,
    null,
    "an unread register warns of nothing — there is nothing to compare",
  );
  const fleetUi = stripComments(source("src/components/devices/headwind-fleet.tsx"));
  assert.match(fleetUi, /\{row\.tagWarning\}/, "the row shows it");
  assert.match(fleetUi, /result\.tagWarning/, "and so does the notice after Add to custody");
}

async function runDetailTests() {
  resetHeadwindTokenCache();
  // ── F9 and F18: the detail panel names the running launcher, and a missing tablet is an error ──────
  const listing = {
    data: {
      items: [
        {
          id: 7,
          info: {
            applications: [{ pkg: "com.hmdm.launcher", version: "6.39" }],
            location: { lat: 30.0444, lon: 31.2357, ts: Date.parse("2026-11-08T08:00:00Z") },
          },
          launcherVersion: "6.48",
          lastUpdate: Date.parse("2026-11-09T09:00:00Z"),
          number: "PHX-TAB-0007",
        },
      ],
    },
    status: "OK",
  };
  const detail = await getHeadwindDeviceDetail("PHX-TAB-0007", listingFetch(listing), ENV);
  const fact = (label: string) => detail.headline.find((item) => item.label === label)?.value ?? null;
  // BREAK-TEST: put back `push("Headwind agent", device.agentVersion)` and the first two fire.
  assert.equal(fact("Launcher running"), "6.39", "the panel shows the launcher the tablet RUNS, from its own app list");
  assert.equal(fact("Launcher its rules want"), "6.48", "and labels the server's target as what its rules want");
  assert.equal(fact("Headwind agent"), null, "the wanted version is never shown as the tablet's own");
  const position = detail.sections.find((section) => section.title === "Where it was last seen")?.facts[0]?.value ?? "";
  // BREAK-TEST: drop the `· taken …` half of the position fact and this fires.
  assert.equal(
    position,
    `30.0444, 31.2357 · taken ${cairoDateTime("2026-11-08T08:00:00.000Z")}`,
    "a position carries the time it was taken",
  );
  assert.match(position, /10:00$/, "in Cairo time — 08:00 UTC is 10:00 in Cairo in November");

  resetHeadwindTokenCache();
  const noRunning = await getHeadwindDeviceDetail(
    "PHX-TAB-0007",
    listingFetch({ data: { items: [{ id: 7, launcherVersion: "6.48", number: "PHX-TAB-0007" }] }, status: "OK" }),
    ENV,
  );
  assert.equal(
    noRunning.headline.find((item) => item.label === "Launcher running")?.value,
    "Not reported by the tablet",
    "a tablet with no app list says it did not report a launcher, never shows the target in its place",
  );

  // BREAK-TEST: return the empty detail again for a missing device and this assertion fires.
  resetHeadwindTokenCache();
  await assert.rejects(
    () => getHeadwindDeviceDetail("PHX-TAB-0099", listingFetch(listing), ENV),
    HeadwindDeviceNotFoundError,
    "a tablet not in the fleet is an error, never an empty panel",
  );
}

function runLauncherWatchTests() {
  // ── F22: the watch names a held tablet whose launcher stays behind its rules for over 24 hours ─────
  const behind = watched({ agentVersion: "6.48", deviceNumber: "PHX-TAB-0007", launcherVersion: "6.39" });
  // BREAK-TEST: drop the launcher_behind push in `findFleetFaults` and the first assertion fires.
  assert.deepEqual(
    findFleetFaults([behind], NOW, new Map([["6.48", ago(25)]])).map((fault) => fault.kind),
    ["launcher_behind"],
    "a held tablet still on 6.39 a day after its rules wanted 6.48 is named",
  );
  // BREAK-TEST: change TABLET_LAUNCHER_BEHIND_LIMIT_HOURS to 0 and this fires.
  assert.deepEqual(findFleetFaults([behind], NOW, new Map([["6.48", ago(23)]])), [], "inside the first 24 hours, an update is still allowed to land");
  assert.deepEqual(
    findFleetFaults([{ ...behind, launcherVersion: null }], NOW, new Map([["6.48", ago(100)]])),
    [],
    "a tablet that reports no launcher is not called behind — that is not reported, and never guessed",
  );
  assert.deepEqual(
    findFleetFaults([{ ...behind, lastContactAt: ago(100), locatedAt: ago(100) }], NOW, new Map([["6.48", ago(100)]])).map((fault) => fault.kind),
    ["silent"],
    "a silent tablet is named once, for the silence",
  );
  assert.deepEqual(
    findFleetFaults([{ ...behind, holderName: null, registerStatus: "in_stock" }], NOW, new Map([["6.48", ago(100)]])),
    [],
    "a tablet in a cupboard is meant to be quiet",
  );

  // The clock: a version keeps the moment it was first seen, a new one starts now.
  const kept = nextLauncherWantedSince([behind], new Map([["6.48", ago(30)]]), new Date(NOW).toISOString());
  assert.equal(kept.get("6.48"), ago(30), "a version still wanted keeps its first-seen time");
  // BREAK-TEST: drop `previous.get(wanted) ??` in `nextLauncherWantedSince` and the 24 hours never pass.
  const first = assessTabletFleet({ firstSeenAt: null, nowMs: NOW - 25 * HOUR, previousDetail: null, read: { kind: "answered", pendingRegistration: 0, registerError: false, rows: [behind] } });
  assert.equal(first.faults.length, 0, "the first sighting starts the clock and names nobody");
  // 🔴 A BLIND RUN CARRIES THE CLOCK. BREAK-TEST: drop `wantedSinceMarker(previousWanted)` from `blind`
  // and the clock restarts after the timeout, so the last assertion finds no fault.
  const blip = assessTabletFleet({ firstSeenAt: null, nowMs: NOW - 2 * HOUR, previousDetail: first.detail, read: { kind: "transient", message: "timeout" } });
  assert.equal(parseLauncherWantedSince(blip.detail).get("6.48"), new Date(NOW - 25 * HOUR).toISOString(), "a slow answer does not reset the clock");
  const later = assessTabletFleet({ firstSeenAt: null, nowMs: NOW, previousDetail: blip.detail, read: { kind: "answered", pendingRegistration: 0, registerError: false, rows: [behind] } });
  assert.deepEqual(later.faults.map((fault) => fault.kind), ["launcher_behind"], "a day on, the tablet still behind is named");
  assert.match(later.detail, /lastGoodRead=\S+ launcherWantedSince=6\.48@/, "the clock rides in the heartbeat beside the last good read");

  const message = buildFleetWatchMessage(later);
  assert.match(message, /TAG-PHX-TAB-0007, held by A Rep: runs 6\.39, its rules want 6\.48/, "the message says what the tablet runs and what it should");
  assert.doesNotMatch(message, /switched off|disabled|tamper|refus|the rep (did|has|turned)/i, "and never what a rep did");
  assert.notEqual(
    fleetWatchIdempotencyKey(later, "2026-11-09"),
    fleetWatchIdempotencyKey(later, "2026-11-10"),
    "a launcher left behind is said once a day, like silence",
  );

  // One tablet can carry two faults (behind AND no fix); the alert's title counts tablets, not lines.
  const both = findFleetFaults([{ ...behind, latitude: null, locatedAt: null, longitude: null }], NOW, new Map([["6.48", ago(100)]]));
  assert.equal(both.length, 2);
  // BREAK-TEST: return `verdict.faults.length` from `fleetWatchTabletCount` and this reads 2.
  assert.equal(fleetWatchTabletCount({ faults: both }), 1, "the title counts one tablet, not two");

  // The watch still reads only the device list — the clock lives in its own heartbeat.
  const watchSource = stripComments(source("src/lib/devices/headwind/fleet-watch.ts"));
  assert.doesNotMatch(watchSource, /callHeadwind|sync\/configuration|notifications|registerTablet/, "nothing new reaches a tablet or the register");
}

function runAwaitingWatchTests() {
  // ── F21 in the watch: the stalled-enrolment count reaches the Super Admin, monthly ────────────────
  const verdict = assessTabletFleet({
    firstSeenAt: null,
    nowMs: NOW,
    previousDetail: null,
    read: { awaitingHardwareReport: 1, kind: "answered", pendingRegistration: 0, registerError: false, rows: [watched({ deviceNumber: "a" })] },
  });
  // BREAK-TEST: drop `awaitingHardwareReport: awaiting` from the answered verdict and the first fires.
  assert.equal(verdict.awaitingHardwareReport, 1, "the count rides on the verdict");
  assert.match(buildFleetWatchMessage(verdict), /1 enrolled tablet\(s\) never sent their hardware report/, "and is said in the message");
  assert.equal(
    fleetWatchIdempotencyKey(verdict, "2026-11-09"),
    fleetWatchIdempotencyKey(verdict, "2026-11-30"),
    "monthly, like the unregistered count",
  );
  assert.notEqual(
    fleetWatchIdempotencyKey(verdict, "2026-11-09"),
    fleetWatchIdempotencyKey({ ...verdict, awaitingHardwareReport: 0 }, "2026-11-09"),
    "and a change in it gets through",
  );
  assert.equal(
    fleetWatchIdempotencyKey({ faults: [], unregistered: 2, awaitingHardwareReport: 0 }, "2026-11-09"),
    "tablet-fleet-watch:2026-11:unregistered-2",
    "a fleet with none keeps the key it already sent under",
  );
  const alert = stripComments(source("src/lib/devices/headwind/fleet-watch-alert.ts"));
  assert.match(alert, /verdict\.awaitingHardwareReport === 0/, "a fleet with only a stalled enrolment is not skipped as healthy");
  const route = stripComments(source("app/api/cron/tablet-fleet-watch/route.ts"));
  assert.match(route, /awaitingHardwareReport: fleet\.awaitingHardwareReport/, "the cron hands the count to the judgement");
}

function runSentNotDoneTests() {
  // ── F19: a push action's reply says what was SENT, never what the tablet did ──────────────────────
  // BREAK-TEST: put back "is restarting now." for REBOOT and the first assertion fires.
  assert.match(headwindCommandSentMessage("REBOOT", "PHX-TAB-0007"), /was told to restart\. It restarts when it receives the message/);
  assert.doesNotMatch(headwindCommandSentMessage("REBOOT", "PHX-TAB-0007"), /is restarting now/);
  assert.doesNotMatch(headwindCommandSentMessage("RESUME_KIOSK", "PHX-TAB-0007"), /is back in kiosk mode/);
  assert.match(headwindCommandSentMessage("RESUME_KIOSK", "PHX-TAB-0007"), /when it receives the message/);
  for (const id of ["APPLY_SETTINGS", "WAKE_REMOTE_APP", "REBOOT", "PAUSE_KIOSK", "RESUME_KIOSK"] as const) {
    assert.match(headwindCommandSentMessage(id, "PHX-TAB-0007"), /was told/, `${id} says the tablet was told`);
    assert.doesNotMatch(headwindCommandSentMessage(id, "PHX-TAB-0007"), / is (restarting|locked|out of|back in|starting)/, `${id} claims no effect it has not seen`);
  }
  const commands = stripComments(source("src/lib/devices/headwind/commands.ts"));
  assert.doesNotMatch(commands, /pastTense: "Restarted"/, "the audit row says a restart was sent, not that one happened");
}

function runRegisterRouteTests() {
  // A body of `null` used to throw reading `.deviceNumber` and answer 500. BREAK-TEST: put back
  // `(await request.json().catch(() => ({}))) as Record<string, unknown>` and this fires.
  const route = stripComments(source("app/api/devices/headwind/register/route.ts"));
  assert.match(route, /body && typeof body === "object" && !Array\.isArray\(body\)/, "a non-object body is read as no device named");
  assert.match(
    route,
    /const csrf = assertSameOriginMutation\(request\);\s*if \(csrf\) return csrf;\s*const access = await resolveAccessContext\(request\);\s*await assertPermission\(access, "company_devices", "approve"\);/,
    "same-origin, then the Super Admin gate, before the body is read",
  );
}

export async function runHeadwindReadinessTests() {
  runLauncherReadinessTests();
  runRegisterUnknownTests();
  runHardwareReportTests();
  runTagDriftTests();
  await runDetailTests();
  runLauncherWatchTests();
  runAwaitingWatchTests();
  runSentNotDoneTests();
  runRegisterRouteTests();
}
