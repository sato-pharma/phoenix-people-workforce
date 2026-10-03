import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { countAwaitingMyActionItems } from "@/lib/action-center/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Approvals Hub" sidebar item. Mirrors exactly what the inbox
// shows — marketing excluded, portal managers counted only on their scoped sources —
// so the badge number never disagrees with the list it links to.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "leave", "read");
    const audience = resolveNavigationMode(access) === "employee-portal" ? "portal" : "admin";
    // The same count the inbox list gives, without reading the sources the list then discards.
    const count = await countAwaitingMyActionItems(access, audience);
    return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
