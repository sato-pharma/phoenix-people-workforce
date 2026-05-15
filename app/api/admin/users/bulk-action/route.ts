import { NextResponse } from "next/server";

import { updateAccessUserStatus } from "@/lib/admin/access-control";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, unauthorizedError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function assertAuthenticated(access: { hrId: string | null; loginId?: string | null }) {
  if (!access.loginId && !access.hrId) {
    throw unauthorizedError();
  }
}

function parseBulkActionBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object." } as const;
  }
  const payload = body as Record<string, unknown>;
  const action = payload.action;
  const loginIds = payload.loginIds;
  const governanceReason = payload.governanceReason;

  if (action !== "enable" && action !== "disable") {
    return { error: "Invalid action. Must be 'enable' or 'disable'." } as const;
  }
  if (!Array.isArray(loginIds) || loginIds.length === 0) {
    return { error: "loginIds must be a non-empty array." } as const;
  }
  if (loginIds.length > 100) {
    return { error: "Cannot process more than 100 users at once." } as const;
  }
  if (typeof governanceReason !== "undefined" && governanceReason !== null && typeof governanceReason !== "string") {
    return { error: "governanceReason must be a string when provided." } as const;
  }

  const normalizedLoginIds = loginIds.map((loginId) => typeof loginId === "string" ? loginId.trim() : "");
  if (normalizedLoginIds.some((loginId) => !loginId)) {
    return { error: "Every loginId must be a non-empty string." } as const;
  }
  const uniqueLoginIds = Array.from(new Set(normalizedLoginIds));
  if (uniqueLoginIds.length !== normalizedLoginIds.length) {
    return { error: "Duplicate loginIds are not allowed in a bulk action." } as const;
  }

  const reason = governanceReason?.trim();
  if (reason && reason.length > 500) {
    return { error: "governanceReason must be 500 characters or fewer." } as const;
  }

  return {
    action,
    governanceReason: reason || `Bulk ${action} action`,
    loginIds: uniqueLoginIds,
  } as const;
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAuthenticated(access);
    await assertPermission(access, "user_admin", "update");

    const parsed = parseBulkActionBody(await request.json());
    if ("error" in parsed) {
      return NextResponse.json({ error: "invalid_bulk_action", message: parsed.error }, { status: 400 });
    }

    const isActive = parsed.action === "enable";
    const actor = {
      hrId: access.hrId ?? null,
      loginId: access.loginId ?? "system",
      role: access.role,
    };

    const results = await Promise.allSettled(
      parsed.loginIds.map((loginId) =>
        updateAccessUserStatus(loginId, isActive, actor, parsed.governanceReason),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results
      .map((r, i) => ({ loginId: parsed.loginIds[i], result: r }))
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
      action: parsed.action,
      failed,
      failedCount: failed.length,
      governanceReason: parsed.governanceReason,
      succeeded,
      total: parsed.loginIds.length,
      dashboard: lastSuccess?.value ?? null,
    });
  } catch (error) {
    const apiError = toApiError(error, "Bulk action failed.");
    if (isForbiddenError(error) || apiError.status === 403) {
      return NextResponse.json({ error: "forbidden", message: apiError.message }, { status: 403 });
    }
    return NextResponse.json(
      { error: apiError.code, message: apiError.message },
      { status: apiError.status },
    );
  }
}
