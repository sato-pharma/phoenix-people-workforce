/**
 * Lock · lost mode on and off · factory reset · reset the screen lock · ring the alarm · show a
 * message · shut down.
 *
 * 🔴 THE OWNER'S RULING, 2026-09-25: "do not build a dead button. Find a tool that can do this
 * function for free." So nothing here is a button that greys out or apologises. Each action either
 * genuinely reaches the tablet, or is refused in plain words that say what would make it work — and
 * one of the seven is refused permanently, because it does not exist for anyone at any price.
 *
 * ── WHAT THE TABLET CAN ALREADY DO, AND WHY IT LOOKED LIKE IT COULD NOT ─────────────────────────
 *
 * The free Headwind AGENT is not the limitation. Read from `hmdm-android` 6.39 (`c9221a1f`), the
 * agent already implements all of this and has done for years:
 *
 *   config field     acts in                                    and calls
 *   `lock`           MainActivity.showLockScreen()              a full-screen overlay nothing escapes
 *   `lockMessage`    the same overlay                           prints the device id, then our words
 *   `factoryReset`   ConfigUpdater.checkFactoryReset()          dpm.wipeData(0) / wipeDevice(0) on 14+
 *   `passwordReset`  ConfigUpdater.checkPasswordReset()         dpm.resetPasswordWithToken(...)
 *   `reboot`         ConfigUpdater.checkRemoteReboot()          dpm.reboot(...)
 *
 * What is missing is at the other end: the open-source SERVER's `Configuration` and `SyncResponse`
 * carry none of those five fields, and the `devicereset` plugin that owns them is not in the
 * open-source repository. **The tablet is listening for an instruction the free server has no way to
 * write.** That is the whole of it — and it is the opposite of what a reasonable reading of the
 * vendor's Community/Premium table suggests, which is that the tablets cannot do it.
 *
 * Headwind publishes the door for exactly this case. `com.hmdm.rest.json.SyncResponseHook` is a
 * public interface on the Apache-2.0 core — *"the hooks may extend the response with additional
 * properties"*. The Phoenix add-on in `infra/headwind-phoenix-actions/` implements it and injects
 * those five fields for a tablet with a pending row. **Nothing on any tablet changes.**
 *
 * ── WHAT EACH ACTION ACTUALLY USES ──────────────────────────────────────────────────────────────
 *
 *   Lock, lost mode, factory reset, reset the screen lock   the add-on on our own Headwind box
 *   Ring the alarm, show a message                          the Phoenix app, woken by an `intent` push
 *   Shut down                                               🔴 nothing. See below.
 *
 * 🔴 SHUT DOWN IS IMPOSSIBLE AND IS NOT A GAP IN THIS BUILD. `PowerManager.shutdown()` is a
 * signature-level permission on Android — granted only to an app signed with the platform key, which
 * means the device manufacturer. No MDM has it on stock Android, free or paid; the ones advertising it
 * are using Samsung Knox or Zebra's own extensions on their own hardware. Reboot is NOT a substitute:
 * a stolen tablet that reboots comes back on. This is reported as impossible, in words, on the page —
 * never shipped as a button that refuses.
 *
 * 🔴 AND THE ON-SCREEN MESSAGE DOES NOT USE HEADWIND'S MESSAGING PLUGIN, WHICH LOOKS LIKE THE OBVIOUS
 * ANSWER AND IS NOT ONE. `POST /rest/plugins/messaging/private/send` exists in the free build and
 * sends push type `textMessage` — for which the stock agent has NO handler. It falls to the default
 * branch and is re-broadcast to plugins, so the message reaches the tablet and nothing draws it. (The
 * plugin also hand-builds its JSON with unquoted keys.) Phoenix sends an `intent` into the Phoenix
 * app instead, which draws it — the same door the alarm uses.
 */

import { randomInt } from "node:crypto";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind, HeadwindRequestError } from "@/lib/devices/headwind/client";
import { resolveHeadwindActionTarget } from "@/lib/devices/headwind/target";

export class HeadwindActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadwindActionError";
  }
}

