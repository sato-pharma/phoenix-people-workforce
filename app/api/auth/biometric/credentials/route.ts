import { NextResponse } from "next/server";

import { getRequestIp, writeAuthAudit } from "@/lib/auth/audit";
import { resolveSessionState } from "@/lib/auth/server";
import { getCookieValue, phoenixSessionCookieName } from "@/lib/auth/session";
import {
  listActiveCredentialsForLogin,
  revokeCredential,
  toCredentialSummary,
} from "@/lib/auth/webauthn";
import { rejectUntrustedForwardedOrigin } from "@/lib/security/origins";
import { describeUnexpectedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireSessionLoginId(request: Request) {
  const sessionToken = getCookieValue(request.headers.get("cookie"), phoenixSessionCookieName);
  const sessionState = await resolveSessionState(sessionToken, { allowRecentCopy: false });
  return sessionState?.access.loginId ?? null;
}

// Lists the devices the SIGNED-IN person has enrolled. Scoped to their own login_id only — there is
// no parameter here that could widen it to somebody else's devices.
export async function GET(request: Request) {
  try {
    const loginId = await requireSessionLoginId(request);
    if (!loginId) {
      return NextResponse.json(
        { error: "unauthenticated", message: "You must be signed in." },
        { status: 401 },
      );
    }

    const credentials = await listActiveCredentialsForLogin(loginId);
    return NextResponse.json({ credentials: credentials.map(toCredentialSummary) });
  } catch (error) {
    console.error(
      "[auth/biometric/credentials] list failed",
      describeUnexpectedError(error),
    );
    return NextResponse.json(
      { error: "list_failed", message: "Could not load your biometric devices." },
      { status: 500 },
    );
  }
}

// Removes one enrolled device. Mutation, so it carries the origin check that GET does not need.
export async function DELETE(request: Request) {
  try {
    const originRejection = rejectUntrustedForwardedOrigin(request);
    if (originRejection) {
      return NextResponse.json(
        { error: "invalid_origin", message: "Request origin is not trusted." },
        { status: 400 },
      );
    }

    const loginId = await requireSessionLoginId(request);
    if (!loginId) {
      return NextResponse.json(
        { error: "unauthenticated", message: "You must be signed in." },
        { status: 401 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "invalid_request", message: "Request body must be valid JSON." },
        { status: 400 },
      );
    }

    const credentialRowId = (body as Record<string, unknown> | null)?.credentialId;
    if (typeof credentialRowId !== "string" || !credentialRowId.trim()) {
      return NextResponse.json(
        { error: "validation_error", message: "A device must be selected." },
        { status: 400 },
      );
    }

    const removed = await revokeCredential({
      credentialRowId: credentialRowId.trim(),
      loginId,
      reason: "removed_by_user",
    });

    if (!removed) {
      return NextResponse.json(
        { error: "not_found", message: "That device is not enrolled." },
        { status: 404 },
      );
    }

    await writeAuthAudit({
      actorLoginId: loginId,
      entityId: loginId,
      newValues: { credentialRowId: credentialRowId.trim(), ip: getRequestIp(request) },
      summary: "Biometric device removed",
    }).catch(() => undefined);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(
      "[auth/biometric/credentials] delete failed",
      describeUnexpectedError(error),
    );
    return NextResponse.json(
      { error: "delete_failed", message: "Could not remove that device." },
      { status: 500 },
    );
  }
}
