/**
 * Erase the company's data from one tablet, without factory-resetting it.
 *
 * WHAT THIS IS FOR. A rep leaves, or a tablet moves to someone else, and what has to go is the
 * company's work — not the tablet. A full factory reset would also take the enrolment with it, so the
 * tablet would have to be set up by hand again; this leaves the tablet managed, reachable and ready
 * for the next person, and takes only what the company put on it.
 *
 * 🔴 WHAT IT ERASES IS THE OWNER'S OWN ANSWER, 2026-09-25, AND IT IS NOT A SETTING.
 *   Apps whose data is cleared — the Phoenix app and Chrome.
 *   Folders emptied — Downloads, and the camera roll.
 * He was asked both questions in writing and chose the camera roll deliberately, over the option that
 * would have spared it. **Field photos live in the camera roll**, so this does take a rep's visit
 * evidence with it — which is the point when a tablet is changing hands, and is exactly why the
 * console arms this in two presses and the second one names what goes. It is a fixed list rather than
 * a form, because a wipe that can be aimed is a wipe that can be mis-aimed.
 *
 * HOW IT REACHES THE TABLET. Three of the seventeen push messages the Headwind agent accepts, read
 * from its own source rather than from its documentation:
 *
 *   hmdm-android  .../worker/PushNotificationProcessor.java
 *     clearAppData  → payload.getString("pkg")   → DevicePolicyManager.clearApplicationUserData()
 *     purgeDir      → payload.getString("path")  → empties the directory, keeping the directory
 *                     payload.getString("recursive").equals("1") → subdirectories too
 *
 * `clearAppData` needs Android 9 or newer and device-owner rights, which the agent has. Every path is
 * resolved by the agent against the tablet's own external storage — so `Download`, never `/sdcard/…`.
 *
 * 🔴 SILENT TO THE REP, BY DESIGN. Nothing is shown on the tablet, which is what makes this usable on
 * a device someone is holding — and exactly why the route above it is Super Admin only, same-origin,
 * and writes a required audit row naming the tablet and every instruction sent.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { resolveHeadwindActionTarget } from "@/lib/devices/headwind/target";

/**
 * A wipe that did not happen, or did not happen whole.
 *
 * 🔴 `partial` IS THE DIFFERENCE BETWEEN "NOTHING WAS SENT" AND "SOME OF IT WAS". A blank device
 * number never reached the server and is the caller's mistake (400). A refusal part-way through means
 * instructions ARE already on their way to a tablet, and reading that as a 400 would put a person's
 * own mistake in the log for something the server did (502). The sentence says how far it got either
 * way; the status is for whoever reads the log at 4am.
 */
export class HeadwindWipeError extends Error {
  readonly partial: boolean;

  constructor(message: string, partial = false) {
    super(message);
    this.name = "HeadwindWipeError";
    this.partial = partial;
  }
}

/**
 * The apps whose data a corporate wipe clears.
 *
 * 🔴 THE MANAGEMENT AGENT IS NOT IN THIS LIST AND MUST NEVER BE ADDED. `clearAppData` on
 * `com.hmdm.launcher` would empty the agent's own store — its server address, its device number and
 * its enrolment — leaving a tablet that is still device-owned by an app that no longer knows where
 * home is. That is unrecoverable without physically holding the tablet.
 */
export const HEADWIND_WIPE_APPS: readonly { packageName: string; label: string }[] = [
  { label: "the Phoenix app", packageName: "com.satopharma.phoenixworkforce" },
  { label: "Chrome", packageName: "com.android.chrome" },
] as const;

/**
 * The folders a corporate wipe empties, as the agent resolves them — relative to the tablet's own
 * external storage, never as an absolute path.
 *
 * `DCIM/Camera` is the camera roll, and it is here because the owner chose it over the option that
 * left it alone. Anything a rep photographed with the tablet's camera goes.
 */
export const HEADWIND_WIPE_FOLDERS: readonly { path: string; label: string }[] = [
  { label: "Downloads", path: "Download" },
  { label: "the camera roll, including field photos", path: "DCIM/Camera" },
] as const;

