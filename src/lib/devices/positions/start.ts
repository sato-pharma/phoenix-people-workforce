/**
 * Starting the Phoenix Position agent on a tablet that already holds it.
 *
 * 🔴 AN APK HEADWIND HAS INSTALLED IS NOT AN APP THAT HAS RUN, AND THE POSITION AGENT IS THE ONE APP
 * IN THIS FLEET WHERE THE DIFFERENCE IS EVERYTHING. The agent shows the rep nothing — no icon, no
 * notification, no screen (the golden rule: a rep tablet never shows its user any sign it is
 * tracked), so nobody can open it, and Android keeps an app nothing has ever started in the
 * **stopped** state, where not even `BOOT_COMPLETED` reaches it. Until something starts it once it
 * mints no install id, says no hello and schedules no rounds: the APK sits on the tablet and Phoenix
 * never hears a word. Measured on production, 26 Nov 2026 — Phoenix Position 1.0.0 was installed on
 * PHX-TAB-0007 and PHX-TAB-0008, both checking in that morning, and `device_position_agents` held
 * **0 rows**.
 *
 * 🔴 THE CURE FOR EVERY FUTURE INSTALL IS THE APP ROW'S OWN `runAfterInstall`, WHICH HEADWIND ACTS ON
 * AT INSTALL TIME ONLY (`setHeadwindAppRunAfterInstall`, `uploads.ts`). It was false on application 98,
 * which is why neither tablet ever ran it — and turning it on cannot reach a tablet that already holds
 * the APK, because there is no install left to run after. That tablet needs this: Headwind's own
 * `runApp` push, which the launcher turns into a `startActivity` on the package named in the payload.
 * An explicit start by another app is exactly what lifts the stopped state, so one push does for a
 * tablet already carrying the app what `runAfterInstall` does for the next one to receive it.
 *
 * It is the agent's whole visible surface and it stays invisible to the rep: `StartActivity` draws
 * nothing, finishes inside `onCreate`, schedules the rounds and then disables itself.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { getHeadwindDeviceApps } from "@/lib/devices/headwind/apps";
import { callHeadwind } from "@/lib/devices/headwind/client";
import { type HeadwindAuditWriter } from "@/lib/devices/headwind/configurations";
import { HeadwindCommandInputError, resolveHeadwindActionTarget } from "@/lib/devices/headwind/target";
import { rustDeskPackageName } from "@/lib/devices/rustdesk/config";

/**
 * The agent's Android package — `com.satopharma.phoenixposition`, the `:position` module of
 * `sato-pharma/phoenix-field-camera`, signed with the same key as Phoenix Camera.
 *
 * Written once, here, because three things have to agree about it: the APK on the tablet server, the
 * push payload that starts it, and the app row whose `runAfterInstall` starts it by itself next time.
 */
export const POSITION_AGENT_PACKAGE = "com.satopharma.phoenixposition";

/** Headwind's own name for the message that starts an app — `PushMessage.TYPE_RUN_APP`. */
export const POSITION_AGENT_START_MESSAGE = "runApp";

export class PositionAgentStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PositionAgentStartError";
  }
}

export type PositionAgentStartResult = {
  deviceNumber: string;
  assetTag: string | null;
  /** What the tablet's own app list said about the agent before the push. */
  installedVersion: string | null;
  message: string;
};

/**
 * Tell one tablet to start its position agent now.
 *
 * 🔴 IT REFUSES A TABLET THAT HAS NOT GOT THE APP, RATHER THAN REPORTING A SUCCESS THAT REACHED
 * NOTHING. Headwind answers the push 200 whatever package it names, so without this read a tablet
 * that has not installed the agent yet — one off the network for weeks, one whose update run stopped
 * at a dead install link — would read exactly like a tablet that just started it, and the hello that
 * never comes would look like a fault in the app. A tablet that reported NO apps at all is "could not
 * be read", never "has not got it": the two are different sentences because they call for different
 * acts.
 */
export async function startPositionAgentOnTablet(
  input: { deviceNumber: string },
  actor: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  audit: HeadwindAuditWriter = writeRequiredAuditLog,
): Promise<PositionAgentStartResult> {
  const deviceNumber = input.deviceNumber.trim();
  if (!deviceNumber) throw new HeadwindCommandInputError("Say which tablet to start the agent on.");

  const target = await resolveHeadwindActionTarget(deviceNumber, fetchImpl, env);
  const { installed } = await getHeadwindDeviceApps(target.deviceNumber, rustDeskPackageName(env), fetchImpl, env);
  if (installed.length === 0) {
    throw new PositionAgentStartError(
      `${target.subject} has not reported which apps it is carrying, so there is nothing to say whether the position agent is on it. ` +
        "Nothing was sent. Wait for its next check-in and look again.",
    );
  }
  const agent = installed.find((app) => app.packageName === POSITION_AGENT_PACKAGE) ?? null;
  if (!agent) {
    throw new PositionAgentStartError(
      `${target.subject} has not got the position agent yet, so nothing was sent. It installs at a check-in once its rules carry the app — ` +
        "check the install links on those rules, because one dead link stops the tablet's whole update run at that app.",
    );
  }

  await callHeadwind(
    "/rest/private/push",
    {
      body: JSON.stringify({
        broadcast: false,
        deviceNumbers: [target.deviceNumber],
        // 🔴 A STRING CONTAINING JSON, NOT AN OBJECT — Headwind's push endpoint takes the payload as
        // text and hands it to the agent as text (`commands.ts`).
        messageType: POSITION_AGENT_START_MESSAGE,
        payload: JSON.stringify({ pkg: POSITION_AGENT_PACKAGE }),
      }),
      method: "POST",
    },
    fetchImpl,
    env,
  );

  await audit({
    actorLoginId: actor,
    entityId: target.deviceNumber,
    entityType: "tablet_position_agent",
    newValues: {
      change: "start-agent",
      deviceName: target.deviceName,
      installedVersion: agent.version,
      messageType: POSITION_AGENT_START_MESSAGE,
      packageName: POSITION_AGENT_PACKAGE,
    },
    oldValues: null,
    summary: `Started the position agent on ${target.subject}`,
  });

  return {
    assetTag: target.assetTag,
    deviceNumber: target.deviceNumber,
    installedVersion: agent.version,
    message:
      `${target.subject} was told to start its position agent${agent.version ? ` (${agent.version})` : ""}. ` +
      "It starts when the tablet receives the message, says hello to Phoenix on its first run, and then reports a position every quarter of an hour. " +
      "The install arrives unbound — say which tablet it is with bind-tablet-agent.",
  };
}
