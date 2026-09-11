import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canManageDistributionLists, distributionListScopeFor } from "@/lib/distribution-lists/access";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { getCompanyEmailAliases, recordAliasMembership, upsertCompanyEmailAlias } from "@/lib/distribution-lists/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Turbify alias register. Super Admin only.
 *
 * Two actions, deliberately separate. `register` says an alias exists and what drives it;
 * `record` says who was on it when a human last looked. Folding them together would let
 * registering an address stamp a membership nobody checked — and every figure here is an
 * attestation, because Turbify has no API and Phoenix can never read a real alias.
 *
 * Nothing on this route sends mail. It changes no mailbox, adds nobody to a real alias, and
 * cannot: the output is a worklist for somebody to apply by hand in the Turbify control panel.
 */
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canManageDistributionLists(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }
    const scope = distributionListScopeFor(access);
    const inScope = (listKey: string | null) => scope === "all" || (listKey != null && scope.has(listKey));

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 20,
      scope: "email-aliases:write",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const aliasAddress = typeof body.aliasAddress === "string" ? body.aliasAddress.trim().toLowerCase() : "";

    if (!aliasAddress.includes("@")) {
      return NextResponse.json({ message: "aliasAddress must be an email address." }, { status: 400 });
    }

    if (action === "register") {
      if (typeof body.label !== "string" || !body.label.trim()) {
        return NextResponse.json({ message: "label must be a non-empty string." }, { status: 400 });
      }
      if (body.provider !== undefined && body.provider !== "turbify" && body.provider !== "other") {
        return NextResponse.json({ message: 'provider must be "turbify" or "other".' }, { status: 400 });
      }
      const listKey = typeof body.distributionListKey === "string" ? body.distributionListKey : null;
      // TWO CHECKS, because this is an UPSERT on the address and one check is not enough.
      //
      // The destination: an alias driven by no list, or by somebody else's, is not hers to point at.
      if (!inScope(listKey)) {
        return NextResponse.json({ message: "Forbidden: that list is not yours." }, { status: 403 });
      }
      // 🔴 AND THE ALIAS AS IT STANDS. Without this, naming an address that ALREADY EXISTS
      // overwrites its distribution_list_key — so re-pointing the finance or closing alias at
      // `hr_team` makes the very field every reader scopes on say it is hers, and its attested
      // Turbify membership becomes visible and writable. The scope predicate must not be a field
      // the caller can write. `record` below already reads the stored row for this reason; this
      // action did not, until review caught it on 2026-09-11.
      if (scope !== "all") {
        const existing = (await getCompanyEmailAliases()).find((row) => row.aliasAddress === aliasAddress);
        if (existing && !inScope(existing.distributionListKey)) {
          return NextResponse.json({ message: "Forbidden: that alias is not yours." }, { status: 403 });
        }
      }
      const alias = await upsertCompanyEmailAlias(
        {
          aliasAddress,
          distributionListKey: listKey,
          isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
          label: body.label,
          notes: typeof body.notes === "string" ? body.notes : undefined,
          provider: body.provider as "turbify" | "other" | undefined,
          purpose: typeof body.purpose === "string" ? body.purpose : undefined,
        },
        access,
      );
      return NextResponse.json({ alias, ok: true });
    }

    if (action === "record") {
      if (!Array.isArray(body.memberEmails) || !body.memberEmails.every((email) => typeof email === "string")) {
        return NextResponse.json({ message: "memberEmails must be an array of strings." }, { status: 400 });
      }
      // Recording membership is judged on the alias as it stands, read back rather than taken from
      // the request — the caller does not get to assert which list an alias belongs to.
      if (scope !== "all") {
        const existing = (await getCompanyEmailAliases()).find((row) => row.aliasAddress === aliasAddress);
        if (!existing || !inScope(existing.distributionListKey)) {
          return NextResponse.json({ message: "Forbidden: that alias is not yours." }, { status: 403 });
        }
      }
      const alias = await recordAliasMembership(aliasAddress, body.memberEmails as string[], access);
      return NextResponse.json({ alias, ok: true });
    }

    return NextResponse.json({ message: 'action must be "register" or "record".' }, { status: 400 });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many alias updates — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, message: clientSafeErrorMessage(error, "Failed to update the email alias register.") },
      { status: 500 },
    );
  }
}
