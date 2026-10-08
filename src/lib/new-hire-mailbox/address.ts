/**
 * New hire mailboxes — the company mail domain, whether an address is on it, and the ONE place an
 * address is generated. Pure: no I/O, so every rule here runs for real in
 * tests/new-hire-mailbox.test.ts.
 *
 * ── Two doors, two rules ──
 * 1. HR's Add Employee form and the import: THE ADDRESS IS THE ONE HR TYPES (owner, 2026-10-03: "I
 *    will enter the email of the hired in the employee master in his record, you take what I enter
 *    and make his email with it."). The form types the local part against a fixed, greyed
 *    `@satopharma.com`; a hire saved without one opens a task with NO address and the robot WAITS
 *    (`loadJoinerCandidates`). Nothing here guesses for that door.
 * 2. The candidate's joining form (the offer email's Accept button): THE ADDRESS IS GENERATED, and
 *    when it cannot be, the page SAYS so and HR types it in the mailbox task (owner, 2026-10-08:
 *    "generate it automatically but if it couldn't, it tell it couldn't … and if couldn't the HR can
 *    address manual"). That ruling lifts the 2026-10-03 one for this door only.
 *
 * ── Why the generator refuses rather than guesses ──
 * The old generator (`mailboxAddressCandidates` / `proposeMailboxAddress`, removed 2026-10-03)
 * turned "El Sayed Rady" into `el.sayed@satopharma.com`, splitting a first name that is one word, and
 * the mailbox robot created it on the LIVE domain before anybody read the register — undoing it takes
 * a deletion in the Turbify console. So `joiningFormMailboxAddress` builds only the unambiguous case:
 * two or more plain Latin words, neither of the first two a name particle (El, Al, Abd, Abdel,
 * Abu…). Every other name is "could not", which routes it to a human exactly as a typed-blank hire is
 * routed today. House shape first (of 173 company mailboxes on 2026-09-18, 107 were first.second),
 * first.last when that is taken, and nothing else.
 */

/** The domain every Turbify mailbox the company runs lives on. */
export const COMPANY_MAIL_DOMAIN = "satopharma.com";

/** True for an address on the company's own mail domain, the only kind Turbify hosts for it. */
export function isCompanyAddress(address: string | null | undefined): boolean {
  const value = String(address ?? "").trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0) return false;
  return value.slice(at + 1) === COMPANY_MAIL_DOMAIN && /^[a-z0-9._-]+$/.test(value.slice(0, at));
}

/** Words that are never a whole first or second name on their own — a compound name starts with one. */
const NAME_PARTICLES = new Set([
  "abd",
  "abdal",
  "abdel",
  "abdo",
  "abdul",
  "abo",
  "abu",
  "al",
  "ben",
  "bin",
  "de",
  "el",
  "ibn",
  "van",
  "von",
]);

export type JoiningFormAddress =
  | { address: string; reason: null }
  | { address: null; reason: string };

/**
 * The company address for a joiner who filled in the joining form, or the plain-English reason one
 * could not be built. `taken` is every address already in use or already proposed, lower-case.
 */
export function joiningFormMailboxAddress(
  fullName: string | null | undefined,
  taken: ReadonlySet<string>,
): JoiningFormAddress {
  const raw = String(fullName ?? "").trim();
  if (!raw) return { address: null, reason: "No name was given." };
  if (/[^\x20-\x7E]/.test(raw.replace(/’/g, "'"))) {
    return { address: null, reason: "The name is not written in English letters." };
  }
  const words = raw
    .toLowerCase()
    .split(/[\s-]+/)
    .map((word) => word.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  if (words.length < 2) return { address: null, reason: "A first and a second name are needed." };
  if (NAME_PARTICLES.has(words[0]) || NAME_PARTICLES.has(words[1])) {
    return { address: null, reason: "It is a compound name, so HR will choose the address with you." };
  }
  if (words[0].length < 2 || words[1].length < 2) {
    return { address: null, reason: "The name is too short to build an address from." };
  }

  const shapes = [`${words[0]}.${words[1]}`];
  const last = words[words.length - 1];
  if (words.length >= 3 && last.length >= 2 && !NAME_PARTICLES.has(words[words.length - 2])) {
    shapes.push(`${words[0]}.${last}`);
  }
  for (const local of shapes) {
    const address = `${local}@${COMPANY_MAIL_DOMAIN}`;
    if (isCompanyAddress(address) && !taken.has(address)) return { address, reason: null };
  }
  return { address: null, reason: "The usual address for this name is already in use." };
}
