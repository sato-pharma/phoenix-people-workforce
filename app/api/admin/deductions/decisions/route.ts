import { NextResponse } from "next/server";
import { z } from "zod";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { recordDecision } from "@/lib/deductions/service.ts";
import { deductionsDecisionStatuses } from "@/lib/deductions/types.ts";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Deductions workspace sends two shapes: the Decide buttons (single and bulk)
 * `{ candidateId, decisionStatus, decisionReason, expectedUpdatedAt? }`, and the days editor the same
 * plus `{ hrNote, appliedValue, appliedDates }` (a number — null when the box reads no number — and the
 * ISO days ticked). Every field is optional at this layer so that a key the caller left out stays
 * ABSENT (zod adds no key that was not sent), which is what `has()` below reads. The day list goes to
 * recordDecision as sent; it validates the days itself.
 */
const DecisionBodySchema = z.object({
  candidateId: z.string().nullish(),
  decisionStatus: z.enum(deductionsDecisionStatuses).nullish(),
  decisionReason: z.string().nullish(),
  hrNote: z.string().nullish(),
  appliedValue: z.number().nullish(),
  appliedDates: z.array(z.unknown()).nullish(),
  /** The decision's updated_at the screen read; the save is refused if the row moved since (F-PAY-004). */
  expectedUpdatedAt: z.string().nullish(),
});
type DecisionBody = z.infer<typeof DecisionBodySchema>;

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "approve");

    const parsed = await parseJsonBody(request, DecisionBodySchema);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.message }, { status: 400 });
    }
    const body = parsed.data;
    if (typeof body.candidateId !== "string" || !body.candidateId.trim()) {
      throw new Error("Validation: candidateId is required.");
    }
    if (
      typeof body.decisionStatus !== "string" ||
      !(deductionsDecisionStatuses as readonly string[]).includes(body.decisionStatus)
    ) {
      throw new Error("Validation: decisionStatus is missing or not recognized.");
    }

    // A field the caller never mentioned stays `undefined`, which recordDecision
    // reads as "leave it as it is". Collapsing an absent key to null here is what
    // would let the plain Decide action — which carries no day information —
    // blank out a day selection the reviewer saved a moment earlier.
    const has = (key: keyof DecisionBody) => Object.prototype.hasOwnProperty.call(body, key);
    if (has("expectedUpdatedAt") && body.expectedUpdatedAt !== null && typeof body.expectedUpdatedAt !== "string") {
      throw new Error("Validation: expectedUpdatedAt must be the decision's updated_at, or null.");
    }

    const decision = await recordDecision({
      actor: access,
      candidateId: body.candidateId,
      decisionStatus: body.decisionStatus,
      decisionReason: typeof body.decisionReason === "string" ? body.decisionReason : "",
      hrNote: typeof body.hrNote === "string" ? body.hrNote : undefined,
      appliedValue: has("appliedValue") ? (typeof body.appliedValue === "number" ? body.appliedValue : null) : undefined,
      // Days only — the AMOUNT is never accepted from the caller. recordDecision
      // re-derives it from the candidate the database holds, so a crafted request
      // body cannot set what an employee is charged.
      appliedDates: has("appliedDates") ? (Array.isArray(body.appliedDates) ? body.appliedDates : null) : undefined,
      // Absent: the plain save. Present: a compare-and-set against the revision the screen read.
      expectedUpdatedAt: has("expectedUpdatedAt") ? (body.expectedUpdatedAt ?? null) : undefined,
    });

    return NextResponse.json({ success: true, decision });
  } catch (error) {
    return jsonError(error, "Failed to record deduction decision.");
  }
}
