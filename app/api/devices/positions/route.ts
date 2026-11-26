import { NextResponse } from "next/server";

import {
  PositionAgentError,
  parseReportedFixes,
  readIntroduction,
  recordAgentPositions,
} from "@/lib/devices/positions/agents";
import { logError, logWarning } from "@/lib/observability/log";
import { ApiRateLimitError, assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JOB = "devices/positions";

/** The bearer the agent presents: the token Phoenix handed it once, at its hello. */
function presentedToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/**
 * Where a rep tablet posts its own positions. Server to device, never a browser.
 *
 * 🔴 THE TOKEN IS THE WHOLE CREDENTIAL, AND IT NEVER TRAVELLED THROUGH ANYTHING WORLD-READABLE: it
 * was minted at this install's hello and lives only in the app's private storage. An unknown install
 * and a wrong token answer the same 401. A revoked install answers 403 — that is how a lost or
 * replaced tablet is silenced. An install nobody has bound to a tablet is accepted and its positions
 * are kept, but they belong to no tablet and no rep until a person binds it, so this door hands a
 * stranger no place in anyone's trail.
 *
 * Body: the install's introduction (`installId`, and what the tablet says it is) plus `fixes`, at
 * most 240 of `{lat, lon, ts, accuracyM, batteryLevel, provider, mock}`. A re-sent batch is free: the
 * unique key makes the second copy a no-op rather than a doubled trail, so the agent may always send
 * again when it cannot tell whether the first call arrived.
 *
 * 60 a minute per address: the agent reports every 15 minutes, and sends its backlog in one call.
 */
export async function POST(request: Request) {
  try {
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ request }),
      limit: 60,
      scope: "device_position_report",
      windowMs: 60_000,
    });
  } catch (error) {
    if (error instanceof ApiRateLimitError) {
      return NextResponse.json(
        { error: "rate_limited" },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    logWarning("A tablet position report was refused: the rate limit could not be checked", {
      error,
      labels: { event: "position_report_rate_limit_unavailable", job: JOB },
    });
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }

  const token = presentedToken(request);
  if (!token) return NextResponse.json({ error: "no_token" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const introduction = readIntroduction(body);
    const { fixes, rejected } = parseReportedFixes((body as { fixes?: unknown })?.fixes);
    const result = await recordAgentPositions({ fixes, introduction, rejected, token });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof PositionAgentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logError("A tablet position report could not be stored", {
      error,
      labels: { event: "position_report_failed", job: JOB },
    });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
}
