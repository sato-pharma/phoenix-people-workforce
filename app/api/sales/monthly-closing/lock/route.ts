import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getClosingLock, lockClosing, unlockClosing } from "@/lib/sales/monthly-closing-lock";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only lock gate for the Monthly Closing, sitting beside the publish gate.
//
// Locking freezes a (line, period) so nothing can change its numbers afterwards — not a re-import,
// not a migration, not direct SQL. This route only flips the switch; the enforcement is database
// triggers (migration 20260810140000_monthly_closing_lock), which is what makes the lock hold
// against writers that never touch this API at all.
//
// Same admin gate as publish, deliberately: whoever may release a month to the portal is whoever
// may freeze it.

function forbidNonAdmin(access: Awaited<ReturnType<typeof resolveAccessContext>>) {
  if (access.role !== "Super Admin" && access.scope !== "system") {
    return NextResponse.json(
      { success: false, error: "Forbidden: Locking a closing is restricted to the admin account." },
      { status: 403 },
    );
  }
  return null;
}

function mapError(error: unknown) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { success: false, error: clientSafeErrorMessage(error, "Lock request failed.") },
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
    const lock = await getClosingLock(searchParams.get("line"), searchParams.get("period"));
    return NextResponse.json({ success: true, locked: lock !== null, lock });
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
    const result = await lockClosing({
      actorHrId: resolveEmployeeIdentityId(access),
      line: String(body.line ?? ""),
      period: String(body.period ?? ""),
    });
    // An already-locked month is the state the caller asked for, so it is a 200 that says so —
    // never the 500 "Lock request failed." it used to be (a Publish takes the lock itself).
    if (result.alreadyLocked) {
      return NextResponse.json({ success: true, locked: true, alreadyLocked: true, lock: result.lock, message: result.message });
    }
    return NextResponse.json({ success: true, locked: true, alreadyLocked: false, lock: result.lock });
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

    // No reason is demanded — the owner asked for a switch that is free to use in both directions.
    // A reason may still be supplied by a caller that has one, and is recorded when it is.
    const body = (await request.json()) as { line?: string; period?: string; reason?: string };
    await unlockClosing({
      actorHrId: resolveEmployeeIdentityId(access),
      line: String(body.line ?? ""),
      period: String(body.period ?? ""),
      reason: body.reason ?? null,
    });
    return NextResponse.json({ success: true, locked: false });
  } catch (error) {
    return mapError(error);
  }
}
