import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  isClosingPublished,
  publishClosing,
  unpublishClosing,
} from "@/lib/sales/monthly-closing-publication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only publish gate for the employee-portal Monthly Closing. Releasing a
// (line, period) lets sales/product managers see that month's closing in their
// portal (scoped to their line / products).

function forbidNonAdmin(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  if (access.role !== "Super Admin" && access.scope !== "system") {
    return NextResponse.json(
      { success: false, error: "Forbidden: Publishing a closing is restricted to the admin account." },
      { status: 403 },
    );
  }
  return null;
}

function mapError(error: unknown) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Forbidden." },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : "Publish request failed." },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const blocked = forbidNonAdmin(access);
    if (blocked) return blocked;
    await assertPermission(access, "sales", "import");

    const { searchParams } = new URL(request.url);
    const published = await isClosingPublished(searchParams.get("line"), searchParams.get("period"));
    return NextResponse.json({ success: true, published });
  } catch (error) {
    return mapError(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const blocked = forbidNonAdmin(access);
    if (blocked) return blocked;
    await assertPermission(access, "sales", "import");

    const body = (await request.json()) as { line?: string; period?: string };
    await publishClosing({
      line: String(body.line ?? ""),
      period: String(body.period ?? ""),
      actorHrId: resolveEmployeeIdentityId(access),
    });
    return NextResponse.json({ success: true, published: true });
  } catch (error) {
    return mapError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const blocked = forbidNonAdmin(access);
    if (blocked) return blocked;
    await assertPermission(access, "sales", "import");

    let line = "";
    let period = "";
    const { searchParams } = new URL(request.url);
    if (searchParams.get("line") || searchParams.get("period")) {
      line = searchParams.get("line") ?? "";
      period = searchParams.get("period") ?? "";
    } else {
      const body = (await request.json().catch(() => ({}))) as { line?: string; period?: string };
      line = String(body.line ?? "");
      period = String(body.period ?? "");
    }
    await unpublishClosing({ line, period });
    return NextResponse.json({ success: true, published: false });
  } catch (error) {
    return mapError(error);
  }
}
