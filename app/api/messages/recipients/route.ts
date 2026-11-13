import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { internalMessageError, internalMessageSignedOut, isSignedOut } from "@/lib/internal-messages/http";
import { searchInternalMessageRecipients } from "@/lib/internal-messages/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (isSignedOut(access)) return internalMessageSignedOut("recipient_search_failed");
    await assertPermission(access, "internal_messages", "create");
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    return NextResponse.json({ data: await searchInternalMessageRecipients(query, access) });
  } catch (error) {
    return internalMessageError(error, "recipient_search_failed", "Recipient search failed.");
  }
}