export type HeadwindActionId =
  | "LOCK"
  | "UNLOCK"
  | "LOST_MODE_ON"
  | "LOST_MODE_OFF"
  | "FACTORY_RESET"
  | "RESET_SCREEN_LOCK"
  | "RING_ALARM"
  | "SHOW_MESSAGE"
  | "SHUT_DOWN";

/** Which side of the system carries the action. */
export type HeadwindActionCarrier = "add-on" | "phoenix-app" | "impossible";

export type HeadwindActionDef = {
  id: HeadwindActionId;
  label: string;
  description: string;
  /**
   * The audit row's verb, which is also the tablet's command history. 🔴 It says what Phoenix DID —
   * queued or sent — never what the tablet did: "Locked PHX-TAB-0007" was written the moment the
   * add-on accepted the row, before any tablet had seen it (9 Nov 2026 audit).
   */
  pastTense: string;
  carrier: HeadwindActionCarrier;
  /** Needs the second press and a named tablet before it will run. */
  destructive: boolean;
  /** Takes words the owner types. */
  needsMessage: boolean;
};

/** The package the alarm and the on-screen message are drawn by — our own app, not the agent. */
export const PHOENIX_APP_PACKAGE = "com.satopharma.phoenixworkforce";

/**
 * The intent actions the Phoenix app registers.
 *
 * 🔴 THESE TWO STRINGS ARE A CONTRACT WITH THE ANDROID BUILD, not a name that can be tidied. They are
 * declared in `mobile/plugins/with-phoenix-device-actions.js` as the intent filters of the activity
 * that answers them. Changing one here without rebuilding and redistributing the APK gives a button
 * that reports "sent" and does nothing on the tablet — the exact failure this module exists to avoid.
 */
export const PHOENIX_ALARM_INTENT = "com.satopharma.phoenixworkforce.DEVICE_ALARM";
export const PHOENIX_MESSAGE_INTENT = "com.satopharma.phoenixworkforce.DEVICE_MESSAGE";

/** Where the Phoenix add-on lives on our own Headwind box, if it is installed. */
const ADDON_BASE = "/rest/plugins/phoenix-actions/private";

export const HEADWIND_ACTIONS: readonly HeadwindActionDef[] = [
  {
    carrier: "add-on",
    description:
      "Puts a full-screen lock over the tablet. Nothing can be used until it is unlocked from here. " +
      "The rep is not asked and cannot dismiss it.",
    destructive: false,
    id: "LOCK",
    label: "Lock the tablet",
    needsMessage: false,
    pastTense: "Queued a lock for",
  },
  {
    carrier: "add-on",
    description: "Takes the lock off and gives the tablet back.",
    destructive: false,
    id: "UNLOCK",
    label: "Unlock the tablet",
    needsMessage: false,
    pastTense: "Queued an unlock for",
  },
  {
    carrier: "add-on",
    description:
      "Locks the tablet and prints your own words across the screen — for a lost one, whoever finds " +
      "it reads how to return it. The tablet's own id is shown with them.",
    destructive: false,
    id: "LOST_MODE_ON",
    label: "Lost mode on",
    needsMessage: true,
    pastTense: "Queued lost mode for",
  },
  {
    carrier: "add-on",
    description: "Clears the message and unlocks the tablet.",
    destructive: false,
    id: "LOST_MODE_OFF",
    label: "Lost mode off",
    needsMessage: false,
    pastTense: "Queued lost mode off for",
  },
  {
    carrier: "add-on",
    description:
      "Erases the tablet completely and returns it to how it left the factory — including the " +
      "management enrolment, so it stops being ours. Nothing on it can be recovered afterwards.",
    destructive: true,
    id: "FACTORY_RESET",
    label: "Factory reset",
    needsMessage: false,
    pastTense: "Queued a factory reset for",
  },
  {
    carrier: "add-on",
    description:
      "Replaces the tablet's screen lock with a one-time six-digit PIN that Phoenix shows you once, " +
      "for a rep who is locked out of their own tablet. Nothing on the tablet is erased.",
    destructive: false,
    id: "RESET_SCREEN_LOCK",
    label: "Reset the screen lock",
    needsMessage: false,
    pastTense: "Queued a screen-lock reset for",
  },
  {
    carrier: "phoenix-app",
    description:
      "Sounds a loud alarm on the tablet so it can be found in a room or a bag. It plays on the alarm " +
      "channel, so it is heard with the ringer down.",
    destructive: false,
    id: "RING_ALARM",
    label: "Ring the alarm",
    needsMessage: false,
    pastTense: "Sent the alarm to",
  },
  {
    carrier: "phoenix-app",
    description: "Shows your own words on the tablet's screen, where the rep will see them.",
    destructive: false,
    id: "SHOW_MESSAGE",
    label: "Show a message",
    needsMessage: true,
    pastTense: "Sent a message to",
  },
  {
    carrier: "impossible",
    description:
      "Not possible on any Android tablet, from any system, free or paid. Turning a device off needs " +
      "a permission only the manufacturer's own signature grants. Restart is not a substitute — a " +
      "stolen tablet that restarts comes back on. Lock it or erase it instead.",
    destructive: false,
    id: "SHUT_DOWN",
    label: "Shut down",
    needsMessage: false,
    pastTense: "",
  },
] as const;

