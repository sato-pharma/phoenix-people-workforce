import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  DoctorCoverageConfigValidationError,
  getDoctorCoverageConfig,
  updateDoctorCoverageNorms,
} from "@/lib/crm/doctor-coverage-config";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Doctor Coverage visit norms (visits per month, per contact kind and grade).
// Gated at crm_visits:update, which only Super Admin and SFE Manager hold — the CEO account is
// deliberately excluded, since it is observational on policy by design.
//
// NO UI CALLS THIS TODAY. Its only caller was doctor-coverage-norms-editor.tsx, deleted on
// 2026-09-02 with the rest of the retired board's components. The route is left in place
// deliberately: it is registered in src/lib/security/access-registry.ts, it reads and writes the
// live norms that src/lib/crm/doctor-coverage-config.ts still owns, and the rebuild needs exactly
// this endpoint. It is reachable and authorised — treat it as live, not as scaffolding — but be
// aware that a change here currently has no screen to verify against.

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visits", "update");
    const config = await getDoctorCoverageConfig();
    return NextResponse.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: clientSafeErrorMessage(error, "The doctor coverage settings could not be read.") }, { status: 500 });
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
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
