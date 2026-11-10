import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { marketingFunctionsErrorResponse, readJsonBody } from "@/lib/marketing-functions/http";
import { saveFieldFeedback } from "@/lib/marketing-functions/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Product Manager saves a Marketing Field Visit Feedback form, or signs it. A signed form is
// locked; the service refuses to change one, and refuses anyone but a Product Manager.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "marketing_field_feedback", "create");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 30,
      scope: "marketing-field-feedback:save",
      windowMs: 60_000,
    });

    const body = await readJsonBody(request);
    const result = await saveFieldFeedback(access, { form: body.form, sign: body.sign === true });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return marketingFunctionsErrorResponse(error, "Failed to save the form.");
  }
}