export function isHeadwindActionId(value: unknown): value is HeadwindActionId {
  return typeof value === "string" && HEADWIND_ACTIONS.some((action) => action.id === value);
}

export type HeadwindActionAvailability = HeadwindActionDef & {
  available: boolean;
  unavailableReason: string | null;
};

/**
 * Is the Phoenix add-on installed on this Headwind box?
 *
 * 🔴 ASKED, NEVER ASSUMED. The add-on is built into the box's own image by a Dockerfile the owner
 * runs; a box built before it, or rebuilt without it, answers 404 here. Assuming it is present would
 * turn four actions into buttons that report success against an endpoint that does not exist.
 *
 * 🔴 AND ONLY A 404 MEANS "NOT INSTALLED" (9 Nov 2026 audit, F16). This used to swallow every error,
 * so a timeout, a refused sign-in, a Cloudflare Access fault or a box that was simply down all read
 * "the add-on is not installed — rebuild the Headwind box", which sends a person to rebuild a server
 * that has the add-on and is merely unreachable. Anything but a 404 now surfaces as itself.
 */
export async function headwindAddonInstalled(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const status = await callHeadwind<{ ready?: unknown }>(
      `${ADDON_BASE}/status`,
      { method: "GET" },
      fetchImpl,
      env,
    );
    return status?.ready === true;
  } catch (error) {
    if (error instanceof HeadwindRequestError && error.status === 404) return false;
    throw error;
  }
}

const ADDON_MISSING =
  "This needs the small Phoenix add-on on the Headwind server, which is not installed on it yet. " +
  "The tablets themselves already know how to do this — it is the server that has no way to ask them. " +
  "Rebuild the Headwind box with the Phoenix image (infra/headwind-phoenix-actions) and it works with " +
  "no change to any tablet.";

const SHUT_DOWN_REASON =
  "Turning an Android tablet off from a server is not possible — not here, and not in any paid system " +
  "either. The permission it needs is granted only to apps signed by the tablet's own manufacturer. " +
  "Lock it, or erase it, instead.";

