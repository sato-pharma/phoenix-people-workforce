import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import { requestRecording } from "@/lib/devices/headwind/recordings";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a screen recording on ONE tablet. Super Admin only (`company_devices:approve`), same-origin.
 *
 * The route is the security boundary; `requestRecording` opens the slot, pushes the record intent to
 * the tablet's launcher and audits it. Calls and messages are never recorded — only the screen.
 *
 * The tablet uploads its capture back to THIS origin, so the record request carries the origin it was
 * made from — in production that is the public domain the console runs on.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const body = (await request.json().catch(() => null)) as
      | { deviceNumber?: unknown; durationSeconds?: unknown }
      | null;
    const deviceNumber = typeof body?.deviceNumber === "string" ? body.deviceNumber : "";
    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;

    const recording = await requestRecording({
      actor,
      deviceNumber,
      durationSeconds: body?.durationSeconds,
      uploadBaseUrl: new URL(request.url).origin,
    });

    return NextResponse.json({
      message: `Recording started on ${recording.assetTag ?? recording.deviceNumber}. The file appears below once the tablet uploads it.`,
      recording,
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not start a recording on that tablet.");
  }
}
