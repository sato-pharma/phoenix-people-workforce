/**
 * The tablet's RustDesk ID, written into Headwind's first custom device field.
 *
 * 🔴 WHY THIS EXISTS AT ALL: THE CONSOLE CANNOT SHOW THAT FIELD. Phoenix reads `custom1` and displays
 * it as *Remote screen ID* — it is what a screen session is aimed at — but the Community console only
 * draws the custom inputs when `settings.customPropertyName1` is set, and that name is `null` on this
 * server with no screen anywhere that sets it. So the one number the whole remote-screen feature needs
 * had nowhere it could be typed. It is typed here instead, through the bridge that already exists.
 *
 * 🔴 THE WRITE IS READ BACK, BECAUSE THIS SERVER HAS A PUT THAT ANSWERS `OK` AND CHANGES NOTHING.
 * Measured on 2026-09-26: `PUT /rest/private/configurations` with a new `baseUrl` returned
 * `HTTP 200 status=OK` twice and the value came back unchanged both times, because the server
 * recomputes that field on read. A success envelope is therefore not evidence here. This function
 * re-reads the device and refuses to report success unless the value it asked for is the value the
 * server now holds.
 *
 * 🔴 AND IT IS AN OPAQUE ROUND-TRIP, like every other device write in this bridge:
 * `PUT /rest/private/devices` replaces the device's group list wholesale, so a hand-built body drops
 * every group the tablet was in. The server's own record is what goes back, with one field changed.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { deviceWriteBody, searchHeadwindDevices } from "@/lib/devices/headwind/devices";

/**
 * Why a remote screen ID could not be recorded, in a sentence for the person.
 *
 * 🔴 `serverSide` SAYS WHOSE FAULT IT IS, SO THE ROUTE CAN ANSWER HONESTLY (audit, 9 Nov 2026, F15). A
 * mistyped ID or a tablet no longer in the fleet is the person's to fix — 400. A write the Headwind
 * server answered OK and then did not hold is the server's — 502, never "you typed it wrong".
 */
export class HeadwindRemoteScreenIdError extends Error {
  readonly serverSide: boolean;
  constructor(message: string, options: { serverSide?: boolean } = {}) {
    super(message);
    this.name = "HeadwindRemoteScreenIdError";
    this.serverSide = options.serverSide === true;
  }
}

/**
 * What RustDesk itself can show as an ID.
 *
 * Nine or ten digits out of the box, grouped on screen as `123 456 789` — the spaces are RustDesk's
 * own formatting and are not part of the ID, so they are stripped rather than refused. A person who
 * has set a custom ID in the app has letters, digits and underscores, at least six characters. Anything
 * else is a typo, a phone number pasted by mistake, or a whole sentence, and it is refused with the
 * reason rather than stored for a screen session to fail on later.
 */
const REMOTE_SCREEN_ID = /^[A-Za-z0-9_-]{6,32}$/;

/**
 * 🔴 SPACES COME OUT OF RUSTDESK'S OWN GROUPING OF DIGITS, AND NOWHERE ELSE. Stripping whitespace
 * from anything at all turns a sentence typed into the box — "the id is on the tablet" — into
 * `theidisonthetablet`, which reads exactly like a custom ID and would be stored as one. So spaces are
 * removed only when what is left is all digits; anything else keeps its spaces and is refused below.
 * The first draft of this function did strip unconditionally, and the test for the sentence is what
 * caught it.
 */
export function normalizeRemoteScreenId(raw: string): string {
  const trimmed = raw.trim();
  const squeezed = trimmed.replace(/\s+/g, "");
  return /^[0-9]+$/.test(squeezed) ? squeezed : trimmed;
}

type DeviceRecord = Record<string, unknown>;

async function findDevice(deviceNumber: string, fetchImpl: typeof fetch, env: NodeJS.ProcessEnv): Promise<DeviceRecord> {
  const { records } = await searchHeadwindDevices(deviceNumber, fetchImpl, env);
  const device = records.find((entry) => entry.number === deviceNumber);
  if (!device) {
    throw new HeadwindRemoteScreenIdError(
      "That tablet is not in the Headwind fleet any more. Reload the page and try again from its row.",
    );
  }
  return device;
}

/**
 * Record — or clear — the RustDesk ID of one tablet.
 *
 * An empty value clears it, which is what happens when a tablet is re-enrolled and RustDesk gives it a
 * new ID: the old one would otherwise sit there aiming sessions at a device that no longer answers.
 */
export async function setHeadwindRemoteScreenId(
  input: { deviceNumber: string; remoteScreenId: string },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ message: string; remoteScreenId: string | null }> {
  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindRemoteScreenIdError("Say which tablet this ID belongs to.");

  const wanted = normalizeRemoteScreenId(input.remoteScreenId ?? "");
  if (wanted && !REMOTE_SCREEN_ID.test(wanted)) {
    throw new HeadwindRemoteScreenIdError(
      "That is not a RustDesk ID. Open RustDesk on the tablet and copy the number it shows at the top — nine or ten digits, or the custom ID if one was set.",
    );
  }

  const device = await findDevice(deviceNumber, fetchImpl, env);
  const previous = typeof device.custom1 === "string" && device.custom1.trim() ? device.custom1.trim() : null;
  const next = wanted || null;
  if (previous === next) {
    return {
      message: next
        ? `${deviceNumber} already carries remote screen ID ${next}.`
        : `${deviceNumber} already has no remote screen ID.`,
      remoteScreenId: next,
    };
  }

  await callHeadwind(
    "/rest/private/devices",
    { body: JSON.stringify(deviceWriteBody(device, { custom1: next })), method: "PUT" },
    fetchImpl,
    env,
  );

  // 🔴 THE `OK` IS NOT THE PROOF — THE VALUE IS. See the note at the top of this file.
  const written = await findDevice(deviceNumber, fetchImpl, env);
  const stored = typeof written.custom1 === "string" && written.custom1.trim() ? written.custom1.trim() : null;
  if (stored !== next) {
    throw new HeadwindRemoteScreenIdError(
      `The Headwind server accepted the change and then still reports ${
        stored ? `remote screen ID ${stored}` : "no remote screen ID"
      } for ${deviceNumber}. Nothing has been recorded — set it in the Headwind console instead, and say so, because a write that reports success and changes nothing has been seen on this server before.`,
      { serverSide: true },
    );
  }

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: deviceNumber,
    entityType: "headwind_device_command",
    newValues: { change: "remote-screen-id", deviceNumber, remoteScreenId: next },
    oldValues: { remoteScreenId: previous },
    summary: next
      ? `Recorded remote screen ID ${next} for ${deviceNumber}`
      : `Cleared the remote screen ID of ${deviceNumber}`,
  });

  return {
    message: next
      ? `${deviceNumber} is now reachable on the screen as ${next}.`
      : `The remote screen ID of ${deviceNumber} has been cleared, so no session can be aimed at it until a new one is recorded.`,
    remoteScreenId: next,
  };
}
