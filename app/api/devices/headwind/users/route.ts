import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { headwindErrorResponse } from "@/lib/devices/headwind/http";
import {
  createHeadwindConsoleUser,
  getHeadwindConsoleUsers,
  HeadwindUserError,
  removeHeadwindConsoleUser,
} from "@/lib/devices/headwind/users";
import { hrIdForStorage } from "@/lib/hr-id";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who can sign in to the company's own tablet server.
 *
 * 🔴 NO CREDENTIAL COMES BACK FROM THIS ROUTE IN EITHER DIRECTION OF TRAVEL. GET returns logins and
 * roles; POST takes a password, sends it to Headwind and drops it — it is not returned, not logged and
 * not written into the audit row.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");
    return NextResponse.json(await getHeadwindConsoleUsers(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return headwindErrorResponse(error, "Could not read who can sign in to the tablet server.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "company_devices", "approve");

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const actor =
      hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
    const headers = { "cache-control": "no-store" };

    if (payload.remove === true) {
      return NextResponse.json(
        await removeHeadwindConsoleUser(
          {
            login: typeof payload.login === "string" ? payload.login : "",
            userId: Number(payload.userId),
          },
          actor,
        ),
        { headers },
      );
    }

    const login = typeof payload.login === "string" ? payload.login : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    if (!login) throw new HeadwindUserError("Give the new login a name to sign in with.");

    return NextResponse.json(
      await createHeadwindConsoleUser(
        {
          email: typeof payload.email === "string" ? payload.email : null,
          login,
          name: typeof payload.name === "string" ? payload.name : null,
          password,
          roleId: Number(payload.roleId),
        },
        actor,
      ),
      { headers },
    );
  } catch (error) {
    return headwindErrorResponse(error, "Could not change who can sign in to the tablet server.");
  }
}
