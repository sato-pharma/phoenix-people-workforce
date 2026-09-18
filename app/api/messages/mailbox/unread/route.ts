// The signed-in person's OWN inbox at a glance — how many emails are unread and the newest few —
// for the envelope's unread count and new-mail alerts. Owner from the session only; read-only.

import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { personalMailboxErrorResponse } from "@/lib/personal-mailbox/route-errors";
import { assertPersonalMailboxCeiling } from "@/lib/personal-mailbox/route-limits";
import { readPersonalMailboxInboxStatus, resolveMailboxOwner } from "@/lib/personal-mailbox/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/messages/mailbox/unread";

export async function GET(request: Request) {
  let access: AccessContext | null = null;
  try {
    access = await resolveAccessContext(request);
    const owner = await resolveMailboxOwner(access);
    await assertPersonalMailboxCeiling(owner.key, "poll");
    return NextResponse.json(await readPersonalMailboxInboxStatus(owner), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return personalMailboxErrorResponse({ access, error, fallbackMessage: "Could not check your email.", request, route: ROUTE });
  }
}
