/**
 * TEST ACCOUNTS — a login that lives inside a real employee's portal and never writes as her.
 *
 * Owner, 2026-09-27: "I choose this test employee and I choose his test manager … he really works as
 * if he is Aya Ibrahim, with her data, with her account, with her everything … but if I submit a visit
 * in Phoenix CRM by the test employee, it goes into his test data, not Aya Ibrahim's data … he will
 * always be in the employee portal, not the admin shell". So:
 *
 *   - A test account is an `app_auth_users` row with `is_test_persona = true`, its own login id
 *     (always `TEST-…`) and its own password, and NO `hr_id` of its own — so no lookup of a real
 *     person's account by HR id can ever land on it. `test_persona_of_hr_id` names the employee it
 *     mirrors; `role` is copied from that employee's account when the Super Admin points it.
 *   - At sign-in resolution (`resolveSessionState`, server.ts) its session becomes the MIRRORED
 *     person's: `hrId` and `role` are hers, so every page reads her data exactly as she sees it.
 *     `testPersona` is set on the access context, and that one field is what every guard reads.
 *   - Nothing it does may write as her. `resolveAccessContext` refuses every non-read request from a
 *     test account outside the two writable prefixes below, before the route runs; server actions
 *     are refused the same way. Phoenix CRM is the one module with a test world of its own
 *     (`is_test` rows), and a test account's every CRM read and save is forced into it
 *     (src/lib/phoenix-crm/server/access.ts).
 *   - Only a portal-shell role can be mirrored (`canBeMirrored`), so a test account is always in the
 *     employee portal and can never carry an admin-shell role, the Super Admin's least of all.
 *
 * A refusal is fail-CLOSED on purpose: a module that has no test world yet simply does not save for
 * a test account, and says so. Opening one more module to test accounts means giving that module a
 * test world first, never adding its path to the list below.
 */

import { forbiddenError } from "@/lib/http/api-errors";
import type { AccessContext } from "@/lib/auth/permissions";
import { isPortalShellRole } from "@/lib/auth/portal-shell-roles";

/** Every test account's login id starts with this, so a test login is recognisable anywhere it shows. */
export const TEST_ACCOUNT_LOGIN_PREFIX = "TEST-";

/** What a test account reads when a save outside Phoenix CRM is refused. */
export const TEST_ACCOUNT_SAVE_REFUSAL =
  "This is a test account: it opens everything the real person sees, but only Phoenix CRM saves, and only as test entries. Nothing was changed.";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The API paths a test account may send a write to.
 *
 * `/api/phoenix-crm/` — every CRM write is forced into the test world by the CRM's own gates.
 * `/api/auth/` — sign-in, sign-out, the idle heartbeat, the password link and passkeys: each acts on
 * the test account's OWN login row, never on the person it mirrors.
 */
export const TEST_ACCOUNT_WRITABLE_PREFIXES = ["/api/phoenix-crm/", "/api/auth/"] as const;

export function isTestAccount(access: Pick<AccessContext, "testPersona"> | null | undefined): boolean {
  return Boolean(access?.testPersona);
}

/** Whether a request with this method and path may run for a test account. */
export function testAccountMayRun(method: string | null | undefined, pathname: string | null | undefined): boolean {
  if (READ_METHODS.has(String(method ?? "GET").toUpperCase())) return true;
  const path = String(pathname ?? "");
  return TEST_ACCOUNT_WRITABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://phoenix.local").pathname;
  } catch {
    return "";
  }
}

/** Throws the refusal when a test account sends a write outside the writable prefixes. */
export function assertTestAccountMayRun(access: Pick<AccessContext, "testPersona">, request: Pick<Request, "method" | "url">): void {
  if (!isTestAccount(access)) return;
  if (testAccountMayRun(request.method, pathnameOf(request.url))) return;
  throw forbiddenError(TEST_ACCOUNT_SAVE_REFUSAL);
}

/** For a write that does not arrive as an API request (a server action): a test account never runs it. */
export function assertNotTestAccount(access: Pick<AccessContext, "testPersona">): void {
  if (isTestAccount(access)) throw forbiddenError(TEST_ACCOUNT_SAVE_REFUSAL);
}

/** Only an employee-portal role can be mirrored, which is what keeps every test account in the portal. */
export function canBeMirrored(role: string | null | undefined): boolean {
  return isPortalShellRole(role);
}

/**
 * A test account's login id, upper-cased, or null when it is not one: `TEST-` and then 1–30 letters,
 * digits or dashes. The prefix is what keeps it from ever colliding with a real HR id or login.
 */
export function normalizeTestAccountLoginId(value: unknown): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text.startsWith(TEST_ACCOUNT_LOGIN_PREFIX)) return null;
  return /^TEST-[A-Z0-9][A-Z0-9-]{0,29}$/.test(text) ? text : null;
}
