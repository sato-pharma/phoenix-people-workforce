import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { loadPortalCustomerCount } from "@/lib/sales/customer-count-loader";
import { canAccessPortalClosing } from "@/lib/sales/monthly-closing-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The Customer Count dashboard in a manager's portal — his OWN team, published months only (owner,
// 24 Nov 2026: "Managers, own team"). The same gates as the portal Monthly Closing: its role gate,
// sales:read, and the viewer's own closing scope inside the loader, which also refuses a Medical Rep.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!canAccessPortalClosing(access)) {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "read");

    const { searchParams } = new URL(request.url);
    const list = (name: string) => (searchParams.get(name) ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const result = await loadPortalCustomerCount({ access, lines: list("lines"), months: list("months") });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.message }, { status: result.status });
    }
    return NextResponse.json({ success: true, data: result.payload });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to count the customers.") },
      { status: 500 },
    );
  }
}
