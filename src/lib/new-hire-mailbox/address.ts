/**
 * New hire mailboxes — the company mail domain, and whether an address is on it. Pure: no I/O, so
 * every rule here runs for real in tests/new-hire-mailbox.test.ts.
 *
 * 🔴 THE ADDRESS IS THE ONE THE OWNER TYPES, AND NOTHING HERE DERIVES ONE (owner, 2026-10-03): "I
 * will enter the email of the hired in the employee master in his record, you take what I enter and
 * make his email with it."
 *
 * This module used to generate an address from the name — `mailboxAddressCandidates` and
 * `proposeMailboxAddress`, offering first.second, then first.third, then first.last, measured
 * against the house shape (of 173 company mailboxes on 2026-09-18, 107 were first.second). That
 * shape was right for most people and wrong in a way that reaches the outside world for the rest,
 * because the mailbox robot creates what it is given on a LIVE mail domain: "El Sayed Rady" became
 * `el.sayed@satopharma.com`, splitting a first name that is one word, and the mailbox existed before
 * anybody read the register. Undoing it takes a deletion in the Turbify console.
 *
 * A hire saved without a company work email now opens a task with NO address, and the robot WAITS
 * (`loadJoinerCandidates`). The Employee Master's own field types the local part against a fixed,
 * greyed `@satopharma.com`, so exactly one human decision produces exactly one address.
 *
 * Do not reintroduce a generator, not even "as a suggestion the person can edit" — that is precisely
 * the shape the old one had. `tests/new-hire-mailbox.test.ts` fails if either name comes back.
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
