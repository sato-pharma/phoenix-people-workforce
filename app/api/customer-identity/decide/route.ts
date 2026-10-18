import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { confirmLinks, ruleNotTheSame, withdrawRuling, type DecisionSide, type LinkDecision } from "@/lib/customer-identity/server/decisions";
import type { EvidenceBand, IdentityKind } from "@/lib/customer-identity/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Super Admin's decision about who a customer IS — confirm a link, rule a pair apart, or
 * withdraw a ruling he made earlier.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. `customer_identity:update`, the Super Admin alone. The gate is here.
 *
 * 🔴 BULK AND BY HAND ARE ONE PATH. `confirm` takes an array whether he pressed one button or
 * selected forty, so there is no bulk route that skips a check the careful one makes — that is
 * how a "confirm all" ends up writing what the single path would have refused.
 *
 * 🔴 IT WRITES ONLY `customer_identity_*`. No `phoenix_crm_*`, `marketing_*`, `direct_order_*` or
 * `crm_*` row is created, altered or merged by any action here: confirming that two rows are one
 * doctor is an annotation, not a merge, and no rep's board changes because of it.
 */

const KINDS = new Set<IdentityKind>(["PM", "AM", "pharmacy"]);
const BANDS = new Set<EvidenceBand>(["fact", "strong", "likely", "possible"]);
// 🔴 EVERY SOURCE THE ENGINE CAN OFFER MUST BE HERE, or the Super Admin's confirmation of a pair
//    it put in front of him is refused as a malformed body — a dead end with no wording to explain
//    it. `visit_feedback` joined on 2026-10-01, `marketing_customer` on 2026-10-18.
const SOURCES = new Set(["phoenix_crm", "marketing", "direct_order", "ireports360", "visit_feedback", "marketing_customer"]);

function side(raw: unknown): DecisionSide | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { source?: unknown; sourceId?: unknown };
  const source = String(value.source ?? "");
  const sourceId = String(value.sourceId ?? "").trim();
  if (!SOURCES.has(source) || !sourceId) return null;
  return { source: source as DecisionSide["source"], sourceId };
}

function decision(raw: unknown): LinkDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { kind?: unknown; band?: unknown; displayName?: unknown; left?: unknown; right?: unknown };
  const kind = String(value.kind ?? "") as IdentityKind;
  const band = String(value.band ?? "") as EvidenceBand;
  const left = side(value.left);
  const right = side(value.right);
  const displayName = String(value.displayName ?? "").trim();
  if (!KINDS.has(kind) || !BANDS.has(band) || !left || !right || !displayName) return null;
  // Two halves of the same row are not a pair, and confirming one would create a master for one
  // row that nothing else can ever join.
  if (left.source === right.source && left.sourceId === right.sourceId) return null;
  return { band, displayName, kind, left, right };
}

export async function POST(request: Request) {
  try {
    // Same-origin only: this route writes a human's decision, so a cross-site POST must never
    // reach it even carrying a valid session cookie.
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "customer_identity", "update");
    const actor = access.hrId ?? access.loginId ?? "";
    if (!actor) return Response.json({ error: "The decision needs a named person behind it." }, { status: 400 });

    const body = (await request.json().catch(() => null)) as { action?: unknown; pairs?: unknown; pairKey?: unknown; reason?: unknown } | null;
    const action = String(body?.action ?? "");

    if (action === "confirm") {
      const decisions = Array.isArray(body?.pairs) ? body.pairs.map(decision).filter((one): one is LinkDecision => one !== null) : [];
      if (decisions.length === 0) return Response.json({ error: "No pair to confirm." }, { status: 400 });
      const result = await confirmLinks(decisions, actor);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "not_the_same") {
      const pairs = Array.isArray(body?.pairs)
        ? body.pairs
            .map((raw) => {
              const one = decision(raw);
              return one ? { kind: one.kind, left: one.left, right: one.right } : null;
            })
            .filter((one): one is { kind: IdentityKind; left: DecisionSide; right: DecisionSide } => one !== null)
        : [];
      if (pairs.length === 0) return Response.json({ error: "No pair to rule on." }, { status: 400 });
      const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
      const result = await ruleNotTheSame(pairs, actor, reason);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "withdraw_ruling") {
      const pairKey = String(body?.pairKey ?? "").trim();
      if (!pairKey) return Response.json({ error: "No ruling named." }, { status: 400 });
      const result = await withdrawRuling(pairKey, actor);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json({ error: "Customer links are available to the system administrator only." }, { status: 403 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "The decision could not be recorded." },
      { status: 500 },
    );
  }
}
