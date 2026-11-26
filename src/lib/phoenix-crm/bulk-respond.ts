/**
 * Phoenix CRM — answering many list requests at once (owner, 2026-11-27: "make option of multi select and
 * bulk respond"). It widens the bulk drop of 2026-10-12 to every request the viewer decides: tick them, or
 * select them all, then Approve, Refuse or Return them for a comment.
 *
 * Pure, so the Team tab and its test read the same rules. Nothing here decides anything: each chosen
 * request goes through the SAME route its own card uses (`/list/requests/decide`, `/list/requests/return`),
 * one at a time, so the steps, the permission check, the rep's notice and the stage race guard are all the
 * single-request ones. One that cannot be answered is named, and the others stand.
 */

import { setsAdmissionGrades } from "@/lib/phoenix-crm/list-request-rules";
import type { PhoenixCrmRequestKind, PhoenixCrmRequestStage } from "@/lib/phoenix-crm/types";

export type BulkRespondFacts = {
  requestId: string;
  kind: PhoenixCrmRequestKind;
  status: string;
  stage: PhoenixCrmRequestStage | null;
  /** The viewer holds the step it is on. */
  canDecide: boolean;
  /** The Administrator acting in the holder's place (owner, 2026-11-27: "any step any status"). */
  canOverride: boolean;
  /** The viewer may return it to the rep for a comment. */
  canReturn: boolean;
  withRep: boolean;
  /** SFE's step of an add or bring-back whose place still waits on Place checks; the server refuses its approval. */
  placeCheckHold: string | null;
  managerDecision: { at: string } | null;
  /** The customer it is about; two requests on one customer share it. */
  customerKey?: string | null;
};

export type BulkResponse = "approve" | "refuse" | "return";

/** Offered from two requests up: for one, its own buttons are the same press. */
export const BULK_RESPOND_FROM = 2;

/** A request the viewer can answer from its own card: pending, and his step or his to take as the Administrator. */
export function isBulkRespondable(request: Pick<BulkRespondFacts, "status" | "canDecide" | "canOverride">): boolean {
  return request.status === "pending" && (request.canDecide || request.canOverride);
}

export function bulkRespondTargets<T extends BulkRespondFacts>(requests: ReadonlyArray<T>): T[] {
  return requests.filter(isBulkRespondable);
}

/** What is still chosen after the list changed under it (a search, a reload, a request decided elsewhere, the rep filter). */
export function pruneRespondSelection(selected: ReadonlySet<string>, requests: ReadonlyArray<BulkRespondFacts>): Set<string> {
  const live = new Set(bulkRespondTargets(requests).map((request) => request.requestId));
  return new Set([...selected].filter((id) => live.has(id)));
}

/**
 * Why a chosen request is left out of this response, in plain words, or null when it goes. It mirrors the
 * card: an add whose grade and potential are still to be set is graded on its own card, a place on Place
 * checks is approved once the place is decided (the Administrator approves through it), and only a step
 * that can go back to the rep is returned.
 */
export function bulkRespondSkip(request: BulkRespondFacts, response: BulkResponse): string | null {
  if (response === "refuse") return null;
  if (response === "return") {
    return request.canReturn && !request.withRep ? null : request.withRep ? "it is already with the rep" : "it cannot go back to the rep at this step";
  }
  const held = request.canOverride ? null : request.placeCheckHold;
  if (held) return "its place is still on Place checks";
  if (setsAdmissionGrades({ kind: request.kind, stage: request.stage, managerDecidedAt: request.managerDecision?.at ?? null })) {
    return "set its grade and potential on its own card";
  }
  return null;
}

/** The body the card's own Approve or Refuse sends, with the step the screen showed so the race guard still bites. */
export function bulkRespondDecisionBody(
  request: Pick<BulkRespondFacts, "requestId" | "stage">,
  decision: "approve" | "refuse",
  note: string | null,
): {
  requestId: string;
  decision: "approve" | "refuse";
  note: string | null;
  stage: PhoenixCrmRequestStage | null;
  approvedGrade: null;
  potentialGrade: null;
} {
  return { requestId: request.requestId, decision, note, stage: request.stage, approvedGrade: null, potentialGrade: null };
}

/** Refuse and Return need the one note every chosen rep reads; Approve takes none. */
export function bulkRespondNoteProblem(response: BulkResponse, note: string): string | null {
  if (response === "approve" || note.trim()) return null;
  return response === "refuse" ? "Write a note for the reps explaining why." : "Write what you want the reps to explain.";
}

export type BulkRespondOutcome =
  | { customerName: string; ok: true; final: boolean; repeat?: boolean }
  | { customerName: string; ok: false; why: string };

/**
 * What he is told when the run is over: how many went through and, by name, which did not and why. The
 * ones that went through stand. An approval at the district manager's step is not final, so it reads as
 * sent on to SFE.
 */
export function bulkRespondNotice(
  response: BulkResponse,
  outcomes: ReadonlyArray<BulkRespondOutcome>,
): { tone: "info" | "warn" | "bad"; title: string; failures: string[] } {
  const total = outcomes.length;
  const passed = outcomes.flatMap((outcome) => (outcome.ok ? [outcome] : []));
  const repeats = passed.filter((outcome) => outcome.repeat === true).length;
  const decisions = passed.filter((outcome) => outcome.repeat !== true);
  const failures = outcomes.flatMap((outcome) => (outcome.ok ? [] : [`${outcome.customerName}: ${outcome.why}.`]));
  const requests = (count: number) => (count === 1 ? "request" : "requests");
  const verb = response === "approve" ? "Approved" : response === "refuse" ? "Refused" : "Returned";
  const sentOn = response === "approve" ? decisions.filter((outcome) => !outcome.final).length : 0;
  const parts = [
    response === "approve" && sentOn > 0 && sentOn < decisions.length ? `${decisions.length - sentOn} decided` : null,
    sentOn > 0 ? `${sentOn} sent on to SFE` : null,
    response === "return" && decisions.length > 0 ? "each rep is asked for a comment" : null,
    repeats > 0 ? `${repeats} repeat ${requests(repeats)} closed with the customer's drop` : null,
  ].filter((part): part is string => part !== null);
  const tail = parts.length > 0 ? `: ${parts.join(" · ")}` : "";
  if (total === 0) return { tone: "warn", title: "Nothing was chosen.", failures };
  if (passed.length === total) return { tone: "info", title: `${verb} ${decisions.length} ${requests(decisions.length)}${tail}.`, failures };
  if (passed.length === 0) return { tone: "bad", title: `None of the ${total} ${requests(total)} went through.`, failures };
  return { tone: "warn", title: `${verb} ${decisions.length} of the ${total} ${requests(total)}${tail}.`, failures };
}
