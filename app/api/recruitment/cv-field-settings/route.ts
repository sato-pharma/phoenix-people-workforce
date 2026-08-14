import { NextResponse } from "next/server";

import {
  assertSameOriginMutation,
  bool,
  readJsonObject,
  recruitmentApiError,
  requireRecruitmentAccess,
  str,
} from "@/app/api/recruitment/_lib/http";
import { listCvFieldKeys } from "@/lib/recruitment/cv-field-schemas";
import { isUndisableableCvField, listCvFieldSettingsView, setCvFieldEnabled } from "@/lib/recruitment/cv-field-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The per-field include/exclude switch for CV extraction — see
// src/lib/recruitment/cv-field-settings.ts. Enabled is the default and the table records only
// deviations, so GET always returns the full schema annotated with its current state rather than
// whatever rows happen to exist.
export async function GET(request: Request) {
  try {
    await requireRecruitmentAccess(request, "recruitment", "read");
    const fields = await listCvFieldSettingsView();
    return NextResponse.json({ fields, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to load the CV extraction field settings.");
  }
}

// One field per call. The settings page toggles a single switch at a time, and a per-field write
// means two admins editing different fields never overwrite each other.
export async function PATCH(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await requireRecruitmentAccess(request, "recruitment", "update");
    const body = await readJsonObject(request);

    const fieldKey = str(body.fieldKey);
    if (!fieldKey) {
      return NextResponse.json({ error: "validation", message: "A fieldKey is required.", success: false }, { status: 400 });
    }
    const enabled = bool(body.enabled);
    if (enabled === null) {
      return NextResponse.json(
        { error: "validation", message: "`enabled` must be true or false.", success: false },
        { status: 400 },
      );
    }

    // setCvFieldEnabled enforces both of these itself and is the authority; they are restated at
    // the boundary only so a bad request reads as a 4xx instead of the 500 a thrown Error becomes.
    // Driven off listCvFieldKeys(), so adding a field to the schema never means editing this route.
    if (!listCvFieldKeys().includes(fieldKey)) {
      return NextResponse.json(
        { error: "validation", message: `"${fieldKey}" is not a CV extraction field.`, success: false },
        { status: 400 },
      );
    }
    if (!enabled && isUndisableableCvField(fieldKey)) {
      return NextResponse.json(
        {
          error: "conflict",
          message: `"${fieldKey}" cannot be switched off — candidate matching and duplicate detection depend on it.`,
          success: false,
        },
        { status: 409 },
      );
    }

    await setCvFieldEnabled(fieldKey, enabled, access.hrId);
    return NextResponse.json({ enabled, fieldKey, success: true });
  } catch (error) {
    return recruitmentApiError(error, "Failed to update the CV extraction field setting.");
  }
}