/** The plain-words list the console shows beside the second press. Order matches what is sent. */
export function headwindWipeScope(): { apps: string[]; folders: string[] } {
  return {
    apps: HEADWIND_WIPE_APPS.map((entry) => entry.label),
    folders: HEADWIND_WIPE_FOLDERS.map((entry) => entry.label),
  };
}

export type HeadwindWipeResult = {
  assetTag: string | null;
  /** Every instruction the server accepted, in the order it was sent. */
  sent: string[];
  message: string;
};

type WipeStep = { messageType: string; payload: string; described: string };

function wipeSteps(): WipeStep[] {
  return [
    ...HEADWIND_WIPE_APPS.map((app) => ({
      described: `cleared ${app.label}`,
      messageType: "clearAppData",
      payload: JSON.stringify({ pkg: app.packageName }),
    })),
    ...HEADWIND_WIPE_FOLDERS.map((folder) => ({
      described: `emptied ${folder.label}`,
      messageType: "purgeDir",
      // 🔴 `recursive` IS THE STRING "1", NOT `true`. The agent tests it with
      // `"1".equals(payload.getString("recursive"))` — a boolean there reads as "not 1", and the
      // purge then quietly skips every subdirectory while still answering 200.
      payload: JSON.stringify({ path: folder.path, recursive: "1" }),
    })),
  ];
}

/**
 * Erase the company's data from one tablet.
 *
 * Resolves the tablet against the live fleet first, then sends each instruction in turn. A refusal
 * part-way through is NOT swallowed: what was already accepted is written to the audit row, and the
 * error names how far it got — because a half-finished wipe that reports as a failure is how a tablet
 * gets handed on with the company's data believed to be still on it, or believed to be gone.
 *
 * 🔴 "SENT" IS NOT "ERASED". The push endpoint accepts the message and hands it on; whether the
 * tablet was awake to act on it shows at its next check-in. The sentence handed back says so.
 */
export async function wipeHeadwindDevice(
  input: { deviceNumber: string },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadwindWipeResult> {
  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindWipeError("Say which tablet to erase the company's data from.");

  const target = await resolveHeadwindActionTarget(deviceNumber, fetchImpl, env);
  const steps = wipeSteps();
  const sent: string[] = [];

  try {
    for (const step of steps) {
      await callHeadwind(
        "/rest/private/push",
        {
          body: JSON.stringify({
            broadcast: false,
            deviceNumbers: [target.deviceNumber],
            messageType: step.messageType,
            payload: step.payload,
          }),
          method: "POST",
        },
        fetchImpl,
        env,
      );
      sent.push(step.described);
    }
  } catch (error) {
    await writeRequiredAuditLog({
      actorLoginId: actor,
      entityId: target.deviceNumber,
      entityType: "headwind_device_command",
      newValues: {
        assetTag: target.assetTag,
        command: "CORPORATE_WIPE",
        completed: false,
        deviceName: target.deviceName,
        sent,
      },
      oldValues: null,
      summary: `Erased part of the company's data from ${target.subject} — ${sent.length} of ${steps.length} instructions sent`,
    });
    throw new HeadwindWipeError(
      `${target.subject} took ${sent.length} of the ${steps.length} instructions before the server refused ` +
        `(${sent.join(", ") || "none"}). The rest were not sent. Press it again to send the whole list — ` +
        "repeating one that already ran does no harm. " +
        (error instanceof Error ? error.message : "The server gave no reason."),
      true,
    );
  }

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityId: target.deviceNumber,
    entityType: "headwind_device_command",
    newValues: {
      assetTag: target.assetTag,
      command: "CORPORATE_WIPE",
      completed: true,
      deviceName: target.deviceName,
      sent,
    },
    oldValues: null,
    summary: `Erased the company's data from ${target.subject}`,
  });

  return {
    assetTag: target.assetTag,
    message:
      `${target.subject} has been told to clear ${HEADWIND_WIPE_APPS.map((app) => app.label).join(" and ")}, ` +
      `and to empty ${HEADWIND_WIPE_FOLDERS.map((folder) => folder.label).join(" and ")}. Nothing is shown ` +
      "to the rep. The tablet stays enrolled and managed — this is not a factory reset. It takes effect " +
      "at the tablet's next check-in, which is what confirms it.",
    sent,
  };
}
