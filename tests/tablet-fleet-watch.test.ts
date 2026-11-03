import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessTabletFleet,
  buildFleetWatchMessage,
  findFleetFaults,
  parseFleetLastGoodRead,
  type FleetWatchRead,
  type FleetWatchRow,
} from "../src/lib/devices/headwind/fleet-watch.ts";
import { fleetWatchIdempotencyKey } from "../src/lib/devices/headwind/fleet-watch-alert.ts";
import { operatorWatchBlocksTelegramFallback } from "../src/lib/notifications/operator-watch-channel-guard.ts";
import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function tablet(overrides: Partial<FleetWatchRow> & { deviceNumber: string }): FleetWatchRow {
  return {
    assetTag: `PHX-${overrides.deviceNumber}`,
    holderName: "A Rep",
    lastContactAt: ago(1),
    locatedAt: ago(1),
    name: overrides.deviceNumber,
    registerStatus: "assigned",
    ...overrides,
  };
}

function answered(rows: FleetWatchRow[], pendingRegistration = 0): FleetWatchRead {
  return { kind: "answered", pendingRegistration, registerError: false, rows };
}

function assess(read: FleetWatchRead, previousDetail: string | null = null) {
  return assessTabletFleet({ firstSeenAt: "2026-11-01T00:00:00Z", nowMs: NOW, previousDetail, read });
}

