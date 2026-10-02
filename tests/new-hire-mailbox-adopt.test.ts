/**
 * Adopting an existing mailbox — what this file protects.
 *
 * Adoption RESETS the password of a mailbox somebody uses every day. Unlike the joiner flow, which
 * touches only mailboxes it just created, a mistake here locks a working employee out of their mail
 * until a human hands them a new password. So the gates are the feature, and the most important
 * assertion is that nothing outside the explicitly named list is ever touched — there is no queue
 * that could grow into a reset nobody asked for.
 *
 * The second: a mailbox Phoenix can ALREADY read is refused, because adopting it would lock the
 * person out for no gain at all.
 */

import assert from "node:assert/strict";

import {
  ADOPTION_ALLOW_LIST,
  ADOPTION_STEP_ORDER,
  adoptionHandoverNote,
  evaluateAdoption,
  type AdoptionCandidate,
} from "../src/lib/new-hire-mailbox/robot/adopt.ts";

function candidate(overrides: Partial<AdoptionCandidate> = {}): AdoptionCandidate {
  return {
    address: "esraa.awad@satopharma.com",
    displayName: "Esraa Awad",
    hasAppPassword: false,
    hrId: "B-900",
    isActiveEmployee: true,
    taskOpen: true,
    workEmail: "esraa.awad@satopharma.com",
    ...overrides,
  };
}

const NAMED = ["esraa.awad@satopharma.com", "jonia.wageh@satopharma.com"];

export function runNewHireMailboxAdoptTests(): void {
  // The happy path, so every refusal below is attributable to the one thing it changed.
  const ok = evaluateAdoption(candidate(), NAMED);
  assert.equal(ok.allowed, true);
  assert.equal(ok.allowed === true ? ok.address : "", "esraa.awad@satopharma.com");

  // 🔴 THE HEADLINE ASSERTION. Nothing outside the named list is ever touched. This is what stops a
  // reset reaching a mailbox nobody asked about — and a reset locks a working employee out.
  for (const address of ["taha.sheeba@satopharma.com", "ahmed.abdallah@satopharma.com", ""]) {
    const v = evaluateAdoption(candidate({ address, workEmail: address }), NAMED);
    assert.equal(v.allowed, false, `${address || "(blank)"} must not be adopted — it was not named`);
    assert.equal(v.allowed === false ? v.refusal : "", "not_in_named_list");
  }
  // An empty named list adopts NOBODY, whatever the candidate looks like.
  assert.equal(evaluateAdoption(candidate(), []).allowed, false, "an empty list must adopt nobody");
  // And the shipped constant IS empty, so no caller inherits a list by accident.
  assert.deepEqual([...ADOPTION_ALLOW_LIST], [], "the shipped allow-list must be empty");

  // 🔴 A mailbox Phoenix can already read is refused: resetting it would lock the person out for
  // nothing, which is pure harm with no gain.
  const already = evaluateAdoption(candidate({ hasAppPassword: true }), NAMED);
  assert.equal(already.allowed, false);
  assert.equal(already.allowed === false ? already.refusal : "", "already_has_app_password");
  assert.match(already.allowed === false ? already.detail : "", /lock Esraa Awad out for nothing/);

  // The address must be THAT employee's recorded work email — resetting somebody else's mailbox
  // because their address happened to be named is the worst outcome available here.
  const notTheirs = evaluateAdoption(
    candidate({ workEmail: "someone.else@satopharma.com" }),
    NAMED,
  );
  assert.equal(notTheirs.allowed, false);
  assert.equal(notTheirs.allowed === false ? notTheirs.refusal : "", "address_not_theirs");
  const noEmail = evaluateAdoption(candidate({ workEmail: null }), NAMED);
  assert.equal(noEmail.allowed === false ? noEmail.refusal : "", "address_not_theirs");

  // A leaver is the revocation robot's business, not this one's.
  const gone = evaluateAdoption(candidate({ isActiveEmployee: false }), NAMED);
  assert.equal(gone.allowed === false ? gone.refusal : "", "not_an_active_employee");

  // Nothing is asking for it.
  const noTask = evaluateAdoption(candidate({ taskOpen: false }), NAMED);
  assert.equal(noTask.allowed === false ? noTask.refusal : "", "no_open_task");

  // A non-company address is refused even when named.
  const outside = evaluateAdoption(
    candidate({ address: "esraa.awad@gmail.com", workEmail: "esraa.awad@gmail.com" }),
    ["esraa.awad@gmail.com"],
  );
  assert.equal(outside.allowed === false ? outside.refusal : "", "not_a_company_address");

  // Case and surrounding space in the named list do not let one through or keep one out.
  assert.equal(evaluateAdoption(candidate(), ["  ESRAA.AWAD@SATOPHARMA.COM  "]).allowed, true);

  // The order is pinned: the reset comes first, because it is what reopens the window, and the app
  // password is minted last, because it is the only step that cannot be retried later.
  assert.deepEqual([...ADOPTION_STEP_ORDER], ["resetPassword", "setMailboxPassword", "generateAppPassword"]);

  // The hand-over note says the two things the employee must be told, including that changing their
  // password afterwards does NOT break Phoenix — the fact that makes this safe to do at all.
  const note = adoptionHandoverNote("Esraa Awad", "esraa.awad@satopharma.com");
  assert.match(note, /cannot sign in/);
  assert.match(note, /change it straight away/);
  assert.match(note, /app password survives a password change/);
}
