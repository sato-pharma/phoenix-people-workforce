import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { countVacationAwaiting } from "@/lib/approvals-hub/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Badge count for the "Vacation Approvals" sidebar link — actionable-now items only.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "leave", "read");
    const count = await countVacationAwaiting(access);
    return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
