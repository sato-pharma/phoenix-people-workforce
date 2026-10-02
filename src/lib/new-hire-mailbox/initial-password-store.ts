/**
 * Storing the initial mailbox password, and the one audience allowed to read it back.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS RECOVERABLE AT ALL. Almost every password in this system is a one-way hash, and that
 * is the right default. This one is not, and cannot be: the System Administrator has to read it to
 * hand it to the new joiner, which is the single human act left in the whole provisioning flow. So
 * it is SEALED with secret-box and opened on demand.
 *
 * That makes the gate the whole security boundary, and the gate is this module. Two rules follow
 * from it and neither is negotiable:
 *
 *   1. 🔴 THE CHECK IS SERVER-SIDE AND ROLE-BASED, NEVER A HIDDEN FIELD. Hiding the password in the
 *      UI is UX; anybody can call the route. `assertCanReadInitialPassword` is what actually decides,
 *      and it is called in the route handler before the row is read — not after, and not in the
 *      component.
 *   2. 🔴 NOTHING ELSE MAY OPEN THE SEAL. `revealInitialPassword` is the only path from the sealed
 *      column to a plaintext string, and it takes the viewer's role as an argument so it cannot be
 *      called without one. A caller that has a sealed value and no role has nothing it can do with
 *      it, which is the property that makes an accidental export harmless.
 *
 * The audience is `systemAdministratorRoles` — Super Admin alone. Not HR Advisory, not HR
 * Operations, not the CEO: a company mailbox password opens that person's mail, and the owner's own
 * instruction was the System Administrator account only.
 *
 * The column carries no grant to `anon` or `authenticated` (verified in the catalog on production,
 * 2026-10-02), so even a mistaken PostgREST query from a browser key cannot reach it. Visibility in
 * this app is application-scoped rather than RLS-scoped, so that absence of a grant plus this gate
 * are the protection — there is no policy quietly backing them up.
 */

import { systemAdministratorRoles, type PhoenixRole } from "@/lib/auth/permissions";
import { openSecret, sealSecret } from "@/lib/security/secret-box";

import { isUsableInitialPassword, explainUnusableInitialPassword } from "./robot/initial-password";

/**
 * The secret-box context this password is sealed under.
 *
 * Secret-box derives a different key per context, so a blob sealed here fails the GCM tag check in
 * the mailbox monitor's `openSecret` and in the personal-mailbox path, and theirs fail here — even
 * if a value were ever copied from one table into another. Three kinds of mailbox credential now
 * live in this database and none of them should be able to open another's.
 */
export const NEW_HIRE_INITIAL_PASSWORD_SECRET_CONTEXT = "new-hire-initial-password" as const;

const SEAL_OPTIONS = { context: NEW_HIRE_INITIAL_PASSWORD_SECRET_CONTEXT } as const;

export class InitialPasswordForbiddenError extends Error {
  readonly role: string;
  constructor(role: string) {
    super(
      `The initial mailbox password is readable by the System Administrator only, and this request `
      + `came from "${role || "no role"}". Nothing was read.`,
    );
    this.name = "InitialPasswordForbiddenError";
    this.role = role;
  }
}

export class InitialPasswordUnusableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "InitialPasswordUnusableError";
  }
}

/** The only roles that may ever see a mailbox password. Super Admin alone. */
export function canReadInitialPassword(role: string | null | undefined): boolean {
  const viewer = String(role ?? "");
  return (systemAdministratorRoles as readonly string[]).includes(viewer);
}

/**
 * Refuse any viewer that is not the System Administrator.
 *
 * Throws rather than returning a boolean so a caller cannot forget to branch on it — the failure
 * mode of a boolean gate is a route that checks and then reads anyway.
 */
export function assertCanReadInitialPassword(role: string | null | undefined): void {
  if (!canReadInitialPassword(role)) throw new InitialPasswordForbiddenError(String(role ?? ""));
}

/**
 * Seal a password for storage.
 *
 * Refuses a value Turbify would reject or that breaks a form on its way to the new hire, because the
 * alternative is discovering it after the mailbox already exists — and sealing it would record a
 * password that never worked.
 */
export function sealInitialPassword(plaintext: string): string {
  if (!isUsableInitialPassword(plaintext)) {
    throw new InitialPasswordUnusableError(
      explainUnusableInitialPassword(plaintext) ?? "That initial password cannot be used.",
    );
  }
  return sealSecret(plaintext, SEAL_OPTIONS);
}

/**
 * Open a sealed password, for the System Administrator only.
 *
 * The role is checked BEFORE the seal is opened, so a forbidden request never decrypts anything.
 */
export function revealInitialPassword(sealed: string, role: string | null | undefined): string {
  assertCanReadInitialPassword(role);
  const value = String(sealed ?? "").trim();
  if (!value) {
    throw new InitialPasswordUnusableError("No initial password is recorded for that mailbox.");
  }
  return openSecret(value, SEAL_OPTIONS);
}

/** The row shape this module writes. Exported so the robot's runner cannot invent its own columns. */
export type InitialPasswordRecord = {
  sealed_initial_password: string;
  initial_password_set_at: string;
  initial_password_set_by_hr_id: string;
};

/**
 * Build the columns recording that a mailbox was given this password.
 *
 * Kept separate from the database call so the robot's runner can be tested without a client, and so
 * there is exactly one place that decides what those three columns hold.
 */
export function initialPasswordRecord(input: {
  plaintext: string;
  actor: string;
  at?: string;
}): InitialPasswordRecord {
  return {
    initial_password_set_at: input.at ?? new Date().toISOString(),
    initial_password_set_by_hr_id: input.actor,
    sealed_initial_password: sealInitialPassword(input.plaintext),
  };
}

/** Whether a role may see the password, for a caller that wants to render a reason rather than throw. */
export function initialPasswordAudienceDescription(): string {
  return (systemAdministratorRoles as readonly PhoenixRole[]).join(", ");
}
