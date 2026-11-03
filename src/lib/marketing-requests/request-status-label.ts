/**
 * What to call a marketing request on screen.
 *
 * WHY THIS IS NOT JUST `status.replace("_", " ")`. A request keeps the stored status
 * `pending_approval` from submission right through to the moment Finance records the payment —
 * including the whole stretch after the CEO has signed it off, when there is no approval left to
 * give. The owner read two of his own requests on 19 Aug 2026, both approved by the CEO that
 * afternoon, both still labelled "pending approval", and reasonably concluded they were stuck
 * behind another approver. They were not: they were waiting on Finance to execute.
 *
 * The stored status is deliberately left alone. `pending_approval` is what
 * `decideMarketingRequestWorkflow` and `phx_decide_marketing_request_step` both gate on — moving a
 * request to `approved` when the CEO signs would make Finance Execution un-decidable and strand the
 * money. So the fix is a label, computed from the rung the request is actually sitting on, not a
 * new state.
 *
 * Finance Execution is the only non-approval rung in the chain: it holds `terminal_status = active`
 * and, since the owner's rule of 19 Aug, neither Reject nor Return. Sitting on it means every
 * approval has been given.
 */

/** The step code of the execution rung — the one that is not an approval. */
export const EXECUTION_STEP_CODE = "finance_execution";

/**
 * A held request needs its own words, because the fall-through is actively wrong.
 *
 * `finance_hold` reached the reader as the bare de-underscored "finance hold", which reads like a
 * queue a request is waiting in rather than a decision someone took. It is the opposite: every
 * approval has been given and the money is committed — a human has deliberately frozen the request
 * because the invoice never arrived. Hence the `approved ·` prefix, matching the sibling label
 * one line above.
 *
 * LENGTH IS LOAD-BEARING HERE, and was measured rather than guessed. This badge sits in a
 * `shrink-0` cell beside the requester's name in a `min-w-0 flex-1` cell, so every character it
 * gains is a pixel the name loses. At 375px with the longest real employee name (52 chars,
 * measured in production) the first draft of this label — "approved · held by finance", 26 chars
 * — crushed the name cell to 41px. This wording costs 139px against the 167px the already-shipped
 * "approved · with finance" costs, so it leaves the name MORE room than the status quo, not less.
 *
 * Keep it at or under 18 characters. The full story is in the banner and the lifecycle sentence,
 * which have a whole row each; the badge only has to name the state.
 */
const HELD_LABEL = "approved · on hold";

/** Turn a stored status into the words shown to a human. */
export function marketingRequestStatusLabel(params: {
  /** `stepCode` of the rung currently holding the request, or null when nothing holds it. */
  currentStepCode: string | null | undefined;
  status: string;
}): string {
  const status = String(params.status ?? "").trim();
  if (status === "pending_approval" && params.currentStepCode === EXECUTION_STEP_CODE) {
    return "approved · with finance";
  }
  if (status === "finance_hold") return HELD_LABEL;
  return status.replace(/_/g, " ");
}
