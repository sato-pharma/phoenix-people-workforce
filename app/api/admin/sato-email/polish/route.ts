import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canUseSatoEmail } from "@/lib/sato-email/access";
import {
  parseSatoAssistMode,
  polishSatoEmailDraft,
  SATO_ASSIST_MAX_INSTRUCTION_CHARS,
  SATO_POLISH_MAX_BODY_CHARS,
  SATO_POLISH_MAX_SUBJECT_CHARS,
  SatoPolishError,
} from "@/lib/sato-email/polish";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Comfortably past the client's own worst case (OPENAI_ROUTE_BUDGET_MS against up to two attempts),
// so the platform never cuts the request before the timeout and retry logic has resolved it.
export const maxDuration = 150;

/**
 * The composer's assistant: writes the email the sender asked for, or rewrites the one he wrote
 * (`mode`). Sends nothing, saves nothing, decides nothing.
 *
 * The gate is `canUseSatoEmail`, the same predicate as every other route behind this screen, and
 * not `communication` — that resource also opens the older HR composer, the system email templates
 * and the Telegram console, so it cannot express "this module and nothing else".
 *
 * The limiter is low on purpose: each call holds a server slot for up to a minute of upstream time,
 * and a person writing one announcement presses this a handful of times, not twenty.
 */
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canUseSatoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "sato-email:polish",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await polishSatoEmailDraft({
      bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml.slice(0, SATO_POLISH_MAX_BODY_CHARS) : "",
      // The instruction is the only place a write-mode fact can come from, so it is cut at the
      // briefing length, not at the old nudge length — see SATO_ASSIST_MAX_INSTRUCTION_CHARS.
      instruction:
        typeof body.instruction === "string" ? body.instruction.slice(0, SATO_ASSIST_MAX_INSTRUCTION_CHARS) : "",
      mode: parseSatoAssistMode(body.mode),
      subject: typeof body.subject === "string" ? body.subject.slice(0, SATO_POLISH_MAX_SUBJECT_CHARS) : "",
    });

    return NextResponse.json({ result });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { message: "Too many requests to the assistant — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    if (error instanceof SatoPolishError) {
      const status = error.code === "polish_not_configured" ? 503 : error.code === "polish_rate_limited" ? 429 : 502;
      return NextResponse.json({ message: error.message }, { status });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The rewrite could not be produced.") },
      { status: 500 },
    );
  }
}
