import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createResignation,
  getResignationsDashboardData,
  isResignationsSchemaMissing,
  resignationErrorMessage,
} from "@/lib/resignations/service";
import type { CreateResignationInput } from "@/lib/resignations/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resignationsApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { message: resignationErrorMessage(error), status: 403 };
  }
  if (isResignationsSchemaMissing(error)) {
    return { message: "Resignations schema is not ready.", status: 409 };
  }
  return { message: resignationErrorMessage(error), status: 500 };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "resignations", "read");
    return NextResponse.json(await getResignationsDashboardData());
  } catch (error) {
    const { message, status } = resignationsApiError(error);
    return NextResponse.json({ error: "resignations_load_failed", message }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "resignations", "create");

    const payload = (await request.json()) as {
      resignation?: CreateResignationInput;
    };

    if (!payload.resignation) {
      return NextResponse.json(
        { error: "missing_resignation", message: "Resignation payload is required." },
        { status: 400 },
      );
    }

    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    await createResignation(payload.resignation, actor);
    return NextResponse.json(await getResignationsDashboardData());
  } catch (error) {
    const { message, status } = resignationsApiError(error);
    return NextResponse.json({ error: "resignation_create_failed", message }, { status });
  }
}
