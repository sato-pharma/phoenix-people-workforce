/**
 * Decide several approvals at once from the approvals inbox — tick, then Approve all or Reject all.
 *
 * Owner request 2026-11-12: "make me able to multi-select and approve", for every approvals inbox.
 * It covers Leave and Excuse, the two inboxes whose single decision is one service call with no
 * extra fields to fill in.
 *
 * WHAT MUST STAY TRUE. A bulk decision is the single decision repeated, never a second set of rules:
 * each request goes through the same service the decision page uses (`decideVacationRequest`,
 * `decideExcuseRequestAsManager`). So the turn check, the "only the assigned manager" rule, the
 * evidence and balance checks, and the deferred notices all apply to every request. It never asks
 * for the stalled-approver override, and it never offers Return (that one needs a request-specific
 * comment). A rejection carries ONE written reason, because the employee reads it. Requests are
 * decided one after another, never in parallel, so two decisions never race on one balance. One
 * failure never stops the rest. The caller gets back, request by request, what happened.
 */
import type { AccessContext } from "@/lib/auth/permissions";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const BULK_DECISION_MAX = 50;

export const BULK_DECISION_MODULES = ["leave", "excuse"] as const;
export type BulkDecisionModule = (typeof BULK_DECISION_MODULES)[number];
export type BulkDecisionVerb = "approve" | "reject";

export type BulkDecisionInput = {
  module: BulkDecisionModule;
  decision: BulkDecisionVerb;
  ids: string[];
  comment: string | null;
};

export type BulkDecisionResult = { id: string; ok: boolean; message: string | null };

export type BulkDecisionDeps = {
  decideLeave: (access: AccessContext, id: string, decision: BulkDecisionVerb, comment: string | null) => Promise<unknown>;
  decideExcuse: (access: AccessContext, id: string, decision: BulkDecisionVerb, comment: string | null) => Promise<unknown>;
};

/** Reads a request body into a bulk decision, or names the one thing wrong with it. */
export function parseBulkDecisionInput(
  body: unknown,
): { ok: true; value: BulkDecisionInput } | { ok: false; message: string } {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const moduleName = raw.module;
  if (typeof moduleName !== "string" || !(BULK_DECISION_MODULES as readonly string[]).includes(moduleName)) {
    return { ok: false, message: "Choose which approvals these are (leave or excuse)." };
  }
  const decision = raw.decision;
  if (decision !== "approve" && decision !== "reject") {
    return { ok: false, message: "A bulk decision is Approve or Reject." };
  }
  if (!Array.isArray(raw.ids)) return { ok: false, message: "Tick at least one request." };
  const ids = Array.from(
    new Set(raw.ids.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean)),
  );
  if (ids.length === 0) return { ok: false, message: "Tick at least one request." };
  if (ids.length > BULK_DECISION_MAX) {
    return { ok: false, message: `Decide at most ${BULK_DECISION_MAX} requests at a time.` };
  }
  const comment = typeof raw.comment === "string" ? raw.comment.trim() || null : null;
  if (decision === "reject" && !comment) {
    return { ok: false, message: "Write the reason for rejecting — the employees read it." };
  }
  return { ok: true, value: { module: moduleName as BulkDecisionModule, decision, ids, comment } };
}

async function defaultDeps(): Promise<BulkDecisionDeps> {
  const [vacation, excuses] = await Promise.all([import("@/lib/vacation/service"), import("@/lib/excuses/service")]);
  return {
    decideLeave: (access, id, decision, comment) =>
      // `override` is never set: a bulk decision only ever answers the viewer's own turn.
      vacation.decideVacationRequest(access, { decision, decisionComment: comment, requestId: id }),
    decideExcuse: (access, id, decision, comment) =>
      excuses.decideExcuseRequestAsManager(access, { comment, decision, requestId: id }),
  };
}

export async function bulkDecideApprovals(
  access: AccessContext,
  input: BulkDecisionInput,
  deps?: BulkDecisionDeps,
): Promise<BulkDecisionResult[]> {
  const resolved = deps ?? (await defaultDeps());
  const decide = input.module === "leave" ? resolved.decideLeave : resolved.decideExcuse;
  const results: BulkDecisionResult[] = [];
  // One after another on purpose — see the header.
  for (const id of input.ids) {
    try {
      await decide(access, id, input.decision, input.comment);
      results.push({ id, message: null, ok: true });
    } catch (error) {
      results.push({ id, message: clientSafeErrorMessage(error, "This request could not be decided."), ok: false });
    }
  }
  return results;
}
