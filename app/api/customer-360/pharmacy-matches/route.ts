import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { MatchPair } from "@/lib/customer-360/pharmacy-matcher";
import { decidePharmacyMatch, MatchDecisionError, type MatchDecisionInput } from "@/lib/customer-360/server/pharmacy-matches";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Customer 360 — the Super Admin's decision on a pharmacy a rep named on a visit: Confirm this
 * pharmacy, None of these, or Undo.
 *
 * WHO MAY CALL IT. `customer_identity:update`, the Super Admin alone (owner, 2026-10-18: "make another
 * tab in the same module for me, the admin, to confirm it"). The gate is here, before any read.
 *
 * 🔴 IT WRITES ONLY `customer_360_pharmacy_matches` — an annotation the report reads. No visit, no
 * Phoenix CRM customer, no marketing or direct-order row and no identity link is touched.
 */

const ACTIONS = new Set(["confirm", "reject", "undo"]);

function pair(raw: unknown): MatchPair | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { distributorCode?: unknown; customerCode?: unknown; customerName?: unknown; brickId?: unknown };
  const distributorCode = String(value.distributorCode ?? "").trim();
  const customerCode = String(value.customerCode ?? "").trim();
  if (!distributorCode || !customerCode) return null;
  return {
    brickId: typeof value.brickId === "string" && value.brickId.trim() ? value.brickId.trim() : null,
    customerCode,
    customerName: String(value.customerName ?? "").trim(),
    distributorCode,
  };
}

function input(body: Record<string, unknown> | null): MatchDecisionInput | null {
  const action = String(body?.action ?? "");
  const nameKey = String(body?.nameKey ?? "").trim();
  const brickId = String(body?.brickId ?? "").trim();
  if (!ACTIONS.has(action) || !nameKey || !brickId) return null;
  if (action === "undo") return { action, brickId, nameKey };
  const typedExample = String(body?.typedExample ?? "").trim();
  if (action === "reject") return { action, brickId, nameKey, typedExample };
  const pairs = Array.isArray(body?.pairs) ? body.pairs.map(pair).filter((one): one is MatchPair => one !== null) : [];
  if (pairs.length === 0) return null;
  return { action: "confirm", brickId, nameKey, pairs, typedExample };
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "customer_identity", "update");
    const actor = access.hrId ?? access.loginId ?? "";
    if (!actor) return Response.json({ error: "The decision needs a named person behind it." }, { status: 400 });

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const decision = input(body);
    if (!decision) return Response.json({ error: "The decision is incomplete. Reload the page." }, { status: 400 });

    const result = await decidePharmacyMatch(decision, actor);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "Pharmacy matches are decided by the system administrator only." }, { status: 403 });
    }
    if (error instanceof MatchDecisionError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: error instanceof Error ? error.message : "The decision could not be recorded." }, { status: 500 });
  }
}
