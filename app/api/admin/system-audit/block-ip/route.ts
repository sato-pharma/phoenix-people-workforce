import { NextResponse, type NextRequest } from "next/server";

import {
  SHARED_ADDRESS_LOOKBACK_DAYS,
  SHARED_ADDRESS_MIN_ACCOUNTS,
  blockIp,
  countRecentSuccessfulAccounts,
  normalizeIpAddress,
  unblockIp,
} from "@/lib/auth/ip-blocklist";
import { writeAuditLog } from "@/lib/admin/audit";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientAddress } from "@/lib/security/client-address";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Blocking/unblocking an IP changes who can authenticate, so this is SUPER ADMIN ONLY.
// CSRF-guarded and audited. Moved here from /api/admin/system-issues/block-ip with that page's
// retirement on 23 Oct 2026; the behaviour is unchanged, except that an expired session now gets a
// 401 instead of a 403.
//
// A BLOCK IS REFUSED, IN WORDS, WHEN IT WOULD BLOCK NOTHING OR THE WRONG PEOPLE (deep audit, 17 Nov
// 2026). The lens flags an address after failed sign-ins on 3 accounts, which an office or a mobile
// network reaches on an ordinary morning, and the block lasts 30 days:
//   · the text must be ONE address (a range, a mask or a typo was saved, shown "Blocked", and matched
//     nobody, because the sign-in check compares exact text) — 400;
//   · never the address the Super Admin is signed in from right now — he would lock himself out — 400;
//   · an address 2 or more different people signed in to successfully in the last 7 days is a shared
//     network — 409 with the count, until the request says `confirmShared: true` (his second press).
// Unblock is unchanged: it removes exactly the text it is given.
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;
    assertSystemAdministratorWorkspaceAccess(access, "the login IP blocklist");

    const body = (await request.json().catch(() => ({}))) as {
      ip?: unknown;
      reason?: unknown;
      days?: unknown;
      action?: unknown;
      confirmShared?: unknown;
    };
    const ip = typeof body.ip === "string" ? body.ip.trim() : "";
    if (!ip) {
      return NextResponse.json({ message: "ip is required." }, { status: 400 });
    }
    const action = body.action === "unblock" ? "unblock" : "block";

    if (action === "unblock") {
      await unblockIp(ip);
      await writeAuditLog({
        actorLoginId: access.loginId ?? null,
        entityId: ip,
        entityType: "auth_session",
        summary: `${access.hrId ?? "admin"} unblocked login IP ${ip}.`,
      });
      return NextResponse.json({ ok: true });
    }

    const address = normalizeIpAddress(ip);
    if (!address) {
      return NextResponse.json(
        {
          error: "invalid_address",
          message: `“${ip.slice(0, 80)}” is not a single internet address, so it was not blocked. Block one address at a time, exactly as the security lens shows it — a range or a mask blocks nobody.`,
        },
        { status: 400 },
      );
    }

    // The caller's address by the edge rule (client-address.ts), never a header read here.
    if (normalizeIpAddress(clientAddress(request)) === address) {
      return NextResponse.json(
        {
          error: "own_address",
          message: "That is the address you are signed in from right now. Blocking it would lock you out too, so it was not blocked.",
        },
        { status: 400 },
      );
    }

    const confirmShared = body.confirmShared === true;
    let successfulAccounts: number | null = null;
    if (!confirmShared) {
      try {
        successfulAccounts = await countRecentSuccessfulAccounts(address);
      } catch (error) {
        // Unchecked is not "nobody": refuse rather than risk blocking an office.
        return NextResponse.json(
          {
            error: "check_unavailable",
            message: `Who else signs in from this address could not be checked, so it was not blocked (${clientSafeErrorMessage(error, "the sign-in record did not answer")}). Try again in a minute.`,
          },
          { status: 503 },
        );
      }
      if (successfulAccounts >= SHARED_ADDRESS_MIN_ACCOUNTS) {
        return NextResponse.json(
          {
            error: "shared_address",
            successfulAccounts,
            message: `${successfulAccounts} people signed in successfully from this address in the last ${SHARED_ADDRESS_LOOKBACK_DAYS} days — it is probably an office or a mobile network. Block it anyway?`,
          },
          { status: 409 },
        );
      }
    }

    const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;
    const days = body.days === null ? null : typeof body.days === "number" ? body.days : undefined;
    await blockIp({ blockedBy: access.hrId, days, ip: address, reason });
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: address,
      entityType: "auth_session",
      newValues: { confirmShared, ip: address, successfulAccounts },
      summary: `${access.hrId ?? "admin"} blocked login IP ${address}${reason ? ` (${reason})` : ""}${confirmShared ? " — confirmed as a shared address after the warning" : ""}.`,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to update IP blocklist.") },
      { status: 500 },
    );
  }
}
