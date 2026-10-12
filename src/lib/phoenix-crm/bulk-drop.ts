/**
 * Phoenix CRM — deciding many drop requests at once (owner, 2026-10-12: "when the SFE receives the
 * request to drop from reps … he can multi select or select all and drop").
 *
 * Pure, so the Team tab and its test read the same rules. Nothing here decides anything: each selected
 * request is approved through the SAME route its own Approve uses (`/list/requests/decide`), one at a
 * time, so the district-manager-then-SFE steps, the permission check, the rep's notification and the
 * stage race guard are all the single-request ones. A request that cannot be approved is named and the
 * others stand.
 */

import type { PhoenixCrmRequestKind, PhoenixCrmRequestStage } from "@/lib/phoenix-crm/types";

export type BulkDropFacts = {
  requestId: string;
  kind: PhoenixCrmRequestKind;
  status: string;
  stage: PhoenixCrmRequestStage | null;
  canDecide: boolean;
};

/** The bulk bar is offered from two drops up: for one, its own Approve is the same press. */
export const BULK_DROP_FROM = 2;

/** Only a drop that is waiting at THIS viewer's step can be selected — never an add, a grade or a bring-back. */
export function isBulkDroppable(request: Pick<BulkDropFacts, "kind" | "status" | "canDecide">): boolean {
  return request.kind === "drop" && request.status === "pending" && request.canDecide;
}

export function bulkDropTargets<T extends BulkDropFacts>(requests: ReadonlyArray<T>): T[] {
  return requests.filter(isBulkDroppable);
}

/** What is still selected after the list changed under it (a search, a reload, a request decided elsewhere). */
export function pruneSelection(selected: ReadonlySet<string>, requests: ReadonlyArray<BulkDropFacts>): Set<string> {
  const live = new Set(bulkDropTargets(requests).map((request) => request.requestId));
  return new Set([...selected].filter((id) => live.has(id)));
}

/**
 * The body the one decide route takes — the SAME one the card's own Approve sends for a drop (no grade,
 * no potential: those belong to an add). No note: a drop's comment is the rep's, already on the request.
 */
export function bulkDropDecisionBody(request: Pick<BulkDropFacts, "requestId" | "stage">): {
  requestId: string;
  decision: "approve";
  note: null;
  stage: PhoenixCrmRequestStage | null;
  approvedGrade: null;
  potentialGrade: null;
} {
  return { requestId: request.requestId, decision: "approve", note: null, stage: request.stage, approvedGrade: null, potentialGrade: null };
}

/** Why one decision in the bulk did not go through, in the words the card's own refusals use. */
export function bulkDropFailureText(code: string | null, message: string): string {
  if (code === "phoenix_crm_request_decided") return "it was already decided";
  if (code === "phoenix_crm_request_wrong_stage") return "it has moved on to the next step";
  if (code === "phoenix_crm_version_conflict") return "it changed on another screen";
  return message.trim() || "it was not saved";
}

export type BulkDropOutcome =
  | { customerName: string; ok: true; final: boolean }
  | { customerName: string; ok: false; why: string };

/**
 * What the manager is told when the bulk has run: how many went through and, by name, which did not and
 * why. The ones that went through stand — a failure never undoes them. A drop approved at the district
 * manager's step is not off the list yet, so the line says it went on to SFE rather than "dropped".
 */
export function bulkDropNotice(outcomes: ReadonlyArray<BulkDropOutcome>): {
  tone: "info" | "warn" | "bad";
  title: string;
  failures: string[];
} {
  const total = outcomes.length;
  const passed = outcomes.flatMap((outcome) => (outcome.ok ? [outcome] : []));
  const dropped = passed.filter((outcome) => outcome.final).length;
  const forwarded = passed.length - dropped;
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [`${outcome.customerName}: ${outcome.why}.`]));
  const customers = (count: number) => (count === 1 ? "customer" : "customers");
  const done = [
    dropped > 0 ? `${dropped} ${customers(dropped)} dropped from the list` : null,
    forwarded > 0 ? `${forwarded} approved and sent on to SFE` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  if (passed.length === total) return { tone: "info", title: `Approved ${total} drop ${total === 1 ? "request" : "requests"}: ${done}.`, failures };
  if (passed.length === 0) return { tone: "bad", title: `None of the ${total} drop ${total === 1 ? "request" : "requests"} was approved.`, failures };
  return { tone: "warn", title: `Approved ${passed.length} of the ${total} drop requests: ${done}.`, failures };
}
