import { NextResponse } from "next/server";

import { parseBulkPasswordSetupRequest } from "@/lib/admin/access-validation";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { sendPasswordSetupLink } from "@/lib/auth/password-setup";
import { toApiError, unauthorizedError } from "@/lib/http/api-errors";
import { trustedOriginForRedirect } from "@/lib/security/origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-request processing caps. Email is intentionally the smaller number: it
// keeps a single bulk send within the transactional email provider's daily
// budget (Resend free tier is ~100/day) so one click cannot silently exhaust
// the cap and 429 the remainder. Copy mode issues no email, so it only needs a
// sane upper bound. Login ids beyond the cap are reported back as "deferred"
// (not processed) rather than dropped silently.
const MAX_BULK_EMAIL = 100;
const MAX_BULK_COPY = 250;

type BulkResultItem = {
  loginId: string;
  status: "sent" | "failed";
  message: string;
  setupUrl?: string;
};

// The origin used to build every emailed/copied link MUST be an allow-listed
// Phoenix origin — never the raw X-Forwarded-Host (host-header injection).
function requestPublicOrigin(request: Request) {
  return trustedOriginForRedirect(request);
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      throw unauthorizedError();
    }
    await assertPermission(access, "user_admin", "update");
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        { error: "forbidden", message: "Forbidden: only Super Admin can manage user access." },
        { status: 403 },
      );
    }

    const payload = parseBulkPasswordSetupRequest(await request.json());
    const cap = payload.deliveryMode === "email" ? MAX_BULK_EMAIL : MAX_BULK_COPY;
    const withinCap = payload.loginIds.slice(0, cap);
    const deferredLoginIds = payload.loginIds.slice(cap);

    const origin = requestPublicOrigin(request);

    // Sequential on purpose: keeps audit-log ordering deterministic and avoids
    // bursting the email provider. The set is bounded by `cap`. One user's
    // failure (inactive, no email, provider 429, …) never aborts the batch — it
    // is captured per-user so partial success is visible.
    const results: BulkResultItem[] = [];
    for (const loginId of withinCap) {
      try {
        const result = await sendPasswordSetupLink({
          actorLoginId: access.loginId ?? null,
          deliveryMode: payload.deliveryMode,
          governanceReason: payload.governanceReason,
          loginId,
          origin,
          purpose: payload.purpose ?? undefined,
        });
        results.push({
          loginId,
          status: "sent",
          message: result.deliveryMessage,
          ...(result.setupUrl ? { setupUrl: result.setupUrl } : {}),
        });
      } catch (error) {
        results.push({
          loginId,
          status: "failed",
          message: error instanceof Error ? error.message : "Delivery failed.",
        });
      }
    }

    const sent = results.filter((item) => item.status === "sent").length;
    const failed = results.filter((item) => item.status === "failed").length;

    return NextResponse.json(
      {
        deliveryMode: payload.deliveryMode,
        requested: payload.loginIds.length,
        processed: withinCap.length,
        sent,
        failed,
        capped: deferredLoginIds.length,
        cap,
        deferredLoginIds,
        results,
      },
      { status: 201 },
    );
  } catch (error) {
    const apiError = toApiError(error, "Bulk password setup link failed.");
    if (isForbiddenError(error) || apiError.status === 403) {
      return NextResponse.json(
        { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }

    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
