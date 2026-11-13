import { NextResponse } from "next/server";

import { logError, logWarning } from "@/lib/observability/log";
import { ROBOT_SERVICE_NAME, ROBOT_SERVICE_URL_ENV, robotServiceUrl } from "@/lib/platform/robot-service";

import type { RobotActor } from "./actor";

/** The four robot buttons the website forwards, each one route on the robot service. */
export const ROBOT_ACTIONS = ["adopt", "invite-inbox", "app-password-controls", "app-password-rehearsal"] as const;
export type RobotAction = (typeof ROBOT_ACTIONS)[number];

/** The robot service's route for one action. */
export function robotActionPath(action: RobotAction): string {
  return `/api/internal/mailbox-robot/${action}`;
}

/**
 * How long the website waits for the robot service. Generous on purpose: an adoption of five
 * mailboxes runs a reset, a sign-in and an app-password mint for each, and the button waited for all
 * of it before the split too. It stays under Railway's own 15-minute cut on a public request, so the
 * person sees THIS sentence rather than a bare gateway error.
 */
export const ROBOT_FORWARD_TIMEOUT_MS = 14 * 60_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function failed(status: number, message: string, error: string): NextResponse {
  return NextResponse.json({ error, message, success: false }, { status });
}

/**
 * Send one robot button to the robot service and hand its answer back UNCHANGED — status and body —
 * so the card on the page reads exactly what it read before the split (audit REC-075).
 *
 * Called only after the website's own route has checked the session, CSRF, the Super Admin gate and
 * the rate limit. Authenticated with CRON_SECRET as a bearer (the robot route checks it with the
 * repo's cron-secret helper, in constant time). A failure to REACH the robot service answers 502 with
 * a sentence and no credential: the robot's own answer can carry a hand-over sentence for the person
 * who pressed the button, but nothing here ever echoes the request, the bearer or the address with a
 * secret in it.
 */
export async function forwardToRobotService(input: {
  action: RobotAction;
  actor: RobotActor;
  fetchImpl?: FetchLike;
  request: Record<string, unknown>;
  secret?: string | undefined;
  timeoutMs?: number;
  url?: string | null;
}): Promise<NextResponse> {
  const base = input.url === undefined ? robotServiceUrl() : input.url;
  const secret = String((input.secret === undefined ? process.env.CRON_SECRET : input.secret) ?? "").trim();
  if (!base) {
    return failed(503, `${ROBOT_SERVICE_URL_ENV} is not set, so there is no robot service to send this to. Nothing was run.`, "robot_service_not_configured");
  }
  let target: URL;
  try {
    target = new URL(robotActionPath(input.action), `${base}/`);
    if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("not http");
  } catch {
    return failed(502, `${ROBOT_SERVICE_URL_ENV} is not a valid http(s) address, so the robot service could not be reached. Nothing was run.`, "robot_service_unreachable");
  }
  if (!secret) {
    return failed(503, "CRON_SECRET is not set on the website, so it cannot prove itself to the robot service. Nothing was run.", "robot_service_not_configured");
  }

  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  let response: Response;
  try {
    response = await fetchImpl(target.toString(), {
      body: JSON.stringify({ actor: input.actor, request: input.request }),
      cache: "no-store",
      headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs ?? ROBOT_FORWARD_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    logError("The website could not reach the robot service", {
      error,
      labels: { action: input.action, event: "robot_service_forward_failed", timedOut },
    });
    return failed(
      502,
      timedOut
        ? `The robot service (${ROBOT_SERVICE_NAME}) did not answer in time. The run may still be going on there — read the audit log before pressing this again.`
        : `The robot service (${ROBOT_SERVICE_NAME}) could not be reached. Nothing is known to have run — read the audit log before pressing this again.`,
      "robot_service_unreachable",
    );
  }

  if (response.status === 401) {
    logWarning("The robot service refused the website's bearer", {
      labels: { action: input.action, event: "robot_service_forward_unauthorized" },
    });
    return failed(
      502,
      `The robot service (${ROBOT_SERVICE_NAME}) refused the website's credential — CRON_SECRET differs between the two services. Nothing was run.`,
      "robot_service_unauthorized",
    );
  }

  const text = await response.text();
  return new NextResponse(text, {
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    status: response.status,
  });
}
