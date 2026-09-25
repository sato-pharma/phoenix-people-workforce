/**
 * Remote actions on one tablet, issued through the ManageEngine MDM API.
 *
 * WHY A COMMAND IS ITS OWN CONCERN. Listing the fleet is a read; this reaches a real tablet in a
 * rep's hands and, for the two wipes, erases it. So every action here resolves the device against the
 * live fleet first (a command cannot be aimed at a tablet that is gone, and the audit names the real
 * one by its custody asset tag), issues the single documented POST, then writes a REQUIRED audit row.
 * The route above it is Super Admin only and same-origin; nothing here trusts the browser for more
 * than the device id and the action name, both checked against this module's own list.
 *
 * THE ACTIONS MAP ONE-TO-ONE TO MANAGEENGINE ENDPOINTS. Lock, restart, reset the screen lock, lost
 * mode on and off are `POST /api/v1/mdm/devices/{id}/actions/{action}`. The two wipes are the same
 * shape: `corporate_wipe` removes company management and data; `complete_wipe` is a full factory
 * reset. Both are destructive and the UI double-confirms them.
 *
 * 🔴 NEITHER WIPE RETIRES A TABLET, AND THE OWNER HIT THAT TWICE IN ONE NIGHT. On 2026-09-24 he ran
 * `corporate_wipe` on PHX-TAB-0002 at 23:51 Cairo and again at 03:07, expecting a tablet he could
 * enrol from scratch, and got neither: `corporate_wipe` un-manages the tablet but leaves it SET UP,
 * so it never returns to the welcome screen and cannot scan a fresh QR — only `complete_wipe` does
 * that. The wording below now says so at the point of the click.
 *
 * 🔴 AND MANAGEENGINE HAS NO DELETE-DEVICE ENDPOINT — do not try to build one. Their documented
 * `/api/v1/mdm/devices` surface is GET list, GET/PUT one device, the summary/certificate/restriction
 * /firmware/location reads, profile and app add-remove, and `POST …/actions/{action}`; there is no
 * method that removes the DEVICE RECORD (checked against the published API reference 2026-09-25).
 * So a wiped tablet stays in the fleet list until somebody deletes it in the ManageEngine console by
 * hand. That console step is the vendor's floor, not a gap in Phoenix — say so rather than promising
 * to automate it.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callManageEngine } from "@/lib/devices/manageengine/client";
import {
  listManageEngineDevices,
  matchManageEngineToRegister,
} from "@/lib/devices/manageengine/devices";
import { getDeviceRegisterData } from "@/lib/devices/service";

export class ManageEngineCommandInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManageEngineCommandInputError";
  }
}

export type ManageEngineCommandId =
  | "LOCK"
  | "RESTART"
  | "RESET_PASSCODE"
  | "SCAN"
  | "RING"
  | "SHUTDOWN"
  | "REMOTE_VIEW"
  | "REMOTE_CONTROL"
  | "PAUSE_KIOSK"
  | "RESUME_KIOSK"
  | "ENABLE_LOST_MODE"
  | "DISABLE_LOST_MODE"
  | "CORPORATE_WIPE"
  | "COMPLETE_WIPE";

export type ManageEngineCommandDef = {
  id: ManageEngineCommandId;
  /** The ManageEngine action segment: `/actions/{action}`. */
  action: string;
  label: string;
  description: string;
  /** Past tense for the confirmation and the audit summary. */
  pastTense: string;
  /** Erases the tablet — the UI double-confirms and the button is styled as danger. */
  destructive: boolean;
};

