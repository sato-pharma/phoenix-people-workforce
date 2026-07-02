import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { setDvCheckboxManual } from "@/lib/probation/feedback-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "probation", "update");

    const body = await request.json();
    const { probationId, field, value } = body as {
      probationId?: number;
      field?: string;
      value?: boolean;
    };

    if (!probationId || !field || typeof value !== "boolean") {
      return NextResponse.json({ error: "probationId, field, and value are required." }, { status: 400 });
    }

    const validFields = ["dm", "nsm", "pm_gpm", "tm"];
    if (!validFields.includes(field)) {
      return NextResponse.json({ error: `field must be one of: ${validFields.join(", ")}` }, { status: 400 });
    }

    await setDvCheckboxManual(access, probationId, field as "dm" | "nsm" | "pm_gpm" | "tm", value);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isForbiddenError(err)) return NextResponse.json({ error: String(err) }, { status: 403 });
    if (err instanceof Error && err.message.includes("Forbidden")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
