import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadClosingCorrections } from "@/lib/sales/closing-corrections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    // Same boundary as /sales/monthly-closing: the corrections read company-wide sales, so the
    // page is reserved for the admin account. Server-side enforcement — nav visibility is UX only.
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Closing Corrections is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period");
    const data = await loadClosingCorrections({ period });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load Closing Corrections.",
      },
      { status: 500 },
    );
  }
}
