import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { writeMappingAudit } from "@/lib/sales/mapping-audit";
import { hasAiKey, type AiUnknown } from "@/lib/sales/normalizer/ai-suggest";
import { autoAcceptMin, partitionAutoApply } from "@/lib/sales/normalizer/auto-apply";
import { suggestCustomerBricks } from "@/lib/sales/normalizer/customer-suggest";
import { saveMappings } from "@/lib/sales/normalizer/mapping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// God-mode auto-mapping: runs the full customer suggestion pipeline SERVER-SIDE (propagation →
// AI → geographic scoring — the client never gets to assert a confidence), auto-applies only the
// suggestions that clear the multi-signal gate in auto-apply.ts, and parks the rest for manual
// review. Applied mappings are saved with source='auto', full audit, and historical-row backfill;
// the existing soft-delete on the Mapping Database page is the undo.

const MAX_UNKNOWNS = 300;

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");
    if (!hasAiKey()) {
      return NextResponse.json({ success: false, error: "AI is not configured. Add an OPENAI_API_KEY to enable auto-mapping." }, { status: 400 });
    }

    const body = (await request.json().catch(() => ({}))) as { distributorCode?: string; unknowns?: AiUnknown[] };
    const distributorCode = String(body.distributorCode ?? "").trim();
    if (!distributorCode) return NextResponse.json({ success: false, error: "distributorCode is required." }, { status: 400 });
    const unknowns = (Array.isArray(body.unknowns) ? body.unknowns : []).filter((u) => u && u.raw).slice(0, MAX_UNKNOWNS);
    if (unknowns.length === 0) return NextResponse.json({ success: true, data: { applied: [], parked: [], backfilled: 0 } });

    const actor = access.loginId ?? "system";
    const { suggestions } = await suggestCustomerBricks(unknowns);
    const min = autoAcceptMin();
    const { accepted, parked } = partitionAutoApply(suggestions, min);

    let saved = 0;
    let backfilled = 0;
    if (accepted.length > 0) {
      const result = await saveMappings(
        accepted.map((s) => ({ code: s.code, confidence: s.confidence, distributorCode, raw: s.raw, type: "customer" as const })),
        { backfill: true, mappedBy: actor, source: "auto" },
      );
      saved = result.saved;
      backfilled = result.backfilled;

      await writeAuditLog({
        actorLoginId: actor,
        entityId: "source_of_sales_customer_map",
        entityType: "sales_import_batch",
        newValues: { applied: accepted.length, backfilled, distributor_code: distributorCode, min_confidence: min, parked: parked.length, source: "customer_map_auto_apply" },
        summary: `Auto-map — ${accepted.length} customer mapping(s) applied for ${distributorCode} (gate ≥${min}, ${parked.length} parked, ${backfilled} historical rows healed).`,
      });
      for (const s of accepted) {
        await writeMappingAudit({
          action: "edit",
          actor,
          after: { brick_id: s.code, confidence: s.confidence ?? null, signals: s.signals ?? null, source: "auto", via: s.source },
          distributorCode,
          entityKey: s.raw,
          entityType: "customer_map",
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        applied: accepted.map((s) => ({ code: s.code, confidence: s.confidence, matchedFrom: s.matchedFrom, raw: s.raw, signals: s.signals, source: s.source })),
        backfilled,
        minConfidence: min,
        parked: parked.map((s) => ({ code: s.code, confidence: s.confidence, matchedFrom: s.matchedFrom, raw: s.raw, signals: s.signals, source: s.source })),
        saved,
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Auto-map failed." }, { status: 500 });
  }
}
