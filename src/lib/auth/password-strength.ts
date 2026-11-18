/**
 * The one rule for a password a person chooses (changing it, or setting it from a link).
 *
 * At least 8 characters, and not the person's own login id. Every Phoenix sign-in is also throttled per
 * account and per address and locks after repeated failures, and leaked-password.ts refuses a password
 * found in a published leak.
 *
 * THE "TOO COMMON" RULE IS GONE (owner, 18 Nov 2026: "remove this security shit", then "Just this rule"):
 * a well-known password, a straight run, or a word dressed with digits and symbols ("Phoenix2026!") is no
 * longer refused here. The 8-character floor, the own-login-id rule and the leak check stay.
 *
 * Generated passwords (temporary-password.ts, the test accounts' first one) never pass through here.
 *
 * A TEST ACCOUNT TAKES WHATEVER PASSWORD THE SUPER ADMIN CHOOSES (owner, 17 Nov 2026: "when test account
 * make it normally be as i want"). No length floor, no login-id rule, no leaked-password check — on both
 * doors, changing it and setting it from the link. Only an empty password is still refused.
 */

export const PASSWORD_MIN_LENGTH = 8;

/** False for a test account (`app_auth_users.is_test_persona`): its password is never checked against the rules. */
export function chosenPasswordRulesApply(account: { isTestPersona?: boolean | null }): boolean {
  return account.isTestPersona !== true;
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

/** The word under the decoration: digits and symbols trimmed from both ends, then common swaps undone. */
function baseWord(lower: string): string {
  const trimmed = lower.replace(/^[^a-z@$]+/, "").replace(/[^a-z]+$/, "");
  return trimmed.replace(/[0-9@$!]/g, (character) => LEET[character] ?? character);
}

/**
 * The reason a chosen password is refused, or null when it is acceptable. `identifiers` are the
 * person's own login id and HR id — a password equal to either (decorated or not) is refused.
 */
export function passwordWeakness(password: string, identifiers: Array<string | null | undefined> = []): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;

  const lower = password.toLowerCase();
  const base = baseWord(lower);
  for (const identifier of identifiers) {
    const own = String(identifier ?? "").trim().toLowerCase();
    if (own.length >= 3 && (lower === own || (base.length >= 3 && base === baseWord(own)))) {
      return "The password cannot be your own login id. Choose something only you would know.";
    }
  }
  return null;
}
