import { NextResponse } from "next/server";

import { cairoTodayIso } from "@/lib/attendance/working-days";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import {
  loadMarketingFinanceHoldQueue,
  placeMarketingRequestOnFinanceHold,
  releaseMarketingRequestFromFinanceHold,
} from "@/lib/marketing-requests/finance-hold";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function financeHoldApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: clientSafeErrorMessage(error, "Forbidden."),
      status: 403,
    };
  }
  const apiError = toApiError(error, "Marketing finance hold failed.");
  return {
    code: apiError.code === "internal_error" ? "marketing_finance_hold_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

/**
 * The flag half: which approved requests have a late invoice, and which are already held.
 *
 * Read-only. `cairoTodayIso` is resolved HERE and passed down, because the domain rule takes `today`
 * as a parameter so it stays testable without a database — see `classifyMarketingInvoiceOverdue`.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const candidates = await loadMarketingFinanceHoldQueue({ access, today: cairoTodayIso() });
    return NextResponse.json({ candidates });
  } catch (error) {
    const { code, message, status } = financeHoldApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}

/**
 * The decide half: a Super Admin places or releases the hold by hand.
 *
 * Deliberately one route with an explicit `action` rather than an inferred toggle — a toggle would
 * hold a request that a parallel admin had just released, and read as success to both.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => null)) as
      | { action?: unknown; reason?: unknown; requestId?: unknown }
      | null;

    const action = String(body?.action ?? "").trim().toLowerCase();
    const reason = String(body?.reason ?? "");
    const requestId = String(body?.requestId ?? "");

    if (action !== "hold" && action !== "release") {
      return NextResponse.json({
        error: "invalid_action",
        message: 'Action must be "hold" or "release".',
      }, { status: 400 });
    }

    const result = action === "hold"
      ? await placeMarketingRequestOnFinanceHold({ access, reason, requestId })
      : await releaseMarketingRequestFromFinanceHold({ access, reason, requestId });

    return NextResponse.json({ result });
  } catch (error) {
    const { code, message, status } = financeHoldApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
