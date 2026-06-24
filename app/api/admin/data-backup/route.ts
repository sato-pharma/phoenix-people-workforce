import { NextResponse, type NextRequest } from "next/server";

import { buildBackupWorkbook, loadDataBackup, type DataBackupScope } from "@/lib/admin/data-backup";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

function normalizeScope(value: string | null): DataBackupScope {
  const normalized = (value ?? "all").toLowerCase().trim();
  if (normalized === "sales" || normalized === "weekly" || normalized === "marketing") {
    return normalized;
  }
  return "all";
}

function normalizeFormat(value: string | null): "xlsx" | "json" {
  return value?.toLowerCase() === "json" ? "json" : "xlsx";
}

function makeFilename(scope: DataBackupScope, format: "xlsx" | "json") {
  const suffix = format === "json" ? "json" : "xlsx";
  const safeScope = scope === "all" ? "all-modules" : scope;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `phoenix-data-backup-${safeScope}-${stamp}.${suffix}`;
}

export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId && !access.hrId) {
      return NextResponse.json({ error: "unauthenticated", message: "Not authenticated." }, { status: 401 });
    }

    assertSystemAdministratorWorkspaceAccess(access, "data-backup");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:admin:data-backup" });

    const params = new URL(request.url).searchParams;
    const scope = normalizeScope(params.get("scope"));
    const format = normalizeFormat(params.get("format"));

    const payload = await loadDataBackup(scope, access.loginId ?? access.hrId ?? "system");
    const filename = makeFilename(scope, format);

    if (format === "json") {
      const text = JSON.stringify(payload);
      return new NextResponse(text, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${filename}"`,
          "content-type": "application/json; charset=utf-8",
        },
      });
    }

    const buffer = await buildBackupWorkbook(payload);
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden" },
        { status: 403 },
      );
    }
    const message = error instanceof Error ? error.message : "Data backup export failed.";
    if (message.includes("Forbidden")) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json({ error: "server_error", message }, { status: 500 });
  }
}
