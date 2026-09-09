import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { marketAwarenessErrorResponse } from "@/lib/market-awareness/api-response";
import { MarketAwarenessError, decideActivity } from "@/lib/market-awareness/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The five answers a decider can give. Checked HERE as well as in the service, because the action
 * reaches `decideActivity` as a string off the request body and an unrecognised one would fall
 * through the branches to whichever arm has no guard on it.
 */
const ACTIONS = ["approve", "reject", "return", "hold", "release"] as const;
type DecisionAction = (typeof ACTIONS)[number];

function readAction(value: unknown): DecisionAction {
  const action = String(value ?? "").trim();
  if ((ACTIONS as readonly string[]).includes(action)) return action as DecisionAction;
  throw new MarketAwarenessError(`${action || "That"} is not a decision this step accepts.`);
}

/** A slot id off the wire is a number or it is nothing — never NaN passed down as a filter. */
function readSlotId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function POST(request: Request, { params }: { params: Promise<{ activityId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { activityId } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const activity = await decideActivity(access, activityId, {
      action: readAction(body.action),
      amendedCost: body.amendedCost ?? null,
      comment: body.comment ?? null,
      slotId: readSlotId(body.slotId),
    });
    return NextResponse.json({ activity, success: true });
  } catch (error) {
    return marketAwarenessErrorResponse(error, "Could not record that decision.");
  }
}
