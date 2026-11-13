import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { internalMessageError, internalMessageSignedOut, isSignedOut } from "@/lib/internal-messages/http";
import { markInternalMessageRead } from "@/lib/internal-messages/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (isSignedOut(access)) return internalMessageSignedOut("message_read_failed");
    await assertPermission(access, "internal_messages", "read");
    const { id } = await params;
    return NextResponse.json(await markInternalMessageRead(access, id));
  } catch (error) {
    return internalMessageError(error, "message_read_failed", "Unable to mark message as read.");
  }
}
