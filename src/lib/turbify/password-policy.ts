/**
 * Turbify's own password rules for a Business Mail mailbox, checked BEFORE anything is reset.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THIS HAS TO BE CHECKED UP FRONT. The adoption chain is: reset the mailbox → set the company
 * password → read the mailbox. The reset is irreversible in the sense that matters — it rotates the
 * mailbox's password to a one-time one — so if the company password is then REJECTED by Turbify's own
 * form, the mailbox is left reachable only through a one-time password nothing captured. That is the
 * exact state the owner has been handed five times over, and the one thing the module is built to
 * prevent (`evaluateInviteInboxAdoption` already refuses an ABSENT password before the reset for the
 * same reason; a password that is present but cannot be accepted is the same failure wearing a
 * different shape).
 *
 * And it would be invisible: the robot would fill the form, submit it, and find the form still on
 * screen — which reads downstream as "the page never changed", a message about the wrong thing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULES ARE TURBIFY'S, QUOTED FROM THEIR OWN HELP, read 2026-10-03 (article SLN29262, "Reset
 * your business email password", updated 2026-07-29), where it appears five times verbatim:
 *
 *   "Your new password must be between 8 and 20 characters and include an uppercase letter, a
 *    lowercase letter, a number, a special character, and no repeated characters."
 *
 * 🔴 "NO REPEATED CHARACTERS" IS DELIBERATELY **NOT** ENFORCED HERE, AND THAT IS THE CAREFUL CHOICE.
 * Turbify's sentence does not say which it means, and the two readings disagree about ordinary
 * passwords: under "no character twice ANYWHERE" a perfectly good `Company-Pass-1!` fails, and under
 * "not twice CONSECUTIVELY" it fails too (`ss`), while under neither does it look wrong to a human.
 * Enforcing a guess here would REFUSE an adoption Turbify would have accepted — a new blocker
 * invented out of an ambiguity, on a flow whose whole problem has been getting blocked.
 *
 * So this file checks only the five rules that cannot be misread, and the repeated-character rule is
 * answered by the one authority that actually knows: **Turbify's own form.** `setMailboxPassword`
 * reads the error the page shows and reports it verbatim, so whatever the rule really is, the owner
 * is told it in Turbify's words instead of mine. A rejected password is recoverable — the mailbox is
 * left on an outstanding one-time password, which is what `mayBeReset` reports and what the next run
 * resets again — whereas a false refusal stops the work dead on a coin flip.
 *
 * Nothing here logs, returns or interpolates the password. The problems are RULE NAMES, so a refusal
 * can say what is wrong without quoting the secret.
 */

/**
 * A rule the password breaks, phrased for whoever has to go and change the variable.
 *
 * There is deliberately no member for the repeated-character rule — see the header.
 */
export type PasswordProblem =
  | "between 8 and 20 characters"
  | "an uppercase letter"
  | "a lowercase letter"
  | "a number"
  | "a special character";

/**
 * Which of Turbify's UNAMBIGUOUS rules this password breaks. Empty means nothing here can refuse it.
 *
 * The order is Turbify's own wording order, so a refusal reads like their sentence. Empty does NOT
 * promise Turbify will accept it — the repeated-character rule is not judged here on purpose, and
 * the form's own error is what answers that (header).
 */
export function turbifyPasswordProblems(password: string | null | undefined): PasswordProblem[] {
  const value = String(password ?? "");
  const problems: PasswordProblem[] = [];

  if (value.length < 8 || value.length > 20) problems.push("between 8 and 20 characters");
  if (!/[A-Z]/.test(value)) problems.push("an uppercase letter");
  if (!/[a-z]/.test(value)) problems.push("a lowercase letter");
  if (!/[0-9]/.test(value)) problems.push("a number");
  // Anything that is not a letter or a digit. Whitespace is deliberately NOT a special character
  // here: a password with a space in it is a different kind of trouble in a browser form.
  if (!/[^A-Za-z0-9\s]/.test(value)) problems.push("a special character");

  return problems;
}

/**
 * The refusal sentence for a company password Turbify's form is CERTAIN to reject, or `null`.
 *
 * 🔴 Never interpolates the password — only the rules it breaks. And it refuses only on the five
 * rules that cannot be misread, so it can never block an adoption over an ambiguity.
 */
export function turbifyPasswordRefusal(password: string | null | undefined): string | null {
  const problems = turbifyPasswordProblems(password);
  if (problems.length === 0) return null;
  return (
    "PHOENIX_NEW_MAILBOX_INITIAL_PASSWORD cannot be accepted by Turbify, which requires a password "
    + "between 8 and 20 characters including an uppercase letter, a lowercase letter, a number and a "
    + `special character. This one is missing: ${problems.join(", ")}. Nothing was reset — setting a `
    + "password Turbify rejects would leave the mailbox reachable only through a one-time password "
    + "nobody captured."
  );
}
