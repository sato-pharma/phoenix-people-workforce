/**
 * Remote actions on one tablet, issued through the company's own Headwind MDM server.
 *
 * WHY A COMMAND IS ITS OWN CONCERN. Listing the fleet is a read; this reaches a real tablet in a
 * rep's hands. So every action resolves the device against the live fleet first (a command cannot be
 * aimed at a tablet that is gone, and the audit names the real one by its custody asset tag), issues
 * the single documented POST, then writes a REQUIRED audit row. The route above it is Super Admin
 * only and same-origin; nothing here trusts the browser for more than the device number and the
 * action name, both checked against this module's own list.
 *
 * 🔴 EVERY ACTION IS ONE ENDPOINT: `POST /rest/private/push`. Headwind does not have per-action paths
 * the way ManageEngine has `/actions/{action}`; it has a single push channel carrying a
 * `messageType`, a `payload` — 🔴 A STRING CONTAINING JSON, NOT A JSON OBJECT, which is Headwind's
 * documented wire format and not a mistake to "fix" — and the device numbers to send it to.
 *
 * 🔴 AND THIS IS THE ONE HONEST GAP IN THE BRIDGE. Headwind publishes exactly TWO message types:
 * `configUpdated` (re-read your settings now) and `runApp` (start this app). Everything else its web
 * panel can do — reboot, lock, factory reset, kiosk on and off, a live position ping — is real and
 * present in the Community edition, but the WORD to send down this channel for each is not in any
 * public document. Guessing one would produce a button that reports success and does nothing, which
 * is the worst possible outcome on a custody console.
 *
 * SO AN UNCONFIRMED ACTION IS LISTED, NOT HIDDEN, AND REFUSES RATHER THAN PRETENDS. Its wire name
 * lives as `null` in `HEADWIND_MESSAGE_TYPES` below — the single map that is the whole surface of
 * this unknown — the console shows it greyed with the reason in plain words, and the route answers
 * 501. When the server is up, its own Swagger UI (`/swagger/ui/index.html`) names them; filling a
 * line in that map is then the entire fix, with no other file touched.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { listHeadwindDevices, matchHeadwindToRegister } from "@/lib/devices/headwind/devices";
import { getDeviceRegisterData } from "@/lib/devices/service";
import { rustDeskPackageName } from "@/lib/devices/rustdesk/config";

export class HeadwindCommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindCommandInputError";
  }
}

/** Phoenix does not yet know the word this server wants for that action. Never a tablet's failure. */
export class HeadwindCommandUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindCommandUnconfirmedError";
  }
}

export type HeadwindCommandId =
  | "APPLY_SETTINGS"
  | "WAKE_REMOTE_APP"
  | "REBOOT"
  | "LOCK"
  | "LOCATE_NOW"
  | "PAUSE_KIOSK"
  | "RESUME_KIOSK"
  | "FACTORY_RESET";

/**
 * 🔴 THE ONE PLACE THE UNKNOWN LIVES — the `messageType` each action sends down `/rest/private/push`.
 *
 * A string is a name confirmed against Headwind's published push documentation. A `null` is an action
 * whose name is NOT published and has not been read off this server's own Swagger yet: it is offered
 * to nobody, refused with a plain sentence, and fixed by writing the name on its line here. Nothing
 * else in the codebase needs to change when one is confirmed — that is why this map is isolated.
 */
export const HEADWIND_MESSAGE_TYPES: Readonly<Record<HeadwindCommandId, string | null>> = {
  // Documented: "When the admin updates the configuration in the web panel, a message of type
  // configUpdated (no payload) is sent to each device having that configuration."
  APPLY_SETTINGS: "configUpdated",
  // Documented: "When the plugin needs to start a mobile agent remotely, a message of type runApp is
  // sent to a device", with a payload naming the package.
  WAKE_REMOTE_APP: "runApp",
  FACTORY_RESET: null,
  LOCATE_NOW: null,
  LOCK: null,
  PAUSE_KIOSK: null,
  REBOOT: null,
  RESUME_KIOSK: null,
};

