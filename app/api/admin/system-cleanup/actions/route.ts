import { NextResponse, type NextRequest } from "next/server";

import {
  executeCleanupAction,
  previewCleanupAction,
  type SystemCleanupMode,
} from "@/lib/admin/system-cleanup";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage, errorMessageOf } from "@/lib/http/api-errors";

function errorStatus(error: unknown) {
  if (isForbiddenError(error)) return 403;
  const message = errorMessageOf(error);
  if (
    message.includes("at least") ||
    message.includes("limited to") ||
    message.includes("must be") ||
    message.includes("Unsupported") ||
    message.includes("required")
  ) {
    return 400;
  }
  return 500;
}

function errorCode(status: number) {
  if (status === 403) return "forbidden";
  if (status === 400) return "invalid_cleanup_action";
  return "cleanup_action_failed";
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const csrfError = assertSameOriginMutation(request);
  if (csrfError) return csrfError;

  try {
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({})) as {
      mode?: SystemCleanupMode;
      reason?: unknown;
      targets?: unknown;
    };
    const mode = body.mode === "execute" ? "execute" : "preview";

    if (mode === "execute") {
      return NextResponse.json(await executeCleanupAction(access, {
        reason: body.reason,
        targets: body.targets,
      }));
    }

    return NextResponse.json(await previewCleanupAction(access, {
      targets: body.targets,
    }));
  } catch (error) {
    const status = errorStatus(error);
    const message = clientSafeErrorMessage(error, "System cleanup action failed.");
    return NextResponse.json({ error: errorCode(status), message }, { status });
  }
}
