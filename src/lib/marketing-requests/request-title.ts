/**
 * The title an approver reads on a marketing request, in the inbox and in its history.
 *
 * Owner audit, 2026-10-26. The heading of a request card was the customer's name, and the line under
 * it read "<type> · From <requester> (<role>)" — three names strung together, none of them saying
 * what the request actually IS. An approver scanning twenty cards had to read all three to find the
 * one that mattered. The title is now the ACTIVITY first, then who raised it; the customer moves to
 * its own labelled line.
 *
 * Pure on purpose: the same two strings are built by the inbox and by the history tab, and a rule
 * that lives in two components is a rule that drifts.
 */

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * What the request is FOR.
 *
 * A request of the generic "Other" type carries the real activity as free text the requester typed
 * ("Work shop minia university pediatric department participating"), and the type name alone —
 * "Other" — tells the approver nothing. So when that text exists it IS the activity; otherwise the
 * type name is.
 */
export function marketingRequestActivity(
  typeName: string | null | undefined,
  otherDescription: string | null | undefined,
): string {
  return clean(otherDescription) ?? clean(typeName) ?? "Marketing request";
}

/** "<activity> — <requester>": the activity, then the person who raised it. */
export function marketingRequestTitle(input: {
  activity: string;
  requesterName: string | null | undefined;
}): string {
  const requester = clean(input.requesterName);
  return requester ? `${input.activity} — ${requester}` : input.activity;
}
