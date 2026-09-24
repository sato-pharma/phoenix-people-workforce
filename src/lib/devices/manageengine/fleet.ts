/**
 * The ManageEngine fleet as the Phoenix console shows it — each managed tablet joined to its custody
 * register entry, so one screen answers both "what is this tablet doing" and "who is holding it".
 *
 * A row carries the ManageEngine `deviceId` (what a remote command is aimed at) and, where the
 * register knows the tablet, its asset tag and holder. A tablet ManageEngine manages but the register
 * has never seen still shows — flagged as not in the register — because an unknown managed tablet is
 * exactly the thing a custody console should surface, not hide.
 */

import {
  listManageEngineDevices,
  matchManageEngineToRegister,
  type ManageEngineDevice,
} from "@/lib/devices/manageengine/devices";
import { getDeviceRegisterData } from "@/lib/devices/service";

export type RepManageEngineRow = {
  /** The id a remote command targets. A React key too. */
  deviceId: string;
  name: string;
  model: string | null;
  serialNumber: string | null;
  imei: string | null;
  platformLabel: string;
  isAndroid: boolean;
  osVersion: string | null;
  enrollmentStatus: string | null;
  lostMode: boolean;
  lastContactAt: string | null;
  /** From the custody register, when the tablet is matched. */
  assetTag: string | null;
  holderName: string | null;
  holderJobTitle: string | null;
  /** The register does not know this managed tablet. */
  unregistered: boolean;
};

export type ManageEngineFleetState = {
  rows: RepManageEngineRow[];
  /** The custody register could not be read, so holders are unknown but the fleet still shows. */
  registerError: boolean;
};

function toRow(device: ManageEngineDevice, register: Parameters<typeof matchManageEngineToRegister>[1]): RepManageEngineRow {
  const entry = matchManageEngineToRegister(device, register);
  return {
    assetTag: entry?.assetTag ?? null,
    deviceId: device.deviceId,
    enrollmentStatus: device.enrollmentStatus,
    holderJobTitle: entry?.holderJobTitle ?? null,
    holderName: entry?.holderName ?? null,
    imei: device.imei,
    isAndroid: device.isAndroid,
    lastContactAt: device.lastContactAt,
    lostMode: device.lostMode,
    model: device.model,
    name: device.name,
    osVersion: device.osVersion,
    platformLabel: device.platformLabel,
    serialNumber: device.serialNumber,
    unregistered: entry === null,
  };
}

/**
 * The whole fleet, matched to the register and ordered for the console: a tablet in lost mode first,
 * then unregistered tablets (they need attention), then by asset tag or name.
 */
export async function getManageEngineFleet(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineFleetState> {
  const devices = await listManageEngineDevices(fetchImpl, env);
  let registerError = false;
  const register = await getDeviceRegisterData().catch(() => {
    registerError = true;
    return { devices: [] as Awaited<ReturnType<typeof getDeviceRegisterData>>["devices"] };
  });

  const rows = devices.map((device) => toRow(device, register.devices));
  rows.sort((left, right) => {
    if (left.lostMode !== right.lostMode) return left.lostMode ? -1 : 1;
    if (left.unregistered !== right.unregistered) return left.unregistered ? -1 : 1;
    return (left.assetTag ?? left.name).localeCompare(right.assetTag ?? right.name);
  });

  return { registerError, rows };
}
