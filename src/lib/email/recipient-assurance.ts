// Recipient Assurance Guard — the last thing that runs before an email is handed to a provider.
//
// Owner requirement (2026-08-08): "before any email goes out from this system it must be 100%
// accurate". What is mechanically provable is WHO the mail is addressed to, and that is exactly
// the class of failure that caused the incident this guard exists for: 67 notifications shipped
// with the intended person in neither To, CC nor BCC, addressed instead to the shared
// phoenix@satopharma.com inbox, every one recorded `sent`. Nothing in the system objected.
//
// What this guard CAN prove, and therefore enforces:
//   • the person the email is FOR is actually addressed in To;
//   • every address is either a known employee, a known internal system inbox, or an address the
//     caller explicitly declared external (candidate, inbound reply);
//   • an address that belongs to nobody never reaches a provider.
//
// What it deliberately does NOT claim: that the CONTENT is factually true. A wrong salary figure
// in the database still produces a correctly-addressed email carrying a wrong number. That is a
// data-quality problem and no send-time gate can decide it — saying otherwise would be a promise
// this cannot keep.
//
// Failure policy (owner's decision, 2026-08-08): AUTO-CORRECT where the right answer is derivable,
// BLOCK only where it is not. Holding was rejected on evidence — the existing confidence gate holds
// correctly and then nothing chases it, which left 8 password resets and 4 account-setup links
// undelivered for a week. A queue nobody drains is indistinguishable from losing the mail.

import { systemEmail } from "@/config/system-settings";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";

export type AssuranceDirectoryEntry = {
  email: string;
  hrId: string;
};

export type RecipientAssuranceInput = {
  bcc?: string[];
  /**
   * The one mailbox a person pressed for, for the person this email is FOR (New Hire Accounts, owner 2026-11-03: "send
   * via private email"). The register's own address, read on the server, never from a request. It answers "is the
   * intended person addressed?" only when it is the WHOLE of To and already declared: a new hire with no Sato mailbox
   * would otherwise be refused, and one with a Sato mailbox would get the link in a mailbox nobody chose.
   */
  chosenMailbox?: string | null;
  cc?: string[];
  /**
   * Addresses the caller states are legitimately outside the employee directory — a job
   * candidate, or the sender of an inbound email being replied to. Required because the owner
   * scoped this guard to ALL mail, including recruitment and manual replies; without an explicit
   * declaration those sends have no way to prove an unknown address was intended.
   */
  declaredExternal?: string[];
  /** HR_ID this email is FOR, when the send is addressed to one specific person. */
  intendedHrId?: string | null;
  /** Internal shared mailboxes that may legitimately appear in To (reply-to, HR inbox). */
  systemInboxes: string[];
  to: string[];
};

export type RecipientAssuranceDecision =
  /** Every address accounted for; send as-is. */
  | { outcome: "pass"; to: string[] }
  /** The intended person was missing from To and has been added or substituted in. */
  | { outcome: "corrected"; correction: string; to: string[] }
  /** Not derivable — refuse the send. */
  | { outcome: "block"; code: AssuranceBlockCode; reason: string };

export type AssuranceBlockCode =
  | "intended_recipient_has_no_address"
  | "no_recipient"
  | "unknown_recipient_address";

function normalize(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeHrId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function uniqueNormalized(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const lc = normalize(value);
    if (!lc || seen.has(lc)) continue;
    seen.add(lc);
    out.push(lc);
  }
  return out;
}

/**
 * Pure decision logic — no Supabase, no env, fully unit-testable. The caller supplies the
 * directory; see resolveAssuranceDirectory for the cached production loader.
 */
