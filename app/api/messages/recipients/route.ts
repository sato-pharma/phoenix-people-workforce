import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { searchInternalMessageRecipients } from "@/lib/internal-messages/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    return NextResponse.json({ data: await searchInternalMessageRecipients(query, access) });
  } catch (error) {
    return NextResponse.json(
      {
        error: "recipient_search_failed",
        message: clientSafeErrorMessage(error, "Recipient search failed."),
      },
      { status: 400 },
    );
  }
}
