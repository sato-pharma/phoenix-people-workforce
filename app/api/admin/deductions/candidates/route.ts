import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { assertDeductionsReadActor } from "@/lib/deductions/permissions.ts";
import { loadLiveLeaveBalanceCharges } from "@/lib/deductions/leave-balance-ledger.ts";
import { loadActivePushedLineIdByCandidate } from "@/lib/deductions/pushed-lines.ts";
import { listCandidatesForMonth } from "@/lib/deductions/service.ts";
import { deductionsCategories, type DeductionsCategory } from "@/lib/deductions/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    // Every candidate for the month, for every employee — admin audience only. See the export route.
    assertDeductionsReadActor(access);

    const url = new URL(request.url);
    const monthKey = url.searchParams.get("monthKey");
    if (!monthKey) {
      throw new Error("Validation: monthKey query parameter is required (YYYY-MM).");
    }
    const categoryParam = url.searchParams.get("category");
    const category =
      categoryParam && (deductionsCategories as readonly string[]).includes(categoryParam)
        ? (categoryParam as DeductionsCategory)
        : undefined;

    // The workspace shows, per candidate, whether it is already PUSHED (released
    // to the employee's portal; payroll reads the decision, pushed or not) and — when it is — the active line
    // id needed to withdraw it. `pushedLineId` is null for a not-yet-pushed
    // candidate. Loaded once for the month and joined in memory.
    // Also joined: the deductions currently taken from annual leave, with the comment written for
    // the employee (owner, 2026-10-09). Null for a deduction paid from salary.
    const [candidates, pushedLineByCandidate, leaveBalanceCharges] = await Promise.all([
      listCandidatesForMonth({ monthKey, category, showDisplayNames: true }),
      loadActivePushedLineIdByCandidate(monthKey),
      loadLiveLeaveBalanceCharges(),
    ]);
    const withPushState = candidates.map((candidate) => ({
      ...candidate,
      pushedLineId: pushedLineByCandidate.get(candidate.id) ?? null,
      leaveBalanceCharge: leaveBalanceCharges.get(candidate.id) ?? null,
    }));
    return NextResponse.json({ success: true, candidates: withPushState });
  } catch (error) {
    return jsonError(error, "Failed to load deduction candidates.");
  }
}
