import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadIdentitySuggestions } from "@/lib/customer-identity/server/reads";
import type { IdentityKind } from "@/lib/customer-identity/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Which rows in the four systems MIGHT be the same doctor or the same shop.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `customer_identity:read`, which the matrix grants to the Super Admin alone
 * (owner, 2026-09-30: the system suggests and HE confirms). THE GATE IS HERE, not in the sidebar —
 * `system-navigation.ts` hiding a link is UX. This route reads every customer in Phoenix CRM, the
 * marketing register, the direct-order desk and the iReports360 mirror at once, with no scope
 * narrowing of any kind, which is exactly why it is not a team-scoped surface.
 *
 * It suggests and nothing more: no row is written by a GET here, and no source system is touched
 * by this feature at all.
 */
function kindParam(raw: string | null): IdentityKind | null {
  return raw === "PM" || raw === "AM" || raw === "pharmacy" ? raw : null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "customer_identity", "read");

    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;

    const result = await loadIdentitySuggestions({ kind: kindParam(url.searchParams.get("kind")), limit });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "Customer links are available to the system administrator only." }, { status: 403 });
    }
    return Response.json(
      { error: clientSafeErrorMessage(error, "The suggestions could not be read.") },
      { status: 500 },
    );
  }
}
