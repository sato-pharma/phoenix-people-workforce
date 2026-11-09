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
 *
 * 🔴 A LAUNCHER LEFT BEHIND ITS RULES IS A FAULT (9 Nov 2026). PHX-TAB-0007 checked in for 17 days on launcher
 * 6.39 while its rules wanted 6.48, because every update run stopped at a dead install link — no location and no
 * remote screen ID the whole time, and nothing said so. The device list carries both halves: the version the
 * server WANTS (the row's top-level `launcherVersion`, `agentVersion` here) and the one the tablet RUNS (its own
 * app list, `launcherVersion` here). The list carries no date for when a version started being wanted, so the
 * watch keeps that clock itself, one entry per wanted version, in the heartbeat detail beside `lastGoodRead`; a
 * held tablet still below a version its rules have wanted for over 24 hours is named. A tablet whose app list
 * names no launcher is not "behind" — that is not reported, and is never guessed either way.
 *
 * A TABLET THAT NEVER SENT ITS HARDWARE REPORT IS COUNTED TOO. One with neither a serial nor an IMEI cannot be
 * added to custody, so `pendingRegistration` leaves it out — and the message used to leave it out with it. Its
 * first update run almost always stalled on an install link; it is said with the unregistered count, monthly.
 */

import type { RepHeadwindRow } from "@/lib/devices/headwind/fleet";

const HOUR_MS = 60 * 60 * 1000;

export const TABLET_SILENT_LIMIT_HOURS = 72;
export const TABLET_NO_FIX_LIMIT_HOURS = 72;
/** How long a held tablet may run an older launcher than its rules want before the watch names it. */
export const TABLET_LAUNCHER_BEHIND_LIMIT_HOURS = 24;
export const FLEET_READ_BLIND_LIMIT_MS = 3 * HOUR_MS;

/**
 * A launcher version string as one comparable number, or null when there is nothing to parse.
 *
 * 🔴 WHY NOT STRING COMPARE. These are `6.<build>` versions, so 6.39 is newer than 6.9 (build 39 beats
 * build 9) — but "6.39" < "6.9" as strings, which would call the newer tablet behind. The version is
 * split into its numeric segments and each weighted by position, so the order comes out 6.48 > 6.39 >
 * 6.9. A large per-segment base keeps the segments from colliding; launcher builds never approach it.
 * It lives here, not in `dashboard.ts`, because the watch needs it and `dashboard.ts` already imports
 * this file; `dashboard.ts` re-exports it, so there is one copy and no import cycle.
 */
export function launcherRank(version: string | null): number | null {
  if (!version) return null;
  const segments = version.split(/[^0-9]+/).filter((part) => part.length > 0);
  if (segments.length === 0) return null;
  const BASE = 1_000_000;
  let rank = 0;
  for (let index = 0; index < 3; index += 1) {
    const value = index < segments.length ? Number(segments[index]) : 0;
    if (!Number.isFinite(value)) return null;
    rank = rank * BASE + Math.min(value, BASE - 1);
  }
  return rank;
}

export type FleetWatchRow = Pick<
  RepHeadwindRow,
  | "assetTag"
  | "deviceNumber"
  | "holderName"
  | "lastContactAt"
  | "latitude"
  | "locatedAt"
  | "longitude"
  | "name"
  | "registerStatus"
> &
  Partial<Pick<RepHeadwindRow, "agentVersion" | "launcherVersion">>;

export type FleetWatchRead =
  | {
      kind: "answered";
      pendingRegistration: number;
      /** Enrolled tablets the register cannot take yet: they never sent a serial number or an IMEI. */
      awaitingHardwareReport?: number;
      registerError: boolean;
      rows: readonly FleetWatchRow[];
    }
  | { kind: "not_configured" }
  | { kind: "refused"; message: string }
  | { kind: "transient"; message: string };

export type FleetTabletFault = {
  deviceNumber: string;
  holderName: string;
  kind: "silent" | "no_fix" | "never_fixed" | "launcher_behind";
  label: string;
  lastAt: string | null;
  /** `launcher_behind` only: the version the tablet runs, and the one its rules want. */
  running?: string;
  wanted?: string;
};

export type FleetWatchVerdict = {
  detail: string;
  faults: FleetTabletFault[];
  outcome: "success" | "fail";
  serverDown: boolean;
  unregistered: number;
  awaitingHardwareReport: number;
};

const MARKER = /lastGoodRead=(\S+)/;
const WANTED_MARKER = /launcherWantedSince=(\S+)/;
/** A version written into the marker: no space, comma or `@`, so the marker always reads back whole. */
const MARKER_VERSION = /^[0-9A-Za-z._-]+$/;

