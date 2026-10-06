import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canUseCeoEmail } from "@/lib/ceo-email/access";
import { previewCeoEmail } from "@/lib/ceo-email/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseSatoEmailDraft } from "@/lib/sato-email/draft";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this letter will look like, and exactly who it reaches. Sends nothing.
 *
 * A POST rather than a GET because the draft is a whole letter — subject, body, lists, people — and
 * a body that long has no business in a URL. It is a read as far as the world is concerned: no row
 * is written and no mail leaves, so there is no audit row here either.
 *
 * 🔴 THE DRAFT IS PARSED BY THE SATO COMPOSER'S OWN READER, and that is deliberate: `preview` and
 * `send` must read a draft IDENTICALLY or the count printed on the confirm step belongs to a
 * different letter from the one that goes out. One reader, shared by both routes on both screens, is
 * the only shape that cannot drift. `signOff` carries the CLOSING LINE here, never a signatory — the
 * name on the letterhead is resolved server-side (src/lib/ceo-email/identity.ts).
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
      limit: 60,
      scope: "ceo-email:preview",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = parseSatoEmailDraft(body);
    if ("message" in parsed) return NextResponse.json({ message: parsed.message }, { status: 400 });

    return NextResponse.json({ preview: await previewCeoEmail(parsed.draft) });
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
