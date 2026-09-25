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
 * 🔴 THE WIRE NAMES ARE READ OFF HEADWIND'S OWN SOURCE, NOT OFF ITS WEBSITE. Headwind's *documentation*
 * names exactly two message types — `configUpdated` and `runApp` — which is why an earlier pass here
 * left six actions sitting `null` "until the live server's Swagger page can be read". That was the
 * wrong place to look: Headwind is open source, and the Android agent that receives these messages
 * declares every name it accepts as a literal string, in public, today. Three of those six were
 * resolved from it with no server involved at all.
 *
 * 🔴 NEVER PARK AN UNKNOWN ON A BOX THAT HAS NOT BEEN BUILT WHEN THE CODE THAT ANSWERS IT IS PUBLIC.
 * That is the rule this file exists to carry.
 *
 * AN ACTION THAT STILL CANNOT BE SENT IS LISTED, NOT HIDDEN, AND REFUSES RATHER THAN PRETENDS. Its
 * wire name is `null` in `HEADWIND_MESSAGE_TYPES` below, `HEADWIND_UNCONFIRMED_REASONS` says WHY in
 * one sentence a non-engineer can act on, the console greys the button and shows that sentence, and
 * the route answers 501. The reasons differ and the console must not flatten them: lock and factory
 * reset need a server-side field the Community edition does not have, while a live position only
 * needs one round trip watched on a real tablet.
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
 * The `messageType` each action sends down `/rest/private/push`.
 *
 * 🔴 THESE ARE READ OFF HEADWIND'S OWN SOURCE, NOT GUESSED, AND NOT WAITED FOR. Headwind's *website*
 * documents only two push types, which is why an earlier pass here left six of these `null` "until
 * the live server's Swagger could be read". That was the wrong place to look: **Headwind is open
 * source**, and the agent that receives these messages declares every name it accepts, as literal
 * strings, in public. The authority is the agent, because the agent is what obeys:
 *
 *   github.com/h-mdm/hmdm-android
 *     app/src/main/java/com/hmdm/launcher/json/PushMessage.java          — the literal wire strings
 *     app/src/main/java/com/hmdm/launcher/worker/PushNotificationProcessor.java — what each one does
 *
 * The full set the agent accepts is: configUpdating, configUpdated, runApp, broadcast, uninstallApp,
 * deleteFile, purgeDir, deleteDir, permissiveMode, runCommand, reboot, exitKiosk, clearDownloadHistory,
 * intent, grantPermissions, adminPanel, clearAppData. Anything not in that list is not a push message
 * on this server, whatever a panel button looks like.
 *
 * A `null` still means "Phoenix will not send this": the action is listed, greyed, and refuses with a
 * plain sentence rather than reporting a success that reached no tablet. What is now different is that
 * a `null` here is a statement about the SERVER, not about our reading — see `LOCK` and `FACTORY_RESET`.
 */
export const HEADWIND_MESSAGE_TYPES: Readonly<Record<HeadwindCommandId, string | null>> = {
  // `PushMessage.TYPE_CONFIG_UPDATED`. The agent re-reads its whole configuration, which is also how
  // every setting-driven change lands — so this is the "do it now" nudge behind several actions.
  APPLY_SETTINGS: "configUpdated",
  // `PushMessage.TYPE_RUN_APP` → `runApplication(context, payload)`, payload naming the package.
  WAKE_REMOTE_APP: "runApp",
  // `PushMessage.TYPE_REBOOT` → `Utils.reboot()` → `dpm.reboot(adminComponentName)`. No payload.
  REBOOT: "reboot",
  // `PushMessage.TYPE_EXIT_KIOSK` → broadcasts `ACTION_EXIT_KIOSK`. No payload.
  PAUSE_KIOSK: "exitKiosk",
  // There is no `enterKiosk`: `exitKiosk` is a TEMPORARY exit, and kiosk mode is restored when the
  // agent next reads its configuration. So resuming is the config update — the same message, a
  // different sentence to the person pressing it.
  RESUME_KIOSK: "configUpdated",
  // 🔴 NOT A PUSH MESSAGE ON THIS SERVER, AND NOT AN UNKNOWN EITHER. The agent does carry `lock`,
  // `lockMessage` and `factoryReset` — but as fields of the configuration it DOWNLOADS
  // (`ServerConfig.java`), not as messages it can be sent. And the Community server's own
  // `Configuration` and `Device` records (hmdm-server, `common/.../persistence/domain/`) have no
  // column for either, so there is no REST call in this edition that sets them. Writing a name here
  // would not make these work; they need a server-side field that does not exist. Left refusing, and
  // §6 of the runbook says so in words.
  FACTORY_RESET: null,
  LOCK: null,
  // Location rides along in the device's own report rather than answering a message of its own. Left
  // refusing until the round trip is watched on a real tablet — a position is evidence about where a
  // person was, and a stale one presented as "now" is worse than no button.
  LOCATE_NOW: null,
};

