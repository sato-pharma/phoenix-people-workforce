/**
 * The Headwind fleet as the Phoenix console shows it — each managed tablet joined to its custody
 * register entry, so one screen answers both "what is this tablet doing" and "who is holding it".
 *
 * A row carries the Headwind DEVICE NUMBER (what a remote action is aimed at) and, where the register
 * knows the tablet, its asset tag and holder. A tablet Headwind manages but the register has never
 * seen still shows — flagged as not in the register — because an unknown managed tablet is exactly
 * the thing a custody console should surface, not hide.
 *
 * THE FLEET READ NO LONGER FILLS THE REGISTER (owner, 2026-10-22: "new tablets enter Device Custody
 * only when a person confirms them"). Until that day a tablet that enrolled on the company's own
 * Headwind server added ITSELF to the custody register on this read. That silent auto-create is gone:
 * a managed tablet the register has never seen shows here flagged as not in the register, and
 * `pendingRegistration` counts the ones a person could add — those carrying a serial or an IMEI. A
 * person adds each from its own row through `/api/devices/headwind/register`; this read only reads.
 *
 * A tablet with NEITHER is counted on its own (`awaitingHardwareReport`) and its row says why: it enrolled
 * but its first update run never got as far as the hardware report, so there is nothing to add it by.
 *
 * Each row also carries `tagWarning` when the Headwind device number and the custody tag (or the tag the
 * next press would give it) name the tablet differently — said, never corrected here.
 */

import { listHeadwindDevices, matchHeadwindToRegister, type HeadwindDevice } from "@/lib/devices/headwind/devices";
import {
  headwindImeisToRecord,
  headwindNextAssetTag,
  headwindTabletCanBeTold,
  headwindTabletsAwaitingHardwareReport,
  headwindTabletsToRegister,
  headwindTagDrift,
} from "@/lib/devices/headwind/register-sync";
import { isRustDeskConfigured } from "@/lib/devices/rustdesk/config";
import { getDeviceRegisterData, loadReservedAssignments } from "@/lib/devices/service";
import type { AssignableEmployee, DeviceStatus } from "@/lib/devices/types";

/** Where a device's live reservation (id + held-for name) is looked up, keyed by register device id. */
type ReservationByDevice = Map<string, { assignmentId: string; placeholderName: string | null }>;

export type RepHeadwindRow = {
  /** The id a remote action targets — Headwind's device NUMBER, never its row id. A React key too. */
  deviceNumber: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  imei: string | null;
  osVersion: string | null;
  platformLabel: string;
  isAndroid: boolean;
  enrollmentStatus: string | null;
  /** The Headwind configuration the tablet runs — its rules, its kiosk and its app list. */
  configurationName: string | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  agentVersion: string | null;
  /** The launcher version the tablet is actually RUNNING (not the enrolment target) — for "up to date?". */
  launcherVersion: string | null;
  lastContactAt: string | null;
  latitude: number | null;
  longitude: number | null;
  locatedAt: string | null;
  /** Present when the tablet is set up for remote screen sessions. */
  rustDeskId: string | null;
  /** From the custody register, when the tablet is matched. */
  assetTag: string | null;
  holderName: string | null;
  holderJobTitle: string | null;
  /**
   * From the custody register: the SIM and line recorded against the tablet, null when unregistered.
   * Either one present means the tablet carries a data SIM and stays online without a rep's Wi-Fi.
   */
  simNumber: string | null;
  lineNumber: string | null;
  /** The matched register device id — what a reserve/assign/mark action targets. Null if unregistered. */
  registerDeviceId: string | null;
  /** The register device's custody status: in_stock, reserved, assigned, repair, lost, stolen, retired. */
  registerStatus: DeviceStatus | null;
  /** The LIVE custody record — the outstanding holder's, or the reservation's. What return/reconcile/revoke target. */
  assignmentId: string | null;
  /** When the tablet is reserved for a not-yet-hired holder: the typed name it is held for. */
  placeholderName: string | null;
  /** The register was read and does not know this managed tablet. False when the register could not be read. */
  unregistered: boolean;
  /**
   * Not in the register AND carrying a serial number or IMEI the register can tell it apart by — the
   * server's own answer to "can Add to custody work", so the button never offers what the route refuses.
   */
  canAddToCustody: boolean;
  /**
   * Not in the register, and enrolled without ever sending its hardware report (no serial number, no
   * IMEI) — its first update run probably stalled on an install link. It cannot be added until it does.
   */
  awaitingHardwareReport: boolean;
  /** The Headwind device number and the custody tag (or the tag a press would give it) read differently. */
  tagWarning: string | null;
};

export type HeadwindFleetState = {
  rows: RepHeadwindRow[];
  /** The custody register could not be read, so holders are unknown but the fleet still shows. */
  registerError: boolean;
  /**
   * Managed tablets the register has never seen that CARRY a serial or an IMEI — the ones a person can
   * confirm into custody from their row. Not every unregistered tablet: one reporting neither cannot be
   * told apart, so it is not offered. The count, never the act — nothing is added on this read.
   */
  pendingRegistration: number;
  /**
   * Managed tablets the register has never seen that carry NEITHER a serial nor an IMEI — enrolled, but
   * the hardware report never came. Counted apart from `pendingRegistration`, which cannot take them.
   */
  awaitingHardwareReport: number;
  /** Register entries holding no IMEI whose tablet reports one — what the copy would write. */
  imeisToRecord: number;
  /** Whether the company's RustDesk relay is set up, so the screen buttons can be offered. */
  remoteScreenReady: boolean;
  /** Active employees a tablet can be assigned or reconciled to — the picker's options. */
  assignable: AssignableEmployee[];
};

