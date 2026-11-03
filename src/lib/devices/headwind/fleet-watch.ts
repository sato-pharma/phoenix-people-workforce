/**
 * The tablet fleet watch's judgement (owner, 2026-11-03): read every hour whether a tablet held by a rep
 * has gone quiet, and tell the Super Admin alone.
 *
 * 🔴 READ ONLY, AND SILENT ON THE TABLET. The watch reads the server's device list and nothing else. It never
 * calls `sync/configuration` or `/notifications` for a real device, which consume the actions queued for it,
 * and it never pushes anything, so a rep sees no sign of it. It never registers a tablet either: an
 * unregistered tablet is a count in the message, and adding it to the register stays a person's press.
 *
 * BLIND MEANS FAIL, the same shape as the GitHub watch. Not configured, or a read refused, fails at once. A
 * timeout only logs until the last good read is over three hours old, and that clock is carried in the
 * heartbeat detail, so one slow answer from a small server does not page anyone.
 *
 * THE FIX CLOCK IS LOOSE ON PURPOSE. A rep's tablet reports a fix on each sync only while its location
 * service gets one, and a tablet left in a drawer indoors reports none for days. So "checks in but no fix"
 * waits 72 hours, the same as silence, and it names a tablet to look at. It never says the rep did anything.
 *
 * A TABLET THAT NEVER REPORTED A FIX IS ITS OWN KIND. Read live on 3 Nov 2026: neither tablet carries a location
 * in the device list or in the location history, so every held tablet has none on record. That is true and worth
 * saying, but a daily line about it would drown a tablet that had a fix and lost it, so the alert says it monthly.
 */

import type { RepHeadwindRow } from "@/lib/devices/headwind/fleet";

const HOUR_MS = 60 * 60 * 1000;

export const TABLET_SILENT_LIMIT_HOURS = 72;
export const TABLET_NO_FIX_LIMIT_HOURS = 72;
export const FLEET_READ_BLIND_LIMIT_MS = 3 * HOUR_MS;

export type FleetWatchRow = Pick<
  RepHeadwindRow,
  "assetTag" | "deviceNumber" | "holderName" | "lastContactAt" | "locatedAt" | "name" | "registerStatus"
>;

export type FleetWatchRead =
  | { kind: "answered"; pendingRegistration: number; registerError: boolean; rows: readonly FleetWatchRow[] }
  | { kind: "not_configured" }
  | { kind: "refused"; message: string }
  | { kind: "transient"; message: string };

export type FleetTabletFault = {
  deviceNumber: string;
  holderName: string;
  kind: "silent" | "no_fix" | "never_fixed";
  label: string;
  lastAt: string | null;
};

export type FleetWatchVerdict = {
  detail: string;
  faults: FleetTabletFault[];
  outcome: "success" | "fail";
  serverDown: boolean;
  unregistered: number;
};

const MARKER = /lastGoodRead=(\S+)/;

export function parseFleetLastGoodRead(detail: string | null | undefined): string | null {
  const iso = MARKER.exec(detail ?? "")?.[1] ?? null;
  return iso && Number.isFinite(Date.parse(iso)) ? iso : null;
}

function olderThan(iso: string | null, nowMs: number, hours: number): boolean {
  if (!iso) return true;
  const at = Date.parse(iso);
  return !Number.isFinite(at) || nowMs - at > hours * HOUR_MS;
}

/** Pure: the tablets to look at. Only a tablet held by a person: one in a cupboard is meant to be quiet. */
export function findFleetFaults(rows: readonly FleetWatchRow[], nowMs: number): FleetTabletFault[] {
  const faults: FleetTabletFault[] = [];
  for (const row of rows) {
    const holderName = row.holderName?.trim();
    if (row.registerStatus !== "assigned" || !holderName) continue;
    const label = row.assetTag ?? row.name;
    if (olderThan(row.lastContactAt, nowMs, TABLET_SILENT_LIMIT_HOURS)) {
      faults.push({ deviceNumber: row.deviceNumber, holderName, kind: "silent", label, lastAt: row.lastContactAt });
    } else if (!row.locatedAt) {
      faults.push({ deviceNumber: row.deviceNumber, holderName, kind: "never_fixed", label, lastAt: null });
    } else if (olderThan(row.locatedAt, nowMs, TABLET_NO_FIX_LIMIT_HOURS)) {
      faults.push({ deviceNumber: row.deviceNumber, holderName, kind: "no_fix", label, lastAt: row.locatedAt });
    }
  }
  return faults.sort((left, right) => left.deviceNumber.localeCompare(right.deviceNumber));
}

