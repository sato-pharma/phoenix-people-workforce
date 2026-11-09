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
 * ── 🔴 A CORRECTION, 2026-09-25: THREE OF THESE BUTTONS WERE REFUSED FOR A REASON THAT WAS WRONG ───
 *
 * This comment used to say that lock and factory reset "need a server-side field the Community edition
 * does not have", and that a live position needed a round trip nobody had watched. The first half was
 * wrong about WHERE the gap is, and the console repeated it to the owner as a settled limit.
 *
 * The free AGENT implements all of it, and always has (`hmdm-android` 6.39, `c9221a1f`): `lock` and
 * `lockMessage` drive `MainActivity.showLockScreen()`, `factoryReset` reaches `dpm.wipeData(0)`,
 * `passwordReset` reaches `dpm.resetPasswordWithToken`. What is missing is at the other end — the
 * open-source SERVER's `Configuration` and `SyncResponse` carry none of those fields, so there is
 * nowhere to write the instruction the tablet is already listening for. That is a server gap, not a
 * tablet one, and a server we own can be extended: `com.hmdm.rest.json.SyncResponseHook` is a public
 * Apache-2.0 interface for exactly this, and the Phoenix add-on in `infra/headwind-phoenix-actions/`
 * implements it. **No tablet changes.**
 *
 * So `LOCK` and `FACTORY_RESET` are no longer refused here — they DELEGATE to
 * `src/lib/devices/headwind/actions.ts`, which asks the add-on and refuses in words if this particular
 * box has not been rebuilt with it. `LOCATE_NOW` delegates to `locations.ts`, which wakes the tablet
 * and returns the position WITH ITS AGE, which is what the old refusal was really protecting: not
 * showing a stale fix as a live one. Their `messageType` stays `null` because they genuinely are not
 * push messages — the null now means "carried another way", and `isHeadwindCommandReady` says so.
 *
 * AN ACTION THAT STILL CANNOT BE SENT IS LISTED, NOT HIDDEN, AND REFUSES RATHER THAN PRETENDS.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { takeHeadwindAction } from "@/lib/devices/headwind/actions";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { locateHeadwindDevice } from "@/lib/devices/headwind/locations";
import { HeadwindCommandInputError, resolveHeadwindActionTarget } from "@/lib/devices/headwind/target";
import { rustDeskPackageName } from "@/lib/devices/rustdesk/config";

export { HeadwindCommandInputError, resolveHeadwindActionTarget };
export type { HeadwindActionTarget } from "@/lib/devices/headwind/target";

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
  // 🔴 NOT PUSH MESSAGES — CARRIED ANOTHER WAY, WHICH IS NOT THE SAME AS REFUSED. The agent does carry
  // `lock`, `lockMessage` and `factoryReset`, but as fields of the configuration it DOWNLOADS
  // (`ServerConfig.java`), never as messages it can be sent. The open-source server has no column for
  // them — so the Phoenix add-on injects them into the sync response instead
  // (`infra/headwind-phoenix-actions/`, through Headwind's own `SyncResponseHook`). These two delegate
  // to `actions.ts`, which asks the add-on and refuses in plain words if this box has not got it yet.
  FACTORY_RESET: null,
  LOCK: null,
  // Location rides along in the device's own report rather than answering a message of its own, so
  // there is nothing to push. It delegates to `locations.ts`, which wakes the tablet with
  // `configUpdated` and returns the position WITH ITS AGE — which is what the old refusal was really
  // protecting. A stale fix presented as "now" is worse than no button; a stale fix presented as four
  // days old is useful.
  LOCATE_NOW: null,
};

/**
 * Why an action refuses, in one sentence the person pressing it can act on.
 *
 * 🔴 EMPTY SINCE 2026-09-25, AND THAT IS THE RESULT, NOT AN OVERSIGHT. All three entries that used to
 * live here said the free edition could not do something the free AGENT had been doing all along — the
 * gap was in the server, and the server is ours. The button that was labelled impossible now works; the
 * only thing that can still stop it is the add-on not being installed on a particular box, and that
 * refusal is written where it is decided (`actions.ts`), against the live box, rather than hard-coded
 * as a fact about the product.
 *
 * The map itself stays, because the next action Phoenix cannot send should be listed and explained
 * rather than hidden — and because a `null` wire name with no sentence beside it is exactly the
 * unexplained grey button this whole design exists to avoid.
 */
