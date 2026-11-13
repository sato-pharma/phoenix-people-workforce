import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  isClosingPublished,
  publishClosing,
  unpublishClosing,
} from "@/lib/sales/monthly-closing-publication";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { SalesWorkflowError } from "@/lib/sales/contracts";

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
  // A refusal with its own status — the stale city split (409, rebuilt, publish again) or a check
  // that could not run (503) — reaches the screen as written, never as a generic 500.
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
  }
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { success: false, error: clientSafeErrorMessage(error, "Publish request failed.") },
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

    // `notify` is opt-OUT and must be the literal boolean false: a missing, null, absent or
    // string-"false" body field publishes loudly, because the caller that forgot to send it is far
    // more likely than the caller that meant silence. Owner, 2026-09-07, republishing August Anti
    // Infective after a correction: "publish aug anti infective but with no email this time".
    const body = (await request.json()) as { line?: string; period?: string; notify?: unknown };
    await publishClosing({
      line: String(body.line ?? ""),
      period: String(body.period ?? ""),
      actorHrId: resolveEmployeeIdentityId(access),
      notify: body.notify === false ? false : true,
    });
    // The CEO/Super-Admin Source-of-Sales BI report auto-fires once every line's monthly
    // closing for this period is published — not inline here (this route is per-line; firing
    // per-line would risk this request's own timeout budget). See
    // runSosMonthlyClosingReportCheck in src/lib/sales/sos-report-delivery.ts, run daily as the
    // morning job `sos-monthly-report-check` (/api/cron/daily/sos-monthly-report-check).
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
    await unpublishClosing({ actorHrId: access.hrId ?? null, line, period });
    return NextResponse.json({ success: true, published: false });
  } catch (error) {
    return mapError(error);
  }
}