export function parseFleetLastGoodRead(detail: string | null | undefined): string | null {
  const iso = MARKER.exec(detail ?? "")?.[1] ?? null;
  return iso && Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** When the watch first saw each launcher version wanted, out of the last heartbeat detail. */
export function parseLauncherWantedSince(detail: string | null | undefined): Map<string, string> {
  const since = new Map<string, string>();
  const raw = WANTED_MARKER.exec(detail ?? "")?.[1];
  if (!raw) return since;
  for (const entry of raw.split(",")) {
    const at = entry.lastIndexOf("@");
    if (at <= 0) continue;
    const version = entry.slice(0, at);
    const iso = entry.slice(at + 1);
    if (MARKER_VERSION.test(version) && Number.isFinite(Date.parse(iso))) since.set(version, iso);
  }
  return since;
}

function wantedSinceMarker(since: ReadonlyMap<string, string>): string {
  if (since.size === 0) return "";
  const entries = [...since.entries()].sort(([left], [right]) => left.localeCompare(right));
  return ` launcherWantedSince=${entries.map(([version, iso]) => `${version}@${iso}`).join(",")}`;
}

/**
 * The wanted-version clock after this read: a version still wanted keeps the moment it was first seen,
 * a new one starts now, and one no tablet wants any more is dropped, so the marker stays short.
 */
export function nextLauncherWantedSince(
  rows: readonly FleetWatchRow[],
  previous: ReadonlyMap<string, string>,
  nowIso: string,
): Map<string, string> {
  const next = new Map<string, string>();
  for (const row of rows) {
    const wanted = row.agentVersion?.trim();
    if (!wanted || !MARKER_VERSION.test(wanted) || next.has(wanted)) continue;
    next.set(wanted, previous.get(wanted) ?? nowIso);
  }
  return next;
}

function olderThan(iso: string | null, nowMs: number, hours: number): boolean {
  if (!iso) return true;
  const at = Date.parse(iso);
  return !Number.isFinite(at) || nowMs - at > hours * HOUR_MS;
}

/**
 * Pure: the tablets to look at. Only a tablet held by a person: one in a cupboard is meant to be quiet.
 *
 * `launcherWantedSince` is the watch's own clock of when each wanted version was first seen (see the
 * header). Without an entry for a tablet's wanted version nothing can say how long it has been behind,
 * so no launcher fault is raised for it.
 */
export function findFleetFaults(
  rows: readonly FleetWatchRow[],
  nowMs: number,
  launcherWantedSince: ReadonlyMap<string, string> = new Map(),
): FleetTabletFault[] {
  const faults: FleetTabletFault[] = [];
  for (const row of rows) {
    const holderName = row.holderName?.trim();
    if (row.registerStatus !== "assigned" || !holderName) continue;
    const label = row.assetTag ?? row.name;
    if (olderThan(row.lastContactAt, nowMs, TABLET_SILENT_LIMIT_HOURS)) {
      // A silent tablet cannot update or locate itself; the silence is the one line worth saying.
      faults.push({ deviceNumber: row.deviceNumber, holderName, kind: "silent", label, lastAt: row.lastContactAt });
      continue;
    }
    const running = row.launcherVersion?.trim() ?? "";
    const wanted = row.agentVersion?.trim() ?? "";
    const runningRank = launcherRank(running || null);
    const wantedRank = launcherRank(wanted || null);
    const wantedSince = wanted ? launcherWantedSince.get(wanted) ?? null : null;
    if (
      runningRank !== null &&
      wantedRank !== null &&
      runningRank < wantedRank &&
      wantedSince !== null &&
      olderThan(wantedSince, nowMs, TABLET_LAUNCHER_BEHIND_LIMIT_HOURS)
    ) {
      faults.push({
        deviceNumber: row.deviceNumber,
        holderName,
        kind: "launcher_behind",
        label,
        lastAt: wantedSince,
        running,
        wanted,
      });
    }
    if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) {
      // 🔴 "NEVER FIXED" IS DECIDED BY THE COORDINATES, NOT THE TIME. A tablet that sent a position
      // without a time of its own HAS reported one; reading the missing time as "never" filed a located
      // tablet under the once-a-month line, where it was not looked at.
      faults.push({ deviceNumber: row.deviceNumber, holderName, kind: "never_fixed", label, lastAt: null });
    } else if (olderThan(row.locatedAt, nowMs, TABLET_NO_FIX_LIMIT_HOURS)) {
      faults.push({ deviceNumber: row.deviceNumber, holderName, kind: "no_fix", label, lastAt: row.locatedAt });
    }
  }
  return faults.sort(
    (left, right) => left.deviceNumber.localeCompare(right.deviceNumber) || left.kind.localeCompare(right.kind),
  );
}