export type HeadwindCommandDef = {
  id: HeadwindCommandId;
  label: string;
  description: string;
  /** Past tense for the confirmation and the audit summary. */
  pastTense: string;
  /** Erases the tablet — the UI double-confirms and the button is styled as danger. */
  destructive: boolean;
};

export const HEADWIND_COMMANDS: readonly HeadwindCommandDef[] = [
  {
    description:
      "Tells the tablet to re-read its rules from the company server now — its apps, its kiosk and its settings refresh instead of waiting for the next check-in.",
    destructive: false,
    id: "APPLY_SETTINGS",
    label: "Apply settings now",
    pastTense: "Applied settings on",
  },
  {
    description:
      "Starts the remote-control app on the tablet so a screen session can connect, for a tablet that has been idle. Nothing is shown to the rep.",
    destructive: false,
    id: "WAKE_REMOTE_APP",
    label: "Wake the remote app",
    pastTense: "Woke the remote app on",
  },
  {
    description: "Restarts the tablet now. Anything unsaved on it is lost, as with any restart.",
    destructive: false,
    id: "REBOOT",
    label: "Restart",
    pastTense: "Restarted",
  },
  {
    description: "Locks the screen now. The rep unlocks it with their PIN, pattern or password.",
    destructive: false,
    id: "LOCK",
    label: "Lock now",
    pastTense: "Locked",
  },
  {
    description: "Asks the tablet to report where it is now, instead of showing the position from its last check-in.",
    destructive: false,
    id: "LOCATE_NOW",
    label: "Locate now",
    pastTense: "Asked for the position of",
  },
  {
    description: "Lifts kiosk mode for a while, so the whole tablet can be reached — for a repair or a settings change.",
    destructive: false,
    id: "PAUSE_KIOSK",
    label: "Pause kiosk mode",
    pastTense: "Paused kiosk mode on",
  },
  {
    description: "Puts the tablet back into kiosk mode, pinned to the company's apps again.",
    destructive: false,
    id: "RESUME_KIOSK",
    label: "Resume kiosk mode",
    pastTense: "Resumed kiosk mode on",
  },
  {
    description:
      "Factory-resets the tablet — everything on it is erased and it comes back at the welcome screen, ready to be enrolled again. Use it for a stolen tablet, or one being retired and started clean.",
    destructive: true,
    id: "FACTORY_RESET",
    label: "Full factory reset",
    pastTense: "Factory-reset",
  },
] as const;

const COMMANDS_BY_ID = new Map<HeadwindCommandId, HeadwindCommandDef>(
  HEADWIND_COMMANDS.map((entry) => [entry.id, entry]),
);

export function isHeadwindCommandId(value: unknown): value is HeadwindCommandId {
  return typeof value === "string" && COMMANDS_BY_ID.has(value as HeadwindCommandId);
}

/** True when this server has a confirmed word for the action — what the console greys a button on. */
export function isHeadwindCommandReady(id: HeadwindCommandId): boolean {
  return HEADWIND_MESSAGE_TYPES[id] !== null;
}

/** The catalogue as the console renders it: every action, each saying whether it can be sent yet. */
export function headwindCommandCatalogue(): Array<HeadwindCommandDef & { ready: boolean }> {
  return HEADWIND_COMMANDS.map((def) => ({ ...def, ready: isHeadwindCommandReady(def.id) }));
}

export type HeadwindCommandResult = {
  command: HeadwindCommandId;
  assetTag: string | null;
  message: string;
};

