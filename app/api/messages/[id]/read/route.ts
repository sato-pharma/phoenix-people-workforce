import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { markInternalMessageRead } from "@/lib/internal-messages/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    const { id } = await params;
    return NextResponse.json(await markInternalMessageRead(access, id));
  } catch (error) {
    return NextResponse.json(
      {
        error: "message_read_failed",
        message: error instanceof Error ? error.message : "Unable to mark message as read.",
      },
      { status: 400 },
    );
  }
}
