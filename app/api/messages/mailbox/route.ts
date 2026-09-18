// The signed-in person's OWN mailbox connection: GET its state, POST an app password to connect,
// DELETE to disconnect. There is no id anywhere in this route — the owner is always the session
// (src/lib/personal-mailbox/service.ts), so nobody can read or change another person's connection.

import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { personalMailboxErrorResponse } from "@/lib/personal-mailbox/route-errors";
import { assertPersonalMailboxCeiling } from "@/lib/personal-mailbox/route-limits";
import {
  connectPersonalMailbox,
  disconnectPersonalMailbox,
  getPersonalMailboxState,
  resolveMailboxOwner,
} from "@/lib/personal-mailbox/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/messages/mailbox";
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  let access: AccessContext | null = null;
  try {
    access = await resolveAccessContext(request);
    const owner = await resolveMailboxOwner(access);
    return NextResponse.json(await getPersonalMailboxState(owner), { headers: NO_STORE });
  } catch (error) {
    return personalMailboxErrorResponse({ access, error, fallbackMessage: "Could not load your email.", request, route: ROUTE });
  }
}

export async function POST(request: Request) {
  let access: AccessContext | null = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    access = await resolveAccessContext(request);
    const owner = await resolveMailboxOwner(access);
    await assertPersonalMailboxCeiling(owner.key, "connect");
    const body = (await request.json().catch(() => ({}))) as { appPassword?: unknown };
    const appPassword = typeof body.appPassword === "string" ? body.appPassword : "";
    return NextResponse.json(await connectPersonalMailbox(owner, appPassword), { headers: NO_STORE });
  } catch (error) {
    return personalMailboxErrorResponse({ access, error, fallbackMessage: "Could not connect your email.", request, route: ROUTE });
  }
}

export async function DELETE(request: Request) {
  let access: AccessContext | null = null;
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    access = await resolveAccessContext(request);
    const owner = await resolveMailboxOwner(access);
    return NextResponse.json(await disconnectPersonalMailbox(owner), { headers: NO_STORE });
  } catch (error) {
    return personalMailboxErrorResponse({ access, error, fallbackMessage: "Could not disconnect your email.", request, route: ROUTE });
  }
}
