import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  DoctorCoverageConfigValidationError,
  getDoctorCoverageConfig,
  updateDoctorCoverageNorms,
} from "@/lib/crm/doctor-coverage-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Doctor Coverage visit norms (visits per month, per contact kind and grade).
// Gated at crm_visits:update, which only Super Admin and SFE Manager hold — the CEO account is
// deliberately excluded, since it is observational on policy by design.

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visits", "update");
    const config = await getDoctorCoverageConfig();
    return NextResponse.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: String(error) }, { status: 403 });
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visits", "update");

    const body = (await request.json()) as { lineOverrides?: unknown; norms?: unknown };
    const config = await updateDoctorCoverageNorms({
      norms: body?.norms,
      // Absent → stored overrides are left alone. An editor that only touches the norms must not
      // wipe the per-viewer line exceptions as a side effect.
      lineOverrides: body?.lineOverrides,
      actorLoginId: access.loginId ?? access.hrId ?? null,
    });
    return NextResponse.json({ config });
  } catch (error) {
    if (error instanceof DoctorCoverageConfigValidationError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    if (isForbiddenError(error)) return NextResponse.json({ error: String(error) }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
