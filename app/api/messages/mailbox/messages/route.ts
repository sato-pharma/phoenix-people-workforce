// One page of the signed-in person's own Inbox or Sent, newest first. Owner from the session only.

import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { parseFolder, PersonalMailboxError } from "@/lib/personal-mailbox/rules";
import { personalMailboxErrorResponse } from "@/lib/personal-mailbox/route-errors";
import { assertPersonalMailboxCeiling } from "@/lib/personal-mailbox/route-limits";
import { listPersonalMailboxFolder, resolveMailboxOwner } from "@/lib/personal-mailbox/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/messages/mailbox/messages";

export async function GET(request: Request) {
  let access: AccessContext | null = null;
  try {
    access = await resolveAccessContext(request);
    const owner = await resolveMailboxOwner(access);
    const url = new URL(request.url);
    const folder = parseFolder(url.searchParams.get("folder") ?? "inbox");
    if (!folder) throw new PersonalMailboxError("Unknown folder.");
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw ? Number(beforeRaw) : null;
    if (before !== null && (!Number.isInteger(before) || before <= 0)) throw new PersonalMailboxError("Unknown page.");
    await assertPersonalMailboxCeiling(owner.key, "read");
    return NextResponse.json(await listPersonalMailboxFolder(owner, folder, before), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return personalMailboxErrorResponse({ access, error, fallbackMessage: "Could not load your email.", request, route: ROUTE });
  }
}