export const HEADWIND_UNCONFIRMED_REASONS: Readonly<Partial<Record<HeadwindCommandId, string>>> = {};

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
    pastTense: "Sent apply-settings to",
  },
  {
    description:
      "Starts the remote-control app on the tablet so a screen session can connect, for a tablet that has been idle. Nothing is shown to the rep.",
    destructive: false,
    id: "WAKE_REMOTE_APP",
    label: "Wake the remote app",
    pastTense: "Sent the remote-app wake to",
  },
  {
    description: "Restarts the tablet now. Anything unsaved on it is lost, as with any restart.",
    destructive: false,
    id: "REBOOT",
    label: "Restart",
    pastTense: "Sent a restart to",
  },
  {
    // 🔴 NOT THE ANDROID SCREEN LOCK. This is the agent's own full-screen overlay: the rep's own PIN
    // does not clear it, and it is taken off from here. Describing it as "locks the screen" is how
    // somebody locks a working tablet expecting the rep to carry on after unlocking it.
    description:
      "Puts a full-screen lock over the tablet. Nothing on it can be used until it is unlocked from here — the rep's own PIN will not clear it.",
    destructive: false,
    id: "LOCK",
    label: "Lock the tablet",
    pastTense: "Locked",
  },
  {
    description: "Wakes the tablet and reads back where it says it is, with how old that position is.",
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
    pastTense: "Sent a kiosk-mode pause to",
  },
  {
    description: "Puts the tablet back into kiosk mode, pinned to the company's apps again.",
    destructive: false,
    id: "RESUME_KIOSK",
    label: "Resume kiosk mode",
    pastTense: "Sent a kiosk-mode resume to",
  },
  {
    description:
      "Factory-resets the tablet — everything on it is erased and it comes back at the welcome screen, ready to be enrolled again. Use it for a stolen tablet, or one being retired and started clean.",
    destructive: true,
    id: "FACTORY_RESET",
    label: "Factory reset",
    pastTense: "Factory-reset",
  },
] as const;

const COMMANDS_BY_ID = new Map<HeadwindCommandId, HeadwindCommandDef>(
  HEADWIND_COMMANDS.map((entry) => [entry.id, entry]),
);

/**
 * Which module carries an action that is not a push message.
 *
 * 🔴 THE POINT OF THIS MAP IS THAT THE OLD BUTTONS KEEP WORKING. `LOCK`, `FACTORY_RESET` and
 * `LOCATE_NOW` are on the tablet panel already; moving them to their own routes and leaving these
 * three refusing would have been a correction that broke the console. They delegate instead, so the
 * fix reaches the buttons that exist rather than only the ones added beside them.
 */
const DELEGATED: Readonly<Partial<Record<HeadwindCommandId, "action" | "locate">>> = {
  FACTORY_RESET: "action",
  LOCATE_NOW: "locate",
  LOCK: "action",
};

export function isHeadwindCommandId(value: unknown): value is HeadwindCommandId {
  return typeof value === "string" && COMMANDS_BY_ID.has(value as HeadwindCommandId);
}

/**
 * True when Phoenix can actually carry the action — what the console greys a button on.
 *
 * 🔴 IT IS NO LONGER "HAS A PUSH MESSAGE". Three actions are carried by another module rather than by
 * the push channel, and reading a `null` wire name as "not ready" would grey three buttons that work.
 */
export function isHeadwindCommandReady(id: HeadwindCommandId): boolean {
  return HEADWIND_MESSAGE_TYPES[id] !== null || DELEGATED[id] !== undefined;
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
  /**
   * "Locate now" only — the position it read back, so the console can show it at once. 🔴 These were
   * dropped here, so the fleet row kept showing the OLD position after a successful locate.
   */
  latitude?: number | null;
  longitude?: number | null;
  locatedAt?: string | null;
};

/**
 * The sentence shown after a push action is SENT.
 *
 * 🔴 IT SAYS WHAT WAS SENT, NEVER WHAT THE TABLET DID. `/rest/private/push` answers once the server has
 * queued the message; the tablet acts on it only when it receives it, which for a tablet asleep in a
 * bag is later, and for one that is off is never. "is restarting now" and "is back in kiosk mode,
 * pinned" claimed effects nobody had seen, so a press on a dead tablet read as a success. Only the push
 * actions reach here — lock, locate and factory reset are answered by the module that carries them.
 */
export function headwindCommandSentMessage(id: HeadwindCommandId, subject: string): string {
  switch (id) {
    case "APPLY_SETTINGS":
      return `${subject} was told to re-read its settings. They apply when it receives the message.`;
    case "WAKE_REMOTE_APP":
      return `${subject} was told to start the remote app. It starts when the tablet receives the message; give it a moment, then open the screen session.`;
    case "REBOOT":
      return `${subject} was told to restart. It restarts when it receives the message.`;
    case "PAUSE_KIOSK":
      return `${subject} was told to leave kiosk mode for a while. Once it receives the message the whole tablet can be reached, until kiosk mode is resumed.`;
    case "RESUME_KIOSK":
      return `${subject} was told to re-read its rules, which puts it back in kiosk mode when it receives the message.`;
    default:
      return `The action was sent to ${subject}. It acts when it receives the message.`;
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
 * Resolves the device from the live fleet, pushes the message, then writes the required audit row.
 * The three actions that are not push messages are handed to the module that does carry them, which
 * writes its own audit row — so there is exactly one row per act, never two and never none.
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

  const delegate = DELEGATED[def.id];
  if (delegate === "locate") {
    const located = await locateHeadwindDevice({ deviceNumber }, actor, fetchImpl, env);
    return {
      assetTag: located.assetTag,
      command: def.id,
      latitude: located.latitude,
      locatedAt: located.locatedAt,
      longitude: located.longitude,
      message: located.message,
    };
  }
  if (delegate === "action") {
    const taken = await takeHeadwindAction({ action: def.id, deviceNumber }, actor, fetchImpl, env);
    return { assetTag: taken.assetTag, command: def.id, message: taken.message };
  }

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

  return { assetTag: target.assetTag, command: def.id, message: headwindCommandSentMessage(def.id, target.subject) };
}