export function decideRecipientAssurance(
  input: RecipientAssuranceInput,
  directory: AssuranceDirectoryEntry[],
): RecipientAssuranceDecision {
  const byHrId = new Map<string, string>();
  const knownAddresses = new Set<string>();
  for (const entry of directory) {
    const email = normalize(entry.email);
    const hrId = normalizeHrId(entry.hrId);
    if (!email) continue;
    knownAddresses.add(email);
    // First write wins: an employee's own row is loaded before any alias, so a shared address
    // reused by a second account never steals the mapping from its real owner.
    if (hrId && !byHrId.has(hrId)) byHrId.set(hrId, email);
  }

  const systemInboxes = new Set(uniqueNormalized(input.systemInboxes));
  const declaredExternal = new Set(uniqueNormalized(input.declaredExternal ?? []));
  let to = uniqueNormalized(input.to);

  let correction: string | null = null;
  const intendedHrId = normalizeHrId(input.intendedHrId);
  const chosenMailbox = normalize(input.chosenMailbox);
  const onlyToChosenMailbox = Boolean(chosenMailbox) && to.length === 1 && to[0] === chosenMailbox && (declaredExternal.has(chosenMailbox) || knownAddresses.has(chosenMailbox));
  if (intendedHrId && !onlyToChosenMailbox) {
    const intendedAddress = byHrId.get(intendedHrId) ?? null;
    if (!intendedAddress) {
      // The send names a person the directory cannot reach. Silently mailing the shared inbox
      // instead is precisely the incident — refuse, and let the operator fix the address.
      return {
        code: "intended_recipient_has_no_address",
        outcome: "block",
        reason: `${intendedHrId} has no deliverable address on file, so this email cannot reach the person it is addressed to. Set their work email.`,
      };
    }
    if (!to.includes(intendedAddress)) {
      // Two shapes. If every current To entry is just a shared inbox, that inbox is standing in
      // for the person and must be REPLACED. If real people are already addressed (a workflow
      // envelope with a primary recipient), the intended person is ADDED rather than replacing
      // them — dropping a legitimate recipient would trade one delivery bug for another.
      const onlyInboxes = to.length > 0 && to.every((address) => systemInboxes.has(address));
      if (to.length === 0 || onlyInboxes) {
        correction = `To was ${to.length === 0 ? "empty" : `the shared inbox (${to.join(", ")})`}; replaced with ${intendedHrId}'s address ${intendedAddress}.`;
        to = [intendedAddress];
      } else {
        correction = `${intendedHrId}'s address ${intendedAddress} was missing from To; added.`;
        to = [...to, intendedAddress];
      }
    }
  }

  if (to.length === 0) {
    return { code: "no_recipient", outcome: "block", reason: "The email has no To recipient." };
  }

  // Every address must be accounted for — CC and BCC included, not just To. A wrong CC leaks a
  // payslip or an HR decision to whoever owns that mailbox just as effectively as a wrong To, so
  // scoping this to To only would leave the more damaging half of the problem unguarded. An
  // address belonging to nobody — a typo, a stale hard-coded string, a synthetic login key —
  // must never reach a provider.
  const unaccounted = uniqueNormalized([...to, ...(input.cc ?? []), ...(input.bcc ?? [])]).filter(
    (address) => !knownAddresses.has(address) && !systemInboxes.has(address) && !declaredExternal.has(address),
  );
  if (unaccounted.length > 0) {
    return {
      code: "unknown_recipient_address",
      outcome: "block",
      reason: `${unaccounted.join(", ")} ${unaccounted.length === 1 ? "does" : "do"} not belong to any employee or known inbox, and ${unaccounted.length === 1 ? "was" : "were"} not declared as an external recipient.`,
    };
  }

  if (correction) return { correction, outcome: "corrected", to };
  return { outcome: "pass", to };
}

/**
 * Internal mailboxes that may legitimately be addressed even though no employee owns them.
 * Read from the same config/env the sender itself uses, so the allowlist can never drift out of
 * step with what the system actually puts in From/Reply-To/BCC.
 */
export function resolveSystemInboxes(): string[] {
  const fromEnv = (value: string | undefined) =>
    String(value ?? "")
      .split(/[,\n;]/)
      .map((entry) => entry.trim())
      .filter(Boolean);

  return uniqueNormalized([
    systemEmail.defaultReplyTo,
    systemEmail.defaultFromEmail,
    ...systemEmail.testingRecipientFallback,
    ...fromEnv(process.env.HR_NOTIFICATION_EMAILS),
    ...fromEnv(process.env.NOTIFICATION_REPLY_TO),
    ...fromEnv(process.env.PHOENIX_EMAIL_TEST_RECIPIENTS),
    // The owner's own mailbox: the offers' Reply-To and the Sato composer's (it was also the
    // standing BCC on every automated email until 2026-11-06).
    "omar.anwar@satopharma.com",
  ]);
}

