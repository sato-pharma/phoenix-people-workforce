import { NextResponse } from "next/server";

import { PositionAgentError, greetPositionAgent, readIntroduction } from "@/lib/devices/positions/agents";
import { logError, logWarning } from "@/lib/observability/log";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB = "devices/positions/hello";

/**
 * The Phoenix Position agent's first call, from a rep tablet. Server to device, never a browser.
 *
 * 🔴 NO SESSION AND NO SHARED SECRET, FOR THE SAME REASON AS THE RECORDING UPLOAD: a tablet's
 * Headwind configuration is world-readable, so nothing long-lived may be provisioned into the app.
 * The agent mints its own install id, introduces itself here, and Phoenix answers with a token ONCE.
 * What that buys an attacker is nothing: a new install is UNBOUND, so its positions belong to no
 * tablet and appear on no rep's trail until a person binds it (`src/lib/devices/positions/agents.ts`).
 * A second hello for a known install mints no second token, so a leaked install id opens nothing.
 * CSRF has no meaning here — there is no cookie to ride.
 *
 * Ten a minute per address: one install says hello once at first run and then only after a restart.
 */
export async function POST(request: Request) {
  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: 10,
      scope: "device_position_hello",
      windowMs: 60_000,
    });
  } catch (error) {
    if (error instanceof ApiRateLimitError) {
      return NextResponse.json(
        { error: "rate_limited" },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    logWarning("A tablet position agent's hello was refused: the rate limit could not be checked", {
      error,
      labels: { event: "position_agent_rate_limit_unavailable", job: JOB },
    });
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const introduction = readIntroduction(body);
    const result = await greetPositionAgent(introduction);
    return NextResponse.json(result, { status: result.status === "enrolled" ? 201 : 200 });
  } catch (error) {
    if (error instanceof PositionAgentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logError("A tablet position agent's hello could not be answered", {
      error,
      labels: { event: "position_agent_hello_failed", job: JOB },
    });
    return NextResponse.json({ error: "hello_failed" }, { status: 500 });
  }
}
