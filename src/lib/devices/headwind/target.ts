/**
 * Which tablet an action is about to reach.
 *
 * 🔴 EVERY ACTION GOES THROUGH HERE, AND THERE IS EXACTLY ONE COPY OF IT ON PURPOSE. Two things it
 * guarantees are easy to lose in a second copy: an action cannot be aimed at a tablet that has left
 * the fleet, and the audit row names the tablet by the asset tag a person would recognise rather than
 * by a server row number.
 *
 * 🔴 AND THE PUSH IS ADDRESSED BY DEVICE NUMBER, NEVER BY THE SERVER'S ROW ID. `deviceNumbers` is a
 * list and `/rest/private/push` answers 200 whether or not anything in it matched, so an id sent there
 * would report a success that reached no tablet at all.
 *
 * WHY IT IS ITS OWN FILE. It began inside `commands.ts`, and it is used by every module that reaches a
 * tablet — the wipe, the locate, the custody actions. When `commands.ts` started delegating three of
 * its own buttons to `actions.ts`, keeping the resolver there would have made the two files import
 * each other. This is the shared floor both stand on, and it imports neither.
 */

import { listHeadwindDevices, matchHeadwindToRegister } from "@/lib/devices/headwind/devices";
import { getDeviceRegisterData } from "@/lib/devices/service";

/** What was asked for cannot be done as asked — the person's own input, not the tablet's failure. */
export class HeadwindCommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindCommandInputError";
  }
}

export type HeadwindActionTarget = {
  deviceNumber: string;
  deviceName: string;
  /** The custody asset tag where the tablet is in the register — what a person is shown and audited. */
  assetTag: string | null;
  /** The asset tag, falling back to the server's name for the tablet. Never blank. */
  subject: string;
};

export async function resolveHeadwindActionTarget(
  deviceNumber: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindActionTarget> {
  const [devices, register] = await Promise.all([
    listHeadwindDevices(fetchImpl, env),
    getDeviceRegisterData().catch(() => ({
      devices: [] as Awaited<ReturnType<typeof getDeviceRegisterData>>["devices"],
    })),
  ]);
  const device = devices.find((candidate) => candidate.deviceNumber === deviceNumber);
  if (!device) {
    throw new HeadwindCommandInputError(
      "That tablet is not in the Headwind fleet any more. Reload the page and try again from its row.",
    );
  }
  const assetTag = matchHeadwindToRegister(device, register.devices)?.assetTag ?? null;
  return {
    assetTag,
    deviceName: device.name,
    deviceNumber: device.deviceNumber,
    subject: assetTag ?? device.name,
  };
}
