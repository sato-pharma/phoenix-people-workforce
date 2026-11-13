/**
 * The one rule for a password a person chooses (changing it, or setting it from a link).
 *
 * At least 8 characters, as before, and not one of the passwords every guessing list tries first: a
 * well-known password, a straight run or one repeated character, the company or a dictionary word
 * dressed up with numbers and symbols ("Phoenix2026!", "P@ssw0rd123", "Sato@123"), or the person's
 * own login id. Every Phoenix sign-in is also throttled per account and per address and locks after
 * repeated failures; this closes the first guesses those limits still allow.
 *
 * Generated passwords (temporary-password.ts, the test accounts) never pass through here.
 */

export const PASSWORD_MIN_LENGTH = 8;

/** Well-known passwords of 8+ characters, lower case (shorter ones already fail the length rule). */
const COMMON_PASSWORDS = new Set([
  "00000000", "11111111", "11223344", "12121212", "12341234", "123123123", "1234567890", "123456789",
  "12345678", "123qweasd", "147258369", "159753258", "1q2w3e4r", "1q2w3e4r5t", "1qaz2wsx", "66666666",
  "87654321", "88888888", "987654321", "a1234567", "aa123456", "abc12345", "abcd1234", "administrator",
  "asdfghjk", "asdfghjkl", "baseball", "football", "iloveyou", "michael1", "princess", "q1w2e3r4",
  "q1w2e3r4t5", "qazwsxedc", "qweasdzxc", "qwertyui", "qwertyuiop", "starwars", "sunshine", "superman",
  "trustno1", "whatever", "zaq12wsx", "zxcvbnm1", "zxcvbnma",
]);

/** Words that, followed or led only by digits and symbols, are the first thing anyone guesses. */
const COMMON_BASE_WORDS = new Set([
  "abc", "abcd", "admin", "cairo", "changeme", "default", "egypt", "hello", "letmein", "login", "love",
  "password", "pass", "pharma", "phoenix", "qwerty", "sato", "satopharma", "test", "user", "welcome",
]);

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };

function isStraightRun(value: string): boolean {
  if (value.length < 4) return false;
  const step = value.charCodeAt(1) - value.charCodeAt(0);
  if (step !== 0 && step !== 1 && step !== -1) return false;
  for (let index = 2; index < value.length; index += 1) {
    if (value.charCodeAt(index) - value.charCodeAt(index - 1) !== step) return false;
  }
  return true;
}

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
  const tooCommon = "This password is too common and easy to guess. Choose one that is not a well-known password or a word followed by numbers.";
  if (COMMON_PASSWORDS.has(lower) || isStraightRun(lower)) return tooCommon;

  const base = baseWord(lower);
  if (COMMON_BASE_WORDS.has(base) || COMMON_PASSWORDS.has(base)) return tooCommon;

  for (const identifier of identifiers) {
    const own = String(identifier ?? "").trim().toLowerCase();
    if (own.length >= 3 && (lower === own || (base.length >= 3 && base === baseWord(own)))) {
      return "The password cannot be your own login id. Choose something only you would know.";
    }
  }
  return null;
}
