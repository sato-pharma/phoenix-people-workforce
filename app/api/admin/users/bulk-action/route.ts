import { NextResponse } from "next/server";

import { updateAccessUserStatus } from "@/lib/admin/access-control";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin_access", "update");

    const body = await request.json() as { action?: string; loginIds?: unknown };
    const { action, loginIds } = body;

    if (action !== "enable" && action !== "disable") {
      return NextResponse.json({ message: "Invalid action. Must be 'enable' or 'disable'." }, { status: 400 });
    }
    if (!Array.isArray(loginIds) || loginIds.length === 0) {
      return NextResponse.json({ message: "loginIds must be a non-empty array." }, { status: 400 });
    }
    if (loginIds.length > 100) {
      return NextResponse.json({ message: "Cannot process more than 100 users at once." }, { status: 400 });
    }

    const isActive = action === "enable";
    const actor = {
      hrId: access.hrId ?? null,
      loginId: access.loginId ?? "system",
      role: access.role,
    };

    const results = await Promise.allSettled(
      (loginIds as string[]).map((loginId) =>
        updateAccessUserStatus(loginId, isActive, actor, `Bulk ${action} action`),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results
      .map((r, i) => ({ loginId: (loginIds as string[])[i], result: r }))
      .filter((r) => r.result.status === "rejected")
      .map((r) => ({
        loginId: r.loginId,
        reason: r.result.status === "rejected"
          ? (r.result.reason instanceof Error ? r.result.reason.message : "Unknown error")
          : "",
      }));

    // Return the last successful dashboard snapshot (from the last allSettled result)
    const lastSuccess = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof updateAccessUserStatus>>> => r.status === "fulfilled")
      .pop();

    return NextResponse.json({
      succeeded,
      failed,
      dashboard: lastSuccess?.value ?? null,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Bulk action failed." },
      { status: 500 },
    );
  }
}
