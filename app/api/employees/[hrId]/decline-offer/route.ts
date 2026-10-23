import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isEmployeeDirectorySchemaMissing } from "@/lib/employees/employee-directory";
import { isDevelopment } from "@/lib/env";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  declineOfferAndOpenVacancy,
  isResignationsSchemaMissing,
  resignationErrorMessage,
} from "@/lib/resignations/service";
import type { DeclineOfferInput } from "@/lib/resignations/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiError(error: unknown) {
  const message = clientSafeErrorMessage(error, "The declined offer could not be recorded.");
  if (isForbiddenError(error)) {
    return { message: resignationErrorMessage(error), status: 403 };
  }
  if (isResignationsSchemaMissing(error) || isEmployeeDirectorySchemaMissing(error)) {
    return {
      message: isDevelopment
        ? resignationErrorMessage(error)
        : "Resignations or employee schema is not ready.",
      status: 409,
    };
  }
  if (message.toLowerCase().includes("not found")) {
    return {
      message,
      status: 404,
    };
  }
  if (
    message.toLowerCase().includes("required") ||
    message.toLowerCase().includes("cannot be") ||
    message.toLowerCase().includes("must be") ||
    message.toLowerCase().includes("not eligible")
  ) {
    return {
      message,
      status: 400,
    };
  }
  return {
    message,
    status: 500,
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hrId: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { hrId } = await params;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "update");
    await assertPermission(access, "resignations", "create");
    await assertPermission(access, "vacancies", "create");

    const payload = (await request.json()) as {
      declineOffer?: DeclineOfferInput;
    };

    if (!payload.declineOffer) {
      return NextResponse.json(
        { error: "missing_decline_offer", message: "Decline-offer payload is required." },
        { status: 400 },
      );
    }

    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const result = await declineOfferAndOpenVacancy(hrId, payload.declineOffer, actor, access);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "employee_decline_offer_failed", message }, { status });
  }
}