/** One fresh read of the directory (no fallback) — see resolveAssuranceDirectory. */
async function loadAssuranceDirectoryFresh(): Promise<AssuranceDirectoryEntry[]> {
  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const entries: AssuranceDirectoryEntry[] = [];
  for (const row of rows) {
    const email = normalize(row.workEmail);
    if (!email) continue;
    entries.push({ email, hrId: normalizeHrId(row.hrId) });
  }
  return entries;
}

/**
 * How old the last good copy of the directory may be and still stand in when a fresh read fails.
 * The directory changes by hires and leavers — a day-old copy still knows every address that has
 * existed for more than a day, and the guard's job is to recognise addresses, not to be up to the minute.
 */
export const ASSURANCE_DIRECTORY_MAX_STALE_MS = 24 * 60 * 60 * 1000;

/** Thrown when the directory cannot be read AND there is no recent copy: the guard cannot run, so the email is not sent. */
export class RecipientAssuranceUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The Recipient Assurance Guard could not read the employee directory and holds no recent copy of it.");
    this.name = "RecipientAssuranceUnavailableError";
    (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * The directory the guard checks against, with a last-good copy for when the read fails.
 *
 * 23 Oct 2026 audit (Pass 5): on a directory read failure the guard used to send the email UNGUARDED.
 * Now a failed read falls back to the last directory this process read successfully (up to
 * ASSURANCE_DIRECTORY_MAX_STALE_MS old), and with no such copy it FAILS CLOSED — the caller does not
 * send, and an outbox row is retried on its normal schedule (the skip reason is a transient one).
 * `load` and `now` are injectable for the tests.
 */
export function createAssuranceDirectoryReader(
  load: () => Promise<AssuranceDirectoryEntry[]> = loadAssuranceDirectoryFresh,
  now: () => number = Date.now,
) {
  let lastGood: { at: number; entries: AssuranceDirectoryEntry[] } | null = null;
  return async function readAssuranceDirectory(): Promise<AssuranceDirectoryEntry[]> {
    try {
      const entries = await load();
      lastGood = { at: now(), entries };
      return entries;
    } catch (error) {
      if (lastGood && now() - lastGood.at <= ASSURANCE_DIRECTORY_MAX_STALE_MS) return lastGood.entries;
      throw new RecipientAssuranceUnavailableError(error);
    }
  };
}

/**
 * The production reader is built ON FIRST USE, never at import.
 *
 * It used to be constructed at module level, and that one eager call cost the MCP bundle its
 * security guard: a top-level call is a side effect esbuild may not drop, so the statement was
 * retained, and with it its default argument `loadAssuranceDirectoryFresh` -> the employee
 * directory's private `supabaseRest` -> the service-role key and the PostgREST URL. The MCP's
 * `build.mjs` assertion ("Administrative Phoenix IO survived bundling") then failed, and nothing
 * on `main` blocked on it because that workflow only triggers on nine paths. Constructing it
 * lazily keeps the whole administrative chain tree-shakeable while behaving identically: the
 * reader is a per-process singleton either way, and `??=` resolves before any await, so two
 * concurrent first sends still share one last-good copy.
 */
let productionAssuranceDirectoryReader: ReturnType<typeof createAssuranceDirectoryReader> | null = null;

/**
 * Production directory: every address the system is allowed to reach, paired with its owner.
 *
 * Uses the 30-second cached, in-flight-deduped employee directory, so the guard adds no query
 * per email — every DB round trip here is a cross-region hop (Railway `europe-west4` ↔ Supabase
 * `eu-central-1`) and a per-send lookup would be felt. Inactive employees are included
 * deliberately: mail about a leaver (final settlement, resignation acknowledgement) is legitimate,
 * and excluding them would block exactly the workflow that must still run after someone leaves.
 * Throws RecipientAssuranceUnavailableError when neither a fresh read nor a recent copy exists.
 */
export async function resolveAssuranceDirectory(): Promise<AssuranceDirectoryEntry[]> {
  productionAssuranceDirectoryReader ??= createAssuranceDirectoryReader();
  return productionAssuranceDirectoryReader();
}
