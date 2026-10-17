import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { sentryServerStatus } from "@/lib/observability/sentry-policy";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The server half of the Sentry Check page. After the Super Admin and production checks it THROWS, deliberately and
// outside any try/catch, so Next's own request-error hook (instrumentation.ts onRequestError) reports it exactly as it
// would a real crash. The 500 that comes back is the expected result.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "read");
    if (access.role !== "Super Admin") {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const status = sentryServerStatus({ appEnv: process.env.APP_ENV, dsn: process.env.SENTRY_DSN });
    if (!status.enabled) {
      return NextResponse.json({ message: `Sentry is off here: ${status.reason}.` }, { status: 409 });
    }
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Sentry check failed before it could throw.") },
      { status: 500 },
    );
  }

  throw new Error("Sentry Check: deliberate server test error");
}