export function runTabletFleetWatchTests() {
  // Who it flags.
  const faults = findFleetFaults(
    [
      tablet({ deviceNumber: "fine" }),
      tablet({ deviceNumber: "silent", lastContactAt: ago(73), locatedAt: ago(73) }),
      tablet({ deviceNumber: "never", lastContactAt: null, locatedAt: null }),
      tablet({ deviceNumber: "nofix", locatedAt: ago(73) }),
      tablet({ deviceNumber: "nofix-ever", locatedAt: null }),
      tablet({ deviceNumber: "edge", lastContactAt: ago(71), locatedAt: ago(71) }),
      tablet({ deviceNumber: "cupboard", holderName: null, lastContactAt: ago(500), locatedAt: null, registerStatus: "in_stock" }),
      tablet({ deviceNumber: "reserved", lastContactAt: ago(500), registerStatus: "reserved" }),
    ],
    NOW,
  );
  assert.deepEqual(
    faults.map((fault) => `${fault.deviceNumber}:${fault.kind}`),
    ["never:silent", "nofix:no_fix", "nofix-ever:never_fixed", "silent:silent"],
    "a tablet held by a person, silent or fixless past 72 hours; a tablet in a cupboard is meant to be quiet",
  );

  // Blind means fail.
  assert.equal(assess({ kind: "not_configured" }).outcome, "fail", "no settings means nobody is watching");
  assert.equal(assess({ kind: "refused", message: "status 401" }).outcome, "fail", "a refusal fails at once");
  assert.equal(
    assess({ kind: "answered", pendingRegistration: 0, registerError: true, rows: [tablet({ deviceNumber: "a" })] }).outcome,
    "fail",
    "without the register nothing can be matched to a person",
  );
  assert.equal(assess(answered([])).outcome, "fail", "every tablet vanishing is a blind read, never a clean hour");

  // A timeout logs until the last good read is three hours old, and the clock survives the bad run.
  const good = assess(answered([tablet({ deviceNumber: "a" })]));
  assert.equal(good.outcome, "success");
  assert.equal(parseFleetLastGoodRead(good.detail), new Date(NOW).toISOString(), "a complete read records itself");
  const recent = `lastGoodRead=${ago(2)}`;
  const shortBlip = assess({ kind: "transient", message: "timeout" }, recent);
  assert.equal(shortBlip.outcome, "success", "one slow answer pages nobody");
  assert.equal(parseFleetLastGoodRead(shortBlip.detail), ago(2), "and it does not move the clock");
  assert.equal(assess({ kind: "transient", message: "timeout" }, `lastGoodRead=${ago(4)}`).outcome, "fail", "over three hours fails");

  // A tablet to look at is a finding, not a failed run of this job.
  const finding = assess(answered([tablet({ deviceNumber: "s", lastContactAt: ago(100), locatedAt: ago(100) })], 2));
  assert.equal(finding.outcome, "success");
  assert.equal(finding.faults.length, 1);
  assert.equal(finding.unregistered, 2, "the unregistered count rides along");

  // The words: the tablet's behaviour, never an accusation, and never a claim of what the rep did.
  const message = buildFleetWatchMessage(finding);
  assert.match(message, /PHX-s, held by A Rep/);
  assert.match(message, /2 tablet\(s\) are not in the custody register/);
  assert.doesNotMatch(message, /switched off|disabled|tamper|refus/i);

  // A tablet that never reported a location says so, once a month rather than every day.
  const neverFixed = assess(answered([tablet({ deviceNumber: "n", locatedAt: null })]));
  assert.match(neverFixed.detail, /0 lost their location fix, 1 never reported one/);
  assert.match(buildFleetWatchMessage(neverFixed), /has never reported a location:\n• PHX-n, held by A Rep\./);
  assert.doesNotMatch(buildFleetWatchMessage(neverFixed), /switched off|disabled|tamper|refus/i);
  assert.equal(
    fleetWatchIdempotencyKey(neverFixed, "2026-11-03"),
    fleetWatchIdempotencyKey(neverFixed, "2026-11-30"),
    "a standing no-fix-on-record does not repeat daily",
  );
  assert.notEqual(fleetWatchIdempotencyKey(neverFixed, "2026-11-03"), fleetWatchIdempotencyKey(neverFixed, "2026-12-01"), "but it comes back next month");
  assert.notEqual(
    fleetWatchIdempotencyKey(neverFixed, "2026-11-03"),
    fleetWatchIdempotencyKey({ faults: [...neverFixed.faults, { ...neverFixed.faults[0], deviceNumber: "m" }], unregistered: 0 }, "2026-11-03"),
    "a new tablet with none still gets through",
  );
  assert.notEqual(
    fleetWatchIdempotencyKey({ faults: [...neverFixed.faults, ...finding.faults], unregistered: 0 }, "2026-11-03"),
    fleetWatchIdempotencyKey({ faults: [...neverFixed.faults, ...finding.faults], unregistered: 0 }, "2026-11-04"),
    "a silent tablet beside it keeps the daily line",
  );

  // The key: a standing fault says it once a Cairo day, a new tablet gets through, an unregistered count alone speaks when it changes.
  const one = { faults: finding.faults, unregistered: 0 };
  assert.notEqual(fleetWatchIdempotencyKey(one, "2026-11-03"), fleetWatchIdempotencyKey(one, "2026-11-04"), "once per day");
  assert.equal(
    fleetWatchIdempotencyKey({ faults: [], unregistered: 2 }, "2026-11-03"),
    fleetWatchIdempotencyKey({ faults: [], unregistered: 2 }, "2026-11-04"),
    "an unchanged unregistered count does not repeat daily",
  );
  assert.notEqual(
    fleetWatchIdempotencyKey({ faults: [], unregistered: 2 }, "2026-11-03"),
    fleetWatchIdempotencyKey({ faults: [], unregistered: 2 }, "2026-12-01"),
    "a count that returns to an earlier number is not silent for good",
  );
  assert.equal(operatorWatchBlocksTelegramFallback("tablet_fleet_watch"), true, "a failed Telegram send never becomes an email");

  // It tells the Super Admin alone, never by email, and it touches no tablet.
  const alert = readFileSync("src/lib/devices/headwind/fleet-watch-alert.ts", "utf8");
  assert.match(alert, /hrIdsForRoles\(\["Super Admin"\]\)/, "the Super Admin alone: reps never see any sign of it");
  assert.match(alert, /channels: \["in_app", "telegram", "push"\]/, "never email");
  const route = readFileSync("app/api/cron/tablet-fleet-watch/route.ts", "utf8");
  assert.match(route, /getHeadwindFleet\(\)/, "it reads the fleet");
  for (const source of [route, readFileSync("src/lib/devices/headwind/fleet-watch.ts", "utf8").replace(/\/\*\*[\s\S]*?\*\//g, ""), alert.replace(/\/\*\*[\s\S]*?\*\//g, "")]) {
    assert.doesNotMatch(source, /callHeadwind|sync\/configuration|rest\/[a-z/]*notifications|registerTablet|recordHeadwind/, "the watch never writes to a tablet or the register");
  }

  // The paperwork a new cron needs.
  assert.equal(findAccessRegistryEntry("/api/cron/tablet-fleet-watch", "GET")?.authMode, "cron-secret");
}
