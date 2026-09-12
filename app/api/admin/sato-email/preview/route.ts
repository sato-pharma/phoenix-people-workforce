import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canUseSatoEmail } from "@/lib/sato-email/access";
import { parseSatoEmailDraft } from "@/lib/sato-email/draft";
import { previewSatoEmail } from "@/lib/sato-email/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this email will look like, and exactly who it reaches. Sends nothing.
 *
 * A POST rather than a GET because the draft is a whole email — subject, body, lists, people — and
 * because a body that long has no business in a URL. It is a read as far as the world is concerned:
 * no row is written and no mail leaves, so there is no audit row here either.
 *
 * 🔴 THIS IS THE SCREEN'S ONLY HONEST ANSWER TO "WHO GETS THIS". The count it returns is resolved
 * live from the lists, not estimated from the pickers, and it carries every reason the audience
 * came back short — a refused list, a colleague with no work email. The confirm step prints that
 * count, and the sender presses Send on the strength of it.
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
      limit: 60,
      scope: "sato-email:preview",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = parseSatoEmailDraft(body);
    if ("message" in parsed) return NextResponse.json({ message: parsed.message }, { status: 400 });

    return NextResponse.json({ preview: await previewSatoEmail(parsed.draft) });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many previews — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to build the preview.") },
      { status: 500 },
    );
  }
}