export const MANAGEENGINE_COMMANDS: readonly ManageEngineCommandDef[] = [
  {
    action: "lock",
    description: "Locks the screen now. The rep unlocks it with their PIN, pattern or password.",
    destructive: false,
    id: "LOCK",
    label: "Lock now",
    pastTense: "Locked",
  },
  {
    action: "restart",
    description: "Restarts the tablet now. Anything unsaved on it is lost, as with any restart.",
    destructive: false,
    id: "RESTART",
    label: "Restart",
    pastTense: "Restarted",
  },
  {
    action: "reset_passcode",
    description: "Clears the screen lock so a rep who is locked out can get back in, then asks them to set a new one.",
    destructive: false,
    id: "RESET_PASSCODE",
    label: "Reset the screen lock",
    pastTense: "Reset the screen lock of",
  },
  {
    action: "scan",
    description:
      "Asks the tablet to report in now — its battery, storage, apps and position refresh instead of waiting for the next check-in.",
    destructive: false,
    id: "SCAN",
    label: "Report in now",
    pastTense: "Asked to report in",
  },
  {
    action: "remote_alarm",
    description: "Sounds an alarm on the tablet at full volume — for finding one left in a car, a bag or a clinic.",
    destructive: false,
    id: "RING",
    label: "Ring the alarm",
    pastTense: "Rang the alarm on",
  },
  {
    action: "shutdown",
    description: "Turns the tablet off. Nobody can turn it back on remotely — somebody has to press its power button.",
    destructive: false,
    id: "SHUTDOWN",
    label: "Shut down",
    pastTense: "Shut down",
  },
  {
    action: "remote_view",
    description: "Starts a session that shows the tablet's screen, without touching it. Watch only.",
    destructive: false,
    id: "REMOTE_VIEW",
    label: "View the screen",
    pastTense: "Started a remote view session on",
  },
  {
    action: "remote_control",
    description: "Starts a session that shows the tablet's screen and lets it be driven — for walking a rep through something.",
    destructive: false,
    id: "REMOTE_CONTROL",
    label: "Take control",
    pastTense: "Started a remote control session on",
  },
  {
    action: "pause_kiosk",
    description: "Lifts kiosk mode for a while, so the whole tablet can be reached — for a repair or a settings change.",
    destructive: false,
    id: "PAUSE_KIOSK",
    label: "Pause kiosk mode",
    pastTense: "Paused kiosk mode on",
  },
  {
    action: "re_apply_kiosk",
    description: "Puts the tablet back into kiosk mode, pinned to the company's apps again.",
    destructive: false,
    id: "RESUME_KIOSK",
    label: "Resume kiosk mode",
    pastTense: "Resumed kiosk mode on",
  },
  {
    action: "enable_lost_mode",
    description: "Locks the tablet behind a message and starts reporting its position. Use it when a tablet is lost.",
    destructive: false,
    id: "ENABLE_LOST_MODE",
    label: "Put in lost mode",
    pastTense: "Put in lost mode",
  },
  {
    action: "disable_lost_mode",
    description: "Ends lost mode and unlocks the tablet — for when a lost tablet is back in hand.",
    destructive: false,
    id: "DISABLE_LOST_MODE",
    label: "End lost mode",
    pastTense: "Ended lost mode on",
  },
  {
    action: "corporate_wipe",
    description:
      "Removes company management and its apps and data, and leaves the rep's own device otherwise intact. Use it to un-manage a tablet without erasing everything. It does NOT reset the tablet: it stays set up, so it cannot scan a fresh enrollment code afterwards. To start a tablet clean, use Full factory reset instead.",
    destructive: true,
    id: "CORPORATE_WIPE",
    label: "Remove company data",
    pastTense: "Removed company data from",
  },
  {
    action: "complete_wipe",
    description:
      "Factory-resets the tablet — everything on it is erased and it comes back at the welcome screen, ready to be enrolled again. Use it for a stolen tablet, or one being retired and started clean. Its entry stays in the ManageEngine fleet list until somebody deletes it in the ManageEngine console.",
    destructive: true,
    id: "COMPLETE_WIPE",
    label: "Full factory reset",
    pastTense: "Factory-reset",
  },
] as const;

const COMMANDS_BY_ID = new Map<ManageEngineCommandId, ManageEngineCommandDef>(
  MANAGEENGINE_COMMANDS.map((entry) => [entry.id, entry]),
);

export function isManageEngineCommandId(value: unknown): value is ManageEngineCommandId {
  return typeof value === "string" && COMMANDS_BY_ID.has(value as ManageEngineCommandId);
}

