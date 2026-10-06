import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseCeoEmail } from "@/lib/ceo-email/access";
import {
  CEO_ASSIST_MAX_BODY_CHARS,
  CEO_ASSIST_MAX_INSTRUCTION_CHARS,
  CEO_ASSIST_MAX_SUBJECT_CHARS,
  CeoAssistError,
  composeCeoEmailDraft,
} from "@/lib/ceo-email/assist";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Comfortably past the client's own worst case (OPENAI_ROUTE_BUDGET_MS against up to two attempts),
// so the platform never cuts the request before the timeout and retry logic has resolved it.
export const maxDuration = 150;

/**
 * The assistant. ONE route, and NO `mode` parameter — that absence is the feature.
 *
 * Owner 2026-10-06: *"the assist is perfectly able to understand the ceo if the ceo asked to type he
 * understand if asked to polish he understand"*. So there is nothing here for the browser to tell
 * the server about what was wanted; the assistant reads it, and `src/lib/ceo-email/assist.ts` decides
 * which guard set judges the answer. 🔴 A `mode` accepted here would hand the browser the choice of
 * guard, which is precisely the hole that module's header is written against.
 *
 * It writes nothing, sends nothing and decides nothing: the draft lands back in the same two fields
 * he was already editing, and Undo puts his own words back because they never left the browser.
 *
 * The gate is `canUseCeoEmail`, the same predicate as every other route behind this screen, and not
 * `communication` — that resource also opens the older HR composer, the system email templates and
 * the Telegram console, so it cannot express "this module and nothing else".
 *
 * The limiter is low on purpose: each call holds a server slot for up to a minute of upstream time,
 * and a person writing one letter presses this a handful of times, not twenty.
 */
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canUseCeoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "ceo-email:assist",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await composeCeoEmailDraft({
      bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml.slice(0, CEO_ASSIST_MAX_BODY_CHARS) : "",
      // His own words, typed or dictated — the only place a new fact may come from. Cut at the
      // briefing length, which is higher than the Sato composer's because this box is a microphone.
      instruction:
        typeof body.instruction === "string" ? body.instruction.slice(0, CEO_ASSIST_MAX_INSTRUCTION_CHARS) : "",
      subject: typeof body.subject === "string" ? body.subject.slice(0, CEO_ASSIST_MAX_SUBJECT_CHARS) : "",
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
    if (error instanceof CeoAssistError) {
      const status = error.code === "assist_not_configured" ? 503 : error.code === "assist_rate_limited" ? 429 : 502;
      return NextResponse.json({ message: error.message }, { status });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The draft could not be produced.") },
      { status: 500 },
    );
  }
}
