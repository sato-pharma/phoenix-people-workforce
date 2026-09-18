// Open one email from the signed-in person's own Inbox or Sent (marks it read, as webmail does).
// Owner from the session only; the uid can only ever address a message in the caller's own mailbox.

import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { parseFolder, PersonalMailboxError } from "@/lib/personal-mailbox/rules";
import { personalMailboxErrorResponse } from "@/lib/personal-mailbox/route-errors";
import { assertPersonalMailboxCeiling } from "@/lib/personal-mailbox/route-limits";
import { openPersonalMailboxMessage, resolveMailboxOwner } from "@/lib/personal-mailbox/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/messages/mailbox/message";

export async function GET(request: Request) {
  let access: AccessContext | null = null;
  try {
    access = await resolveAccessContext(request);
    const owner = await resolveMailboxOwner(access);
    const url = new URL(request.url);
    const folder = parseFolder(url.searchParams.get("folder"));
    const uid = Number(url.searchParams.get("uid"));
    if (!folder || !Number.isInteger(uid) || uid <= 0) throw new PersonalMailboxError("Unknown email.");
    await assertPersonalMailboxCeiling(owner.key, "read");
    return NextResponse.json(await openPersonalMailboxMessage(owner, folder, uid), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return personalMailboxErrorResponse({ access, error, fallbackMessage: "Could not open that email.", request, route: ROUTE });
  }
}
