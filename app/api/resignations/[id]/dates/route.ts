import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isDevelopment } from "@/lib/env";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  getResignationsDashboardData,
  isResignationDatesKeptFromViewer,
  isResignationsSchemaMissing,
  RESIGNATION_DATES_KEPT_FROM_SEAT_MESSAGE,
  resignationErrorMessage,
  updateResignationDates,
} from "@/lib/resignations/service";
import type { UpdateResignationDatesInput } from "@/lib/resignations/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resignationDatesApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { message: resignationErrorMessage(error), status: 403 };
  }
  if (isResignationsSchemaMissing(error)) {
    return {
      message: isDevelopment ? resignationErrorMessage(error) : "Resignations schema is not ready.",
      status: 409,
    };
  }

  const message = resignationErrorMessage(error);
  if (
    message.toLowerCase().includes("required") ||
    message.toLowerCase().includes("cannot be before")
  ) {
    return { message, status: 400 };
  }

  return { message, status: 500 };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "resignations", "update");
    // Re-dating writes the leaver's last working day, which his final pay is computed from, so the
    // salary-blind seat (the HR Operations Specialist) may not do it although she holds
    // resignations:update to follow the resignation through. Refused before anything is read.
    if (isResignationDatesKeptFromViewer(access)) {
      return NextResponse.json(
        { error: "resignation_dates_kept_from_seat", message: RESIGNATION_DATES_KEPT_FROM_SEAT_MESSAGE },
        { status: 403 },
      );
    }

    const payload = (await request.json()) as {
      dates?: UpdateResignationDatesInput;
      resignation?: UpdateResignationDatesInput;
    } & UpdateResignationDatesInput;
    const dates = payload.dates ?? payload.resignation ?? payload;
    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const updated = await updateResignationDates(id, dates, actor);

    if (!updated) {
      return NextResponse.json(
        { error: "resignation_not_found", message: "Resignation record not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: updated,
      dashboard: await getResignationsDashboardData(access),
    });
  } catch (error) {
    const { message, status } = resignationDatesApiError(error);
    return NextResponse.json({ error: "resignation_dates_update_failed", message }, { status });
  }
}