/** One fleet row — exported so the row's readiness fields are proven without a database. */
export function headwindFleetRow(
  device: HeadwindDevice,
  register: Parameters<typeof matchHeadwindToRegister>[1],
  reservations: ReservationByDevice,
  registerError: boolean,
  nextTag: string | null,
): RepHeadwindRow {
  const entry = matchHeadwindToRegister(device, register);
  const reservation = entry ? reservations.get(entry.id) ?? null : null;
  // 🔴 AN UNREADABLE REGISTER IS NOT AN EMPTY ONE. With no register read, every tablet matches nothing,
  // and flagging them all "not in the custody register" offered an Add to custody on tablets that are
  // in it — a duplicate row a click away. Unknown stays unknown: the page says the register could not
  // be read, and offers nothing to add.
  const unregistered = !registerError && entry === null;
  const told = headwindTabletCanBeTold(device);
  return {
    agentVersion: device.agentVersion,
    assetTag: entry?.assetTag ?? null,
    // The live custody record. The register match carries no assignment id, so the reservation lookup
    // is the source when reserved; an assigned tablet shows its holder read-only and needs none.
    assignmentId: reservation?.assignmentId ?? null,
    awaitingHardwareReport: unregistered && !told,
    batteryCharging: device.batteryCharging,
    canAddToCustody: unregistered && told,
    batteryLevel: device.batteryLevel,
    configurationName: device.configurationName,
    deviceNumber: device.deviceNumber,
    enrollmentStatus: device.enrollmentStatus,
    holderJobTitle: entry?.holderJobTitle ?? null,
    holderName: entry?.holderName ?? null,
    imei: device.imei,
    isAndroid: device.isAndroid,
    lastContactAt: device.lastContactAt,
    latitude: device.latitude,
    launcherVersion: device.launcherVersion,
    lineNumber: entry?.lineNumber ?? null,
    locatedAt: device.locatedAt,
    longitude: device.longitude,
    manufacturer: device.manufacturer,
    model: device.model,
    name: device.name,
    osVersion: device.osVersion,
    placeholderName: reservation?.placeholderName ?? null,
    platformLabel: device.platformLabel,
    registerDeviceId: entry?.id ?? null,
    registerStatus: entry?.status ?? null,
    rustDeskId: device.rustDeskId,
    serialNumber: device.serialNumber,
    simNumber: entry?.simNumber ?? null,
    // Unknown custody has nothing to compare, so it warns of nothing; only a tablet that could be added
    // is compared with the tag a press would give it.
    tagWarning: registerError
      ? null
      : headwindTagDrift(device.deviceNumber, entry?.assetTag ?? null, unregistered && told ? nextTag : null),
    unregistered,
  };
}

/**
 * The whole fleet, matched to the register and ordered for the console: unregistered tablets first
 * (they need attention), then by asset tag or name.
 *
 * `_actor` is kept for call-site compatibility only. The fleet read no longer writes to the custody
 * register (owner, 2026-10-22: new tablets enter custody only when a person confirms them), so a read
 * with nobody signed in and a read with the Super Admin signed in now do exactly the same thing.
 */
export async function getHeadwindFleet(
  _actor: string | null = null,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindFleetState> {
  const devices = await listHeadwindDevices(fetchImpl, env);
  let registerError = false;
  const loadRegister = () =>
    getDeviceRegisterData().catch(() => {
      registerError = true;
      return {
        devices: [] as Awaited<ReturnType<typeof getDeviceRegisterData>>["devices"],
        assignable: [] as AssignableEmployee[],
      };
    });

  const register = await loadRegister();

  // The live reservations, so a reserved tablet shows who it is held for and its reconcile/revoke
  // controls target the right assignment. A failure here never blocks the fleet — it just means no
  // reservation detail this read.
  let reservations: ReservationByDevice = new Map();
  if (!registerError) {
    try {
      const reserved = await loadReservedAssignments();
      reservations = new Map(
        reserved.map((r) => [r.deviceId, { assignmentId: r.assignmentId, placeholderName: r.placeholderName }]),
      );
    } catch {
      // Leave reservations empty; the fleet still renders every tablet.
    }
  }

  const nextTag = registerError ? null : headwindNextAssetTag(register.devices);
  const rows = devices.map((device) => headwindFleetRow(device, register.devices, reservations, registerError, nextTag));
  rows.sort((left, right) => {
    if (left.unregistered !== right.unregistered) return left.unregistered ? -1 : 1;
    return (left.assetTag ?? left.name).localeCompare(right.assetTag ?? right.name);
  });

  return {
    assignable: register.assignable ?? [],
    awaitingHardwareReport: registerError ? 0 : headwindTabletsAwaitingHardwareReport(devices, register.devices).length,
    imeisToRecord: registerError ? 0 : headwindImeisToRecord(devices, register.devices).length,
    pendingRegistration: registerError ? 0 : headwindTabletsToRegister(devices, register.devices).length,
    registerError,
    // Read here rather than in the component: whether the relay is set up is a server fact, and the
    // browser must never be told the relay settings themselves to work it out.
    remoteScreenReady: isRustDeskConfigured(env),
    rows,
  };
}