/**
 * Why an action still refuses, in one sentence the person pressing it can act on.
 *
 * 🔴 THE TWO REASONS ARE NOT THE SAME AND THE CONSOLE MUST NOT FLATTEN THEM INTO "PENDING". One says
 * the Community server has nowhere to put the instruction — waiting will not change it, and the
 * answer is a paid edition or a different mechanism. The other says Phoenix will not show a position
 * it has not yet watched arrive. A person deciding what to do about a stolen tablet needs to know
 * which of those they are looking at.
 */
export const HEADWIND_UNCONFIRMED_REASONS: Readonly<Partial<Record<HeadwindCommandId, string>>> = {
  FACTORY_RESET:
    "The company's server cannot send this. On the Headwind agent a factory reset is a setting the " +
    "tablet reads out of its configuration, not an instruction that can be sent to it — and the free " +
    "edition's configuration has no such setting to switch on. A tablet is wiped by hand from the " +
    "server's own console, or on the tablet itself.",
  LOCATE_NOW:
    "The tablet reports where it is with its regular check-in rather than answering a question. " +
    "Phoenix shows the position from that last check-in, and will not put a “now” button on the " +
    "screen until the round trip has been watched on a real tablet — a stale position shown as a live " +
    "one is worse than none.",
  LOCK:
    "The company's server cannot send this. On the Headwind agent the lock is a setting the tablet " +
    "reads out of its configuration, not an instruction that can be sent to it — and the free " +
    "edition's configuration has no such setting to switch on.",
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

/** Why this action refuses, or null when it can be sent. Never a bare "pending" — see the map above. */
export function headwindPendingReason(id: HeadwindCommandId): string | null {
  if (isHeadwindCommandReady(id)) return null;
  return (
    HEADWIND_UNCONFIRMED_REASONS[id] ??
    "Phoenix will not send this action to the company's server yet, so the button is refused rather " +
      "than reporting a success that reached no tablet."
  );
}

/**
 * The catalogue as the console renders it: every action, each saying whether it can be sent yet and,
 * when it cannot, why — so a greyed button explains itself instead of reading as "not built".
 */
export function headwindCommandCatalogue(): Array<
  HeadwindCommandDef & { ready: boolean; pendingReason: string | null }
> {
  return HEADWIND_COMMANDS.map((def) => ({
    ...def,
    pendingReason: headwindPendingReason(def.id),
    ready: isHeadwindCommandReady(def.id),
  }));
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

export type HeadwindActionTarget = {
  deviceNumber: string;
  deviceName: string;
  /** The custody asset tag where the tablet is in the register — what a person is shown and audited. */
  assetTag: string | null;
  /** The asset tag, falling back to the server's name for the tablet. Never blank. */
  subject: string;
};

/**
 * Resolve the tablet an action is about to reach, against the LIVE fleet.
 *
 * 🔴 EVERY ACTION GOES THROUGH HERE, AND THERE IS EXACTLY ONE COPY OF IT ON PURPOSE. Two things it
 * guarantees are easy to lose in a second copy: an action cannot be aimed at a tablet that has left
 * the fleet, and the audit row names the tablet by the asset tag a person would recognise rather than
 * by a server row number.
 *
 * 🔴 AND THE PUSH IS ADDRESSED BY DEVICE NUMBER, NEVER BY THE SERVER'S ROW ID. `deviceNumbers` is a
 * list and `/rest/private/push` answers 200 whether or not anything in it matched, so an id sent
 * there would report a success that reached no tablet at all.
 */
export async function resolveHeadwindActionTarget(
  deviceNumber: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindActionTarget> {
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
  return { assetTag, deviceName: device.name, deviceNumber: device.deviceNumber, subject: assetTag ?? device.name };
}

/**
 * Run one remote action against one Headwind-managed tablet.
 *
 * Resolves the device from the live fleet, pushes the message, then writes the required audit row.
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
    throw new HeadwindCommandUnconfirmedError(`"${def.label}" is refused. ${headwindPendingReason(def.id)}`);
  }

  const target = await resolveHeadwindActionTarget(deviceNumber, fetchImpl, env);

  await callHeadwind(
    "/rest/private/push",
    {
      body: JSON.stringify({
        broadcast: false,
        deviceNumbers: [target.deviceNumber],
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
    entityId: target.deviceNumber,
    entityType: "headwind_device_command",
    newValues: { assetTag: target.assetTag, command: def.id, deviceName: target.deviceName, messageType },
    oldValues: null,
    summary: `${def.pastTense} ${target.subject}`,
  });

  return { assetTag: target.assetTag, command: def.id, message: resultMessage(def, target.subject) };
}