export function assessTabletFleet(input: {
  firstSeenAt: string | null;
  nowMs: number;
  previousDetail: string | null;
  read: FleetWatchRead;
}): FleetWatchVerdict {
  const nowIso = new Date(input.nowMs).toISOString();
  const lastGood = parseFleetLastGoodRead(input.previousDetail) ?? input.firstSeenAt ?? nowIso;
  const previousWanted = parseLauncherWantedSince(input.previousDetail);
  const marker = (iso: string) => `lastGoodRead=${iso}`;
  // 🔴 A BLIND RUN CARRIES THE WANTED-VERSION CLOCK FORWARD UNCHANGED. Dropping it would restart the
  // 24-hour wait after every slow answer, and a tablet stuck for weeks would go quiet for another day.
  const blind = (detail: string, outcome: "success" | "fail", serverDown: boolean): FleetWatchVerdict => ({
    awaitingHardwareReport: 0,
    detail: `${detail} ${marker(lastGood)}${wantedSinceMarker(previousWanted)}`,
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

  const wantedSince = nextLauncherWantedSince(input.read.rows, previousWanted, nowIso);
  const faults = findFleetFaults(input.read.rows, input.nowMs, wantedSince);
  const silent = faults.filter((fault) => fault.kind === "silent").length;
  const noFix = faults.filter((fault) => fault.kind === "no_fix").length;
  const neverFixed = faults.filter((fault) => fault.kind === "never_fixed").length;
  const behind = faults.filter((fault) => fault.kind === "launcher_behind").length;
  const awaiting = input.read.awaitingHardwareReport ?? 0;
  return {
    awaitingHardwareReport: awaiting,
    detail: `${input.read.rows.length} tablet(s), ${silent} silent, ${noFix} lost their location fix, ${neverFixed} never reported one, ${behind} on a launcher behind their rules, ${input.read.pendingRegistration} unregistered, ${awaiting} never sent their hardware report. ${marker(nowIso)}${wantedSinceMarker(wantedSince)}`,
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
export function buildFleetWatchMessage(
  verdict: Pick<FleetWatchVerdict, "faults" | "unregistered"> & Partial<Pick<FleetWatchVerdict, "awaitingHardwareReport">>,
): string {
  const lines: string[] = [];
  const silent = verdict.faults.filter((fault) => fault.kind === "silent");
  const noFix = verdict.faults.filter((fault) => fault.kind === "no_fix");
  const neverFixed = verdict.faults.filter((fault) => fault.kind === "never_fixed");
  const behind = verdict.faults.filter((fault) => fault.kind === "launcher_behind");
  const awaiting = verdict.awaitingHardwareReport ?? 0;
  if (silent.length > 0) {
    lines.push(`No check-in for over ${TABLET_SILENT_LIMIT_HOURS} hours:`);
    for (const fault of silent) {
      lines.push(`• ${fault.label}, held by ${fault.holderName}: ${fault.lastAt ? `last ${cairoStamp(fault.lastAt)} Cairo` : "never checked in"}.`);
    }
  }
  if (behind.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Checks in, but still runs an older launcher than its rules want, for over ${TABLET_LAUNCHER_BEHIND_LIMIT_HOURS} hours:`);
    for (const fault of behind) {
      const since = fault.lastAt ? `, wanted since at least ${cairoStamp(fault.lastAt)} Cairo` : "";
      lines.push(
        `• ${fault.label}, held by ${fault.holderName}: runs ${fault.running}, its rules want ${fault.wanted}${since}. Its update run is probably stopping at an install link.`,
      );
    }
  }
  if (noFix.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Checks in, but no location fix for over ${TABLET_NO_FIX_LIMIT_HOURS} hours:`);
    for (const fault of noFix) {
      lines.push(`• ${fault.label}, held by ${fault.holderName}: last fix ${fault.lastAt ? `${cairoStamp(fault.lastAt)} Cairo` : "time not reported by the tablet"}.`);
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
  if (awaiting > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${awaiting} enrolled tablet(s) never sent their hardware report (serial number or IMEI), so they cannot be added to custody yet. Their first update run probably stalled on an install link.`,
    );
  }
  return lines.join("\n");
}
