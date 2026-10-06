import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseCeoEmail } from "@/lib/ceo-email/access";
import { sendCeoEmail } from "@/lib/ceo-email/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseSatoEmailDraft } from "@/lib/sato-email/draft";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send the letter. 🔴 THE ONE ROUTE ON THIS SCREEN THAT PUTS MAIL IN SOMEBODY'S INBOX.
 *
 * The rate limit is deliberately tight — 5 a minute, the same as the Sato composer's. A send here
 * can reach a hundred people over the chief executive's signature, a sent email cannot be recalled,
 * and nothing a human types needs a sixth attempt inside a minute; a burst on this route is a stuck
 * button or a script, and neither should be allowed to mail the company six times over.
 *
 * Idempotency is the sender's own `clientRequestId`, folded into a per-email key, so a double-click
 * on Send re-sends nothing while a deliberate second send still goes.
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
      limit: 5,
      scope: "ceo-email:send",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = parseSatoEmailDraft(body);
    if ("message" in parsed) return NextResponse.json({ message: parsed.message }, { status: 400 });

    const result = await sendCeoEmail(parsed.draft, access);
    // 200 even for a skipped send: nothing failed, the system declined to mail — email off, no From
    // configured, nobody to reach. The result says which, and the screen shows it. A 500 here would
    // read as "try again", which is the wrong instruction for every one of those reasons.
    return NextResponse.json({ result });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many sends — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json({ message: clientSafeErrorMessage(error, "Failed to send the letter.") }, { status: 500 });
  }
}