export type ManageEngineCommandResult = {
  command: ManageEngineCommandId;
  assetTag: string | null;
  message: string;
};

function resultMessage(def: ManageEngineCommandDef, subject: string): string {
  switch (def.id) {
    case "LOCK":
      return `${subject} is locked. The rep unlocks it with their screen lock.`;
    case "RESTART":
      return `${subject} is restarting now.`;
    case "RESET_PASSCODE":
      return `${subject}'s screen lock is cleared. It will ask the rep to set a new one.`;
    case "SCAN":
      return `${subject} has been asked to report in. Its details refresh as soon as it answers.`;
    case "RING":
      return `${subject} is sounding its alarm. Locking it or pressing its power button stops it.`;
    case "SHUTDOWN":
      return `${subject} is turning off. Somebody has to press its power button to bring it back.`;
    case "REMOTE_VIEW":
      return `A remote view session is starting on ${subject}. Open it in ManageEngine's viewer to watch the screen.`;
    case "REMOTE_CONTROL":
      return `A remote control session is starting on ${subject}. Open it in ManageEngine's viewer to drive the screen.`;
    case "PAUSE_KIOSK":
      return `${subject} is out of kiosk mode. The whole tablet can be reached until kiosk mode is resumed.`;
    case "RESUME_KIOSK":
      return `${subject} is back in kiosk mode, pinned to the company's apps.`;
    case "ENABLE_LOST_MODE":
      return `${subject} is in lost mode: locked behind a message and reporting its position.`;
    case "DISABLE_LOST_MODE":
      return `${subject} is out of lost mode and unlocked.`;
    case "CORPORATE_WIPE":
      return (
        `${subject} is being un-managed: company apps and data are being removed. It is NOT reset — ` +
        "it stays set up as it is, so it cannot scan a fresh enrollment code. Use Full factory reset to start it clean."
      );
    case "COMPLETE_WIPE":
      return (
        `${subject} is being factory-reset. It comes back at the welcome screen and needs to be enrolled again. ` +
        "Its entry stays in the ManageEngine fleet list — delete it in the ManageEngine console, which is the only place that can."
      );
    default:
      return `${subject}: done.`;
  }
}

/**
 * Run one remote action against one ManageEngine-managed tablet.
 *
 * Resolves the device from the live fleet (so the action cannot hit one that is gone and the audit
 * names the real tablet), issues the documented POST, then writes the required audit row.
 */
export async function issueManageEngineCommand(
  input: { deviceId: string; command: ManageEngineCommandId },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManageEngineCommandResult> {
  const def = COMMANDS_BY_ID.get(input.command);
  if (!def) throw new ManageEngineCommandInputError(`Unknown action '${String(input.command)}'.`);

  const deviceId = input.deviceId.trim();
  if (!deviceId) throw new ManageEngineCommandInputError("Say which tablet to act on.");

  const [devices, register] = await Promise.all([
    listManageEngineDevices(fetchImpl, env),
    getDeviceRegisterData().catch(() => ({ devices: [] as Awaited<ReturnType<typeof getDeviceRegisterData>>["devices"] })),
  ]);
  const device = devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device) {
    throw new ManageEngineCommandInputError(
      "That tablet is not in the ManageEngine fleet any more. Reload the page and try again from its row.",
    );
  }
  const assetTag = matchManageEngineToRegister(device, register.devices)?.assetTag ?? null;
  const subject = assetTag ?? device.name;

  await callManageEngine(
    `/api/v1/mdm/devices/${encodeURIComponent(deviceId)}/actions/${def.action}`,
    { body: "{}", method: "POST" },
    fetchImpl,
    env,
  );

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: deviceId,
    entityType: "manageengine_device_command",
    newValues: { assetTag, command: def.id, deviceName: device.name },
    oldValues: null,
    summary: `${def.pastTense} ${assetTag ?? device.name}`,
  });

  return { assetTag, command: def.id, message: resultMessage(def, subject) };
}
