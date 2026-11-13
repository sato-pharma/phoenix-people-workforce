// The Turbify mailbox robots' own Railway service, `phoenix-workforce-robot` (13 Nov 2026, audit
// REC-075; the owner chose "own small Railway service").
//
// WHY. Both mailbox robots drive a headless Chromium signed in to the Turbify admin console with the
// administrator's credentials. Until this split they ran INSIDE the page server: the daily sweep and
// four Super Admin buttons each launched that browser in the process that answers every page. The
// robot service runs the same image with PHOENIX_PROCESS_ROLE=robot and is the only place a robot
// browser starts once it is switched on. Chromium itself stays in the web image: the PDF and image
// routes (src/lib/pdf/chromium.ts) still use it there.
//
// THE SWITCH IS ONE VARIABLE ON THE WEBSITE: PHOENIX_ROBOT_SERVICE_URL, the robot service's address.
//  - unset (the state this code ships in): EXACTLY the behaviour before the split — the robots run in
//    the web process, from the sweep and from the four buttons;
//  - set: the website forwards the four buttons to the robot service, the daily sweep skips the two
//    robot passes (the robot service's own cron runs them), and both driver factories REFUSE to build
//    a driver anywhere but the robot service.
// Rollback is unsetting the variable. Order and account: docs/deployment.md, "The robot service".
//
// It imports nothing but process-role.ts (itself import-free), so the factories, the sweep and the
// routes can all read it, and the unit suite can drive it with no database or browser.

import { resolveProcessRole } from "@/lib/platform/process-role";

export const ROBOT_SERVICE_URL_ENV = "PHOENIX_ROBOT_SERVICE_URL" as const;

/** The robot service's name on Railway, as the docs and the refusals say it. */
export const ROBOT_SERVICE_NAME = "phoenix-workforce-robot" as const;

/**
 * The robot service's base address with no trailing slash, or null when the switch is off. Any
 * non-empty value counts as ON, even one that is not a valid address: a malformed value must make the
 * website forward and fail loudly (502), never quietly run the robots in the page server again.
 */
export function robotServiceUrl(value: string | undefined = process.env.PHOENIX_ROBOT_SERVICE_URL): string | null {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

/** Is the robot service switched on for this process? */
export function robotServiceConfigured(value: string | undefined = process.env.PHOENIX_ROBOT_SERVICE_URL): boolean {
  return robotServiceUrl(value) !== null;
}

/**
 * Why a robot driver must not be built in this process, or null when it may.
 *
 * Refused only when the robot service is switched on AND this is not the robot service. With the
 * switch off every process builds as before; on the robot service it always builds.
 */
export function robotDriverRefusal(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (!robotServiceConfigured(env.PHOENIX_ROBOT_SERVICE_URL)) return null;
  const role = resolveProcessRole(env.PHOENIX_PROCESS_ROLE);
  if (role === "robot") return null;
  return (
    `The Turbify robots run on the robot service (${ROBOT_SERVICE_NAME}) once ${ROBOT_SERVICE_URL_ENV} is set, `
    + `and this process is '${role}', so no robot browser was opened here. Nothing was touched.`
  );
}

/** Thrown by both driver factories before anything is launched. */
export class RobotDriverRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RobotDriverRefusedError";
  }
}

/** The factories' guard: throws before a browser is launched when this process may not build a driver. */
export function assertRobotDriverAllowedHere(env?: Parameters<typeof robotDriverRefusal>[0]): void {
  const refusal = robotDriverRefusal(env);
  if (refusal) throw new RobotDriverRefusedError(refusal);
}