function resultMessage(def: HeadwindCommandDef, subject: string): string {
  switch (def.id) {
    case "APPLY_SETTINGS":
      return `${subject} has been told to re-read its settings. They apply as soon as it answers.`;
    case "WAKE_REMOTE_APP":
      return `The remote app is starting on ${subject}. Give it a moment, then open the screen session.`;
    case "REBOOT":
      return `${subject} is restarting now.`;
    case "LOCK":
      return `${subject} is locked. The rep unlocks it with their screen lock.`;
    case "LOCATE_NOW":
      return `${subject} has been asked where it is. Its position refreshes as soon as it answers.`;
    case "PAUSE_KIOSK":
      return `${subject} is out of kiosk mode. The whole tablet can be reached until kiosk mode is resumed.`;
    case "RESUME_KIOSK":
      return `${subject} is back in kiosk mode, pinned to the company's apps.`;
    case "FACTORY_RESET":
      return `${subject} is being factory-reset. It comes back at the welcome screen and needs to be enrolled again.`;
    default:
      return `${subject}: done.`;
  }
}

/**
 * The payload for an action, as the STRING containing JSON that Headwind's push endpoint expects.
 *
 * `configUpdated` documents no payload at all, so it sends an empty string rather than `"{}"` —
 * sending a body a message type does not define is how a working action starts being ignored after a
 * server upgrade.
 */
function payloadFor(id: HeadwindCommandId, env: NodeJS.ProcessEnv): string {
  if (id === "WAKE_REMOTE_APP") return JSON.stringify({ pkg: rustDeskPackageName(env) });
  return "";
}

/**
 * Run one remote action against one Headwind-managed tablet.
 *
 * Resolves the device from the live fleet (so the action cannot hit one that is gone and the audit
 * names the real tablet), pushes the documented message, then writes the required audit row.
 *
 * 🔴 THE PUSH IS ADDRESSED BY DEVICE NUMBER, NEVER BY THE SERVER'S ROW ID. `deviceNumbers` is a list
 * and the endpoint answers 200 whether or not anything in it matched, so an id sent here would report
 * a success that reached no tablet at all.
 */
export async function issueHeadwindCommand(
  input: { deviceNumber: string; command: HeadwindCommandId },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindCommandResult> {
  const def = COMMANDS_BY_ID.get(input.command);
  if (!def) throw new HeadwindCommandInputError(`Unknown action '${String(input.command)}'.`);

  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindCommandInputError("Say which tablet to act on.");

  const messageType = HEADWIND_MESSAGE_TYPES[def.id];
  if (messageType === null) {
    throw new HeadwindCommandUnconfirmedError(
      `"${def.label}" is not connected yet. The company's Headwind server can do it, but the exact name ` +
        "Phoenix must send for it is not published — it is read once off the server's own API list and " +
        "written into HEADWIND_MESSAGE_TYPES. Until then this button is deliberately refused rather than " +
        "reporting a success that never reached the tablet.",
    );
  }

  const [devices, register] = await Promise.all([
    listHeadwindDevices(fetchImpl, env),
    getDeviceRegisterData().catch(() => ({ devices: [] as Awaited<ReturnType<typeof getDeviceRegisterData>>["devices"] })),
  ]);
  const device = devices.find((candidate) => candidate.deviceNumber === deviceNumber);
  if (!device) {
    throw new HeadwindCommandInputError(
      "That tablet is not in the Headwind fleet any more. Reload the page and try again from its row.",
    );
  }
  const assetTag = matchHeadwindToRegister(device, register.devices)?.assetTag ?? null;
  const subject = assetTag ?? device.name;

  await callHeadwind(
    "/rest/private/push",
    {
      body: JSON.stringify({
        broadcast: false,
        deviceNumbers: [device.deviceNumber],
        messageType,
        payload: payloadFor(def.id, env),
      }),
      method: "POST",
    },
    fetchImpl,
    env,
  );

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: device.deviceNumber,
    entityType: "headwind_device_command",
    newValues: { assetTag, command: def.id, deviceName: device.name, messageType },
    oldValues: null,
    summary: `${def.pastTense} ${assetTag ?? device.name}`,
  });

  return { assetTag, command: def.id, message: resultMessage(def, subject) };
}
