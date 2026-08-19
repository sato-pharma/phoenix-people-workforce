export type MarketingDraftBlockerInput = {
  customerId: string;
  estimatedCost: number;
  hasProductWithQuantity: boolean;
  otherRequestType: string;
  requestDate: string;
  requestTypeId: string;
  requiresDescription: boolean;
  roiDurationMonths: string;
  unverifiedCodesMissingReason: number;
};

/**
 * Everything still standing between a marketing request form and a saved draft.
 *
 * The portal used to derive its Save button from a bare boolean and say nothing else, so a
 * requester whose blocker sat above the fold got a dead grey button and no reason at all. On
 * 2026-08-19 District Sales Manager B-154 filled the entire form and could not submit: her
 * customer's only target pharmacy carried distributor code `728843773000`, which the reference
 * database cannot find, that pharmacy is ticked by default, and the justification the gate wants
 * was three screens up.
 *
 * Worth being exact about what she could and could not see, because it is the whole reason this
 * module exists. #2185 shipped the day before, so the pharmacy row DID carry an amber "code not
 * recognised" label and a reason box — the requirement was on screen, just not where she was
 * looking. What said nothing was the Save button itself, and a stuck requester looks at the
 * button. The one message the form could have given ("Complete the draft fields before saving.")
 * lives in the submit handler, which a disabled button never fires, so it was unreachable by
 * construction. Server side there was nothing at all: zero rows in `app_error_events`, zero in
 * `marketing_requests`, because the request never reached the server. The only way to diagnose it
 * was to read the component.
 *
 * So the reasons ARE the gate now: the form derives both the hint and `canSave` from this one
 * list. Two lists would eventually disagree, and a hint claiming nothing is missing beside a Save
 * button that refuses to fire is worse than no hint at all.
 *
 * Ordered the way the fields appear on the form, top to bottom, so the first reason named is also
 * the first one the requester meets scrolling up. Each phrase is kept short on purpose — it
 * renders on one line next to Save on a phone, and this portal neither truncates nor wraps.
 */
export function marketingDraftBlockers(
  input: MarketingDraftBlockerInput,
): string[] {
  const blockers: string[] = [];

  if (!input.customerId) blockers.push("Select a customer");

  // Second because Target Pharmacies is the block directly under the customer select — but also
  // because it is the one gate here whose fix a requester will not guess. The row has said "code
  // not recognised" since #2185, yet the code is already typed and the row already ticked, so
  // nothing there reads as "and Save will refuse until you write down why".
  if (input.unverifiedCodesMissingReason > 0) {
    blockers.push(
      input.unverifiedCodesMissingReason === 1
        ? "Explain the unrecognised pharmacy code"
        : `Explain ${input.unverifiedCodesMissingReason} unrecognised pharmacy codes`,
    );
  }

  if (!input.requestTypeId) blockers.push("Select a request type");
  if (input.requiresDescription && input.otherRequestType.trim().length === 0) {
    blockers.push("Describe the request type");
  }
  if (!input.requestDate) blockers.push("Enter a request date");
  if (!input.roiDurationMonths) blockers.push("Enter an ROI duration");
  if (!(input.estimatedCost > 0)) blockers.push("Enter an estimated cost");
  if (!input.hasProductWithQuantity) blockers.push("Add a product and quantity");

  return blockers;
}