export function assessTabletFleet(input: {
  firstSeenAt: string | null;
  nowMs: number;
  previousDetail: string | null;
  read: FleetWatchRead;
}): FleetWatchVerdict {
  const nowIso = new Date(input.nowMs).toISOString();
  const lastGood = parseFleetLastGoodRead(input.previousDetail) ?? input.firstSeenAt ?? nowIso;
  const marker = (iso: string) => `lastGoodRead=${iso}`;
  const blind = (detail: string, outcome: "success" | "fail", serverDown: boolean): FleetWatchVerdict => ({
    detail: `${detail} ${marker(lastGood)}`,
    faults: [],
    outcome,
    serverDown,
    unregistered: 0,
  });

  if (input.read.kind === "not_configured") {
    return blind("The Headwind settings are not set, so nothing is watching the tablets.", "fail", true);
  }
  if (input.read.kind === "refused") {
    return blind(`The Headwind server refused the read: ${input.read.message}.`, "fail", true);
  }
  if (input.read.kind === "transient") {
    const blindMs = input.nowMs - Date.parse(lastGood);
    const tooLong = !Number.isFinite(blindMs) || blindMs > FLEET_READ_BLIND_LIMIT_MS;
    return tooLong
      ? blind(`The Headwind server has not answered for over three hours: ${input.read.message}.`, "fail", true)
      : blind(`The Headwind server did not answer on this run: ${input.read.message}.`, "success", false);
  }
  if (input.read.registerError) {
    // Who holds a tablet comes from the register, so nothing can be judged without it.
    return blind("The custody register could not be read, so tablets cannot be matched to people.", "fail", false);
  }

  if (input.read.rows.length === 0) {
    return blind("The Headwind server answered with no tablets at all.", "fail", false);
  }

  const faults = findFleetFaults(input.read.rows, input.nowMs);
  const silent = faults.filter((fault) => fault.kind === "silent").length;
  const noFix = faults.filter((fault) => fault.kind === "no_fix").length;
  const neverFixed = faults.filter((fault) => fault.kind === "never_fixed").length;
  return {
    detail: `${input.read.rows.length} tablet(s), ${silent} silent, ${noFix} lost their location fix, ${neverFixed} never reported one, ${input.read.pendingRegistration} unregistered. ${marker(nowIso)}`,
    faults,
    outcome: "success",
    serverDown: false,
    unregistered: input.read.pendingRegistration,
  };
}

function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date(iso));
}

/** Pure: the message. Goes to the Super Admin alone, and says what the tablet did, never what a rep did. */
export function buildFleetWatchMessage(verdict: Pick<FleetWatchVerdict, "faults" | "unregistered">): string {
  const lines: string[] = [];
  const silent = verdict.faults.filter((fault) => fault.kind === "silent");
  const noFix = verdict.faults.filter((fault) => fault.kind === "no_fix");
  const neverFixed = verdict.faults.filter((fault) => fault.kind === "never_fixed");
  if (silent.length > 0) {
    lines.push(`No check-in for over ${TABLET_SILENT_LIMIT_HOURS} hours:`);
    for (const fault of silent) {
      lines.push(`• ${fault.label}, held by ${fault.holderName}: ${fault.lastAt ? `last ${cairoStamp(fault.lastAt)} Cairo` : "never checked in"}.`);
    }
  }
  if (noFix.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Checks in, but no location fix for over ${TABLET_NO_FIX_LIMIT_HOURS} hours:`);
    for (const fault of noFix) {
      lines.push(`• ${fault.label}, held by ${fault.holderName}: last fix ${fault.lastAt ? `${cairoStamp(fault.lastAt)} Cairo` : "not recorded"}.`);
    }
  }
  if (neverFixed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Checks in, but has never reported a location:");
    for (const fault of neverFixed) lines.push(`• ${fault.label}, held by ${fault.holderName}.`);
  }
  if (verdict.unregistered > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`${verdict.unregistered} tablet(s) are not in the custody register yet. Adding one is a press on the Tablet Dashboard.`);
  }
  return lines.join("\n");
}
