import { NextResponse } from "next/server";

import { listHeldMappingChanges } from "@/lib/sales/mapping-guard";
import { applyGuardPage } from "@/lib/sales/mapping-guard-sheet";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { assertGuardSheetOwner, guardSheetActor, guardSheetFailure } from "@/lib/sales/mapping-guard-sheet-access";
import { GUARD_APPLY_PAGE_SIZE, type GuardAnswer, type GuardInstruction } from "@/lib/sales/mapping-guard-sheet-shape";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANSWERS: readonly GuardAnswer[] = ["allow", "keep", "move"];

function readInstructions(raw: unknown): GuardInstruction[] | null {
  if (!Array.isArray(raw)) return null;
  const out: GuardInstruction[] = [];
  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const holdId = Number(item.holdId);
    const answer = String(item.answer ?? "") as GuardAnswer;
    if (!Number.isInteger(holdId) || holdId <= 0 || !ANSWERS.includes(answer)) return null;
    out.push({
      answer,
      holdId,
      lock: item.lock === true,
      moveToBrickId: String(item.moveToBrickId ?? "").trim(),
      nowBrickId: String(item.nowBrickId ?? "").trim(),
    });
  }
  return out;
}

/**
 * Write one confirmed page of answers.
 *
 * JSON only, one page at a time (each answer is several database round trips). The server re-plans
 * the page against live state and refuses it unless it is exactly the page that was previewed —
 * `applyGuardPage`. Every answer goes through the guard's own decide path, so the guard's rules still
 * apply to it; nothing here mints a permit or sets a bypass.
 *
 * Super Admin only, server-side, before anything is read or written.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertGuardSheetOwner(access);
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { instructions?: unknown; digest?: unknown; last?: unknown };
    const instructions = readInstructions(body.instructions);
    const digest = String(body.digest ?? "");
    if (!instructions || instructions.length === 0 || !digest) {
      return NextResponse.json({ error: "A confirmed page of answers is required.", success: false }, { status: 400 });
    }
    if (instructions.length > GUARD_APPLY_PAGE_SIZE) {
      return NextResponse.json(
        { error: `Apply at most ${GUARD_APPLY_PAGE_SIZE} answers at a time, so every one is recorded.`, success: false },
        { status: 400 },
      );
    }

    const outcomes = await applyGuardPage({ actor: guardSheetActor(access), digest, instructions });
    const decided = outcomes.filter((outcome) => outcome.ok);

    return NextResponse.json({
      brickMoves: decided
        .filter((outcome) => outcome.brickMove)
        .map((outcome) => ({ brickMove: outcome.brickMove, holdId: outcome.holdId })),
      decided: decided.length,
      failed: outcomes
        .filter((outcome) => !outcome.ok)
        .map((outcome) => ({ customer: outcome.customer, holdId: outcome.holdId, reason: outcome.reason })),
      // Only the last page re-reads the screen's list: it is the one the panel hands back to the review.
      holds: body.last === true ? await listHeldMappingChanges() : undefined,
      locked: decided.filter((outcome) => outcome.locked).length,
      success: true,
      warnings: outcomes
        .filter((outcome) => outcome.ok && outcome.warning)
        .map((outcome) => ({ customer: outcome.customer, holdId: outcome.holdId, warning: outcome.warning })),
    });
  } catch (error) {
    return guardSheetFailure(error, "Could not apply those answers.");
  }
}
