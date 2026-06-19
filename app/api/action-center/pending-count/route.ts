import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { getAwaitingMyActionItems } from "@/lib/action-center/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Actions" sidebar item. Mirrors exactly what the Actions inbox
// shows — marketing excluded, and portal managers counted only on their scoped sources —
// so the badge number never disagrees with the list it links to.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "leave", "read");
    const audience = resolveNavigationMode(access) === "employee-portal" ? "portal" : "admin";
    const items = await getAwaitingMyActionItems(access, audience);
    return NextResponse.json({ count: items.length }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
