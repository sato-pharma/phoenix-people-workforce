import { validateManualEmailRecipientPolicy } from "@/lib/email/email-safety";

export type SatoTypedAddressPolicy = {
  /** Typed addresses outside the configured company domains. */
  outside: string[];
  /** Why this send may not go yet, or null. */
  problem: string | null;
};

/**
 * Whether the addresses the sender TYPED may go, judged before a single email leaves.
 *
 * 🔴 WHY A TYPED OUTSIDE ADDRESS NEEDS THE SENDER'S OWN REASON, when a list's outside address does
 * not. An outside inbox on a distribution list was decided by whoever saved the list, so naming the
 * list is a truthful justification. A typed address was decided by nobody but the sender, a moment
 * ago — and a mistyped domain is exactly how a company email reaches a stranger. Borrowing the list
 * wording for it would record a reason nobody gave.
 *
 * Refused for the WHOLE send, not batch by batch: the per-batch manual policy would skip only the
 * batch the address landed in and send the rest, which is a partial send nobody chose.
 */
export function satoTypedAddressPolicy(
  emails: readonly string[],
  externalJustification: string | null | undefined,
): SatoTypedAddressPolicy {
  if (emails.length === 0) return { outside: [], problem: null };

  const policy = validateManualEmailRecipientPolicy({ externalJustification, to: [...emails] });
  const outside = policy.externalRecipients;
  const missingReason = policy.issues.some((issue) => issue.code === "external_justification_required");
  if (!missingReason) return { outside, problem: null };

  const noun = outside.length === 1 ? "an address outside the company" : `${outside.length} addresses outside the company`;
  return {
    outside,
    problem: `You typed ${noun} (${outside.join(", ")}). Say why under "Why outside addresses", in at least 10 characters, then preview again.`,
  };
}