/** Every action, and whether this box can honour it right now. */
export async function headwindActionCatalogue(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindActionAvailability[]> {
  const addon = await headwindAddonInstalled(fetchImpl, env);
  return HEADWIND_ACTIONS.map((action) => {
    if (action.carrier === "impossible") {
      return { ...action, available: false, unavailableReason: SHUT_DOWN_REASON };
    }
    if (action.carrier === "add-on" && !addon) {
      return { ...action, available: false, unavailableReason: ADDON_MISSING };
    }
    return { ...action, available: true, unavailableReason: null };
  });
}

export type HeadwindActionResult = {
  action: HeadwindActionId;
  assetTag: string | null;
  message: string;
};

/** The longest message the lock overlay can print without running off the screen on a 7-inch tablet. */
export const HEADWIND_MESSAGE_LIMIT = 300;

function checkMessage(def: HeadwindActionDef, message: string | null | undefined): string | null {
  if (!def.needsMessage) return null;
  const text = (message ?? "").trim();
  if (!text) {
    throw new HeadwindActionError(
      def.id === "LOST_MODE_ON"
        ? "Type the words to print on the screen — a phone number to call, or how to return the tablet."
        : "Type the words to show on the tablet.",
    );
  }
  if (text.length > HEADWIND_MESSAGE_LIMIT) {
    throw new HeadwindActionError(
      `That message is ${text.length} characters. Keep it under ${HEADWIND_MESSAGE_LIMIT} so it fits on ` +
        "the tablet's screen without being cut off.",
    );
  }
  return text;
}

/** A PIN a person would try first: one digit repeated, or a straight run up or down (123456, 987654). */
function guessablePin(pin: string): boolean {
  const digits = [...pin].map(Number);
  const steps = new Set(digits.slice(1).map((digit, index) => digit - (digits[index] as number)));
  return steps.size === 1 && [0, 1, -1].includes([...steps][0] as number);
}

/**
 * The temporary screen-lock PIN for "Reset the screen lock".
 *
 * 🔴 WHY THERE IS A PIN AT ALL (fixed 2026-10-22). The agent's `passwordReset` is not a switch — it is
 * the NEW password, handed to `dpm.resetPasswordWithToken`. Phoenix used to send only
 * `passwordReset: true`; the add-on reads the words from `password`, its `text()` drops a missing one
 * to null, the sync then carried `passwordReset: null`, and the tablet did nothing while the row still
 * read as sent. A cleared lock would leave a field tablet open to anyone, so the reset sets a fresh
 * six-digit PIN instead. It is shown to the person who pressed the button ONCE and is never written to
 * Phoenix's audit row; the add-on drops its own copy when the tablet confirms.
 */
export function temporaryScreenLockPin(draw: (limit: number) => number = (limit) => randomInt(limit)): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pin = String(draw(1_000_000)).padStart(6, "0");
    if (/^\d{6}$/.test(pin) && !guessablePin(pin)) return pin;
  }
  throw new HeadwindActionError("A temporary PIN could not be made. Try the reset again.");
}

/** What the add-on is asked to put in the tablet's next sync response. */
export function headwindAddonBody(
  action: HeadwindActionId,
  deviceNumber: string,
  message: string | null,
  password: string | null = null,
) {
  switch (action) {
    case "LOCK":
      return { deviceNumber, lock: true };
    case "UNLOCK":
    case "LOST_MODE_OFF":
      return { deviceNumber, lock: false, lockMessage: null };
    case "LOST_MODE_ON":
      return { deviceNumber, lock: true, lockMessage: message };
    case "FACTORY_RESET":
      return { deviceNumber, factoryReset: true };
    case "RESET_SCREEN_LOCK":
      // 🔴 A reset with no PIN is refused here, not sent: the tablet would ignore it (see above).
      if (!password) throw new HeadwindActionError("A screen-lock reset has to carry the new PIN.");
      return { deviceNumber, password, passwordReset: true };
    default:
      throw new HeadwindActionError("That is not an action the add-on carries.");
  }
}

/**
 * Take one of the custody actions on one tablet.
 *
 * Order is the house order and does not vary: resolve against the live fleet, act, then write the
 * required audit row. Auditing first would record acts that never happened.
 */
