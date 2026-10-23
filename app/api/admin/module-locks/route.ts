import { NextResponse } from "next/server";

import { listLockableAccounts, resolveAdministratorName } from "@/lib/auth/module-lock-accounts";
import {
  describeModuleLockRefusalForAccount,
  isLockableModule,
  listModuleLocks,
  lockModuleForAccount,
  releaseModuleLock,
} from "@/lib/auth/module-locks";
import { assertPermission, permissionResources, type PermissionResource } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Temporary module locks — read, place, release.
 *
 * Gated on `admin:update`, which only the Super Admin holds. That is the whole authorisation story
 * and it is enforced here, server-side: the screen hiding a button is UX, this is the boundary.
 */

function failure(error: unknown, code: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({ error: code, message: clientSafeErrorMessage(error, "The module locks could not be updated.") }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    const [accounts, locks] = await Promise.all([listLockableAccounts(), listModuleLocks()]);
    return NextResponse.json({ accounts, active: locks.active, history: locks.history });
  } catch (error) {
    return failure(error, "module_locks_read_failed");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    const body = (await request.json()) as {
      loginId?: string;
      hrId?: string | null;
      moduleKey?: string;
      note?: string | null;
      unlockAt?: string | null;
    };

    const loginId = String(body.loginId ?? "").trim();
    const moduleKey = String(body.moduleKey ?? "").trim() as PermissionResource;

    if (!loginId) {
      return NextResponse.json({ error: "loginId is required" }, { status: 400 });
    }
    if (!permissionResources.includes(moduleKey)) {
      return NextResponse.json({ error: "Unknown module." }, { status: 400 });
    }
    if (!isLockableModule(moduleKey)) {
      return NextResponse.json(
        { error: "That module can never be locked — it is the portal's own entry gate." },
        { status: 400 },
      );
    }

    // An unlock time in the past would be released the moment it was written, which reads on the
    // screen as a lock that silently failed.
    const unlockAt = body.unlockAt ? new Date(body.unlockAt) : null;
    if (unlockAt && (Number.isNaN(unlockAt.getTime()) || unlockAt.getTime() <= Date.now())) {
      return NextResponse.json(
        { error: "The unlock time has to be in the future. Leave it empty to lock until you release it." },
        { status: 400 },
      );
    }

    // The structural refusals — nobody locks their own account, administration is never locked on a
    // Super Admin, Employee Profile is never locked on anyone — are asked HERE as well as inside the
    // service. The service is the boundary; asking first is what turns the refusal into a 400
    // carrying the sentence written for the administrator, instead of a 500 they cannot act on.
    //
    // The target's ROLE is read from the database by this call, never from the request body. It was
    // taken from the body once, and a POST that simply omitted it locked Administration on a live
    // Super Admin account — the exact lockout the guard exists to prevent.
    const refusal = await describeModuleLockRefusalForAccount({
      loginId,
      moduleKey,
      actorLoginId: access.loginId,
    });
    if (refusal) {
      return NextResponse.json({ error: refusal }, { status: 400 });
    }

    const lock = await lockModuleForAccount({
      loginId,
      hrId: body.hrId ?? null,
      moduleKey,
      note: body.note ?? null,
      unlockAt: unlockAt ? unlockAt.toISOString() : null,
      actor: {
        loginId: access.loginId ?? null,
        hrId: access.hrId ?? null,
        name: await resolveAdministratorName(access),
      },
    });

    return NextResponse.json({ lock });
  } catch (error) {
    return failure(error, "module_lock_write_failed");
  }
}

export async function DELETE(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "update");

    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    await releaseModuleLock({
      id,
      actor: {
        loginId: access.loginId ?? null,
        hrId: access.hrId ?? null,
        name: await resolveAdministratorName(access),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return failure(error, "module_lock_release_failed");
  }
}