export async function takeHeadwindAction(
  input: { deviceNumber: string; action: unknown; message?: string | null },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  // The audit writer is a parameter only so a test can read the row without a database.
  audit: typeof writeRequiredAuditLog = writeRequiredAuditLog,
): Promise<HeadwindActionResult> {
  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindActionError("Say which tablet.");
  if (!isHeadwindActionId(input.action)) throw new HeadwindActionError("Say what to do to the tablet.");

  const def = HEADWIND_ACTIONS.find((entry) => entry.id === input.action) as HeadwindActionDef;

  // 🔴 REFUSED BEFORE ANY NETWORK CALL, AND PERMANENTLY. Not "not yet".
  if (def.carrier === "impossible") throw new HeadwindActionError(SHUT_DOWN_REASON);

  const message = checkMessage(def, input.message);
  const target = await resolveHeadwindActionTarget(deviceNumber, fetchImpl, env);
  // Never audited, never logged — it reaches the person who pressed the button once, in the reply.
  const pin = def.id === "RESET_SCREEN_LOCK" ? temporaryScreenLockPin() : null;

  if (def.carrier === "add-on") {
    if (!(await headwindAddonInstalled(fetchImpl, env))) throw new HeadwindActionError(ADDON_MISSING);
    try {
      await callHeadwind(
        `${ADDON_BASE}/action`,
        { body: JSON.stringify(headwindAddonBody(def.id, target.deviceNumber, message, pin)), method: "POST" },
        fetchImpl,
        env,
      );
    } catch (error) {
      if (error instanceof HeadwindRequestError && error.status === 404) {
        throw new HeadwindActionError(ADDON_MISSING);
      }
      throw error;
    }
  } else {
    // The Phoenix app's own door. `intent` starts a named activity with CLEAR_TASK | NEW_TASK and
    // hands it typed extras — the only push in the agent that can carry our own words to our own app.
    await callHeadwind(
      "/rest/private/push",
      {
        body: JSON.stringify({
          broadcast: false,
          deviceNumbers: [target.deviceNumber],
          messageType: "intent",
          payload: JSON.stringify({
            action: def.id === "RING_ALARM" ? PHOENIX_ALARM_INTENT : PHOENIX_MESSAGE_INTENT,
            extra: message ? { message } : {},
            pkg: PHOENIX_APP_PACKAGE,
          }),
        }),
        method: "POST",
      },
      fetchImpl,
      env,
    );
  }

  await audit({
    actorLoginId: actor,
    entityId: target.deviceNumber,
    entityType: "headwind_device_command",
    newValues: {
      action: def.id,
      assetTag: target.assetTag,
      carrier: def.carrier,
      deviceName: target.deviceName,
      // The words themselves are the point of the act and are not a credential, so they are kept.
      message,
    },
    oldValues: null,
    summary: `${def.pastTense} ${target.subject}`,
  });

  return {
    action: def.id,
    assetTag: target.assetTag,
    message: resultMessage(def, target.subject, pin),
  };
}

/**
 * 🔴 THE ADD-ON QUEUES; IT DOES NOT ACT, AND NOTHING WAKES THE TABLET (9 Nov 2026 audit). The add-on
 * writes a row the tablet picks up at its NEXT check-in, and its own reply says `queued: true,
 * confirmed: false`. Phoenix sends no wake push after it, so "will lock at its next check-in, usually
 * within a minute or two" promised a timing nobody had measured — for a lost tablet, the one moment
 * that sentence is read most carefully. Each sentence now says what is known: it is queued, and
 * Phoenix has not seen it happen.
 */
function resultMessage(def: HeadwindActionDef, subject: string, pin: string | null = null): string {
  const unseen = "Phoenix has not seen the tablet do it yet.";
  switch (def.id) {
    case "LOCK":
      return `A lock is queued for ${subject}. The tablet locks when it next checks in with the tablet server, and stays usable until then — a tablet with no signal does not check in. ${unseen}`;
    case "UNLOCK":
    case "LOST_MODE_OFF":
      return `An unlock is queued for ${subject}. The tablet unlocks when it next checks in with the tablet server; until then it stays locked. ${unseen}`;
    case "LOST_MODE_ON":
      return `Lost mode is queued for ${subject}. When it next checks in with the tablet server it locks and shows your words with its own id; until then it is usable — a tablet with no signal does not check in. ${unseen}`;
    case "FACTORY_RESET":
      return `A factory reset is queued for ${subject}. It erases itself when it next checks in with the tablet server. 🔴 It also stops being managed at that moment, so nothing here can reach it again — and nothing on it can be recovered. ${unseen}`;
    case "RESET_SCREEN_LOCK":
      return `${subject} will take the temporary PIN ${pin ?? ""} as its screen lock at its next check-in. Give it to the rep now — Phoenix does not show it again or keep it. Nothing on the tablet is erased, and the rep can change the PIN in the tablet's own settings once they are in.`;
    case "RING_ALARM":
      return `${subject} will sound its alarm. It plays on the alarm channel, so it is heard with the ringer down — though under Do Not Disturb it plays at whatever volume is already set.`;
    case "SHOW_MESSAGE":
      return `${subject} will show your words. The Phoenix app draws them, so the tablet needs the app installed and a signal.`;
    default:
      return `${def.pastTense} ${subject}.`;
  }
}
