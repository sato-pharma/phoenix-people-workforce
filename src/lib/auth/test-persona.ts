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
 *     (`is_test` rows), and a test account's every CRM SAVE is forced into it; since 2026-11-09 its
 *     every CRM READ is the real field force, as the mirrored person reads it (owner: "Real data
 *     everywhere"; `readWorldFor` / `territoryForView`, src/lib/phoenix-crm/server/access.ts).
 *   - Only a portal-shell role can be mirrored (`canBeMirrored`), so a test account is always in the
 *     employee portal and can never carry an admin-shell role, the Super Admin's least of all.
 *
 * A refusal is fail-CLOSED on purpose, and since 2026-11-06 it is the fallback, not the rule (owner:
 * "Runs fully, saves nothing"): a test account's write outside the lists below is MARKED by proxy.ts
 * and runs in full, with every database write and outgoing message answered in the server and none
 * kept (src/lib/auth/test-dry-run.ts). The refusal below still answers a write the proxy could not mark
 * or the fence could not prove live. Never add a path to the WRITABLE list to make it work — that list
 * writes for real; the dry run already reaches every other path.
 */

import { forbiddenError } from "@/lib/http/api-errors";
import type { AccessContext } from "@/lib/auth/permissions";
import { isPortalShellRole } from "@/lib/auth/portal-shell-roles";

/** Every test account's login id starts with this, so a test login is recognisable anywhere it shows. */
export const TEST_ACCOUNT_LOGIN_PREFIX = "TEST-";

/** What a test account reads when a save outside Phoenix CRM is refused. */
export const TEST_ACCOUNT_SAVE_REFUSAL =
  "This is a test account, and this save could not run as a test here. Nothing was changed.";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The API paths a test account may send a write to.
 *
 * `/api/phoenix-crm/` — every CRM write is forced into the test world by the CRM's own gates.
 * `/api/auth/` — sign-in, sign-out, the idle heartbeat, the password link and passkeys: each acts on
 * the test account's OWN login row, never on the person it mirrors.
 */
export const TEST_ACCOUNT_WRITABLE_PREFIXES = ["/api/phoenix-crm/", "/api/auth/"] as const;

/**
 * POST routes that RENDER and persist NOTHING — a test account reads the real person's own keepsake
 * through them (a milestone card, a spotlight sheet) exactly as she sees it, and writes no row, no
 * ledger and no audit. They are POST only because they can carry a large body (an uploaded photo, a
 * period), never because they mutate. This is NOT the writable list above: a test account still may
 * not WRITE as her anywhere outside it — these paths simply are not writes.
 *
 * 🔴 Every path here MUST be write-free. `tests/test-account-readonly-posts.test.ts` reads each route
 * back off disk and fails if it contains an insert/update/upsert/audit call, so a route that grows a
 * write drops out of the list rather than letting a test account write as the person it mirrors.
 */
export const TEST_ACCOUNT_READONLY_POSTS = [
  "/api/milestones/my-card",
  "/api/spotlight/me/sheet",
  // The expense form's location capture and its live pricing (owner, 2026-10-28: a test account
  // runs the whole expense form). Both price a trip and return it; neither stores anything.
  "/api/outstation/capture-location",
  "/api/outstation/calculate",
  // A rehearsed journey stop (owner, 2026-11-03): measured and priced as a real stop, kept nowhere.
  // Its Submit saved no claim, so this is the only way a test account reaches the stop at all.
  "/api/outstation/rehearse-journey-stop",
] as const;

/**
 * POST routes a test account RUNS IN FULL and that SAVE NOTHING for it (owner, 2026-10-28: "be able to
 * submit expense", answered "Runs fully, saves nothing"). Every check runs exactly as for the person it
 * mirrors — the location, the distance, the total, the duplicate-trip guard, the photo rules — and then
 * `submitOutstationRequest` (src/lib/outstation/service.ts) returns `dryRun: true` BEFORE its first
 * upload or row: no claim, no photo, no ticket, no payroll line, no email. Both paths end in that one
 * function. `tests/test-account-expense-dry-run.test.ts` pins the stop before the first write; a
 * route here that does not end in such a stop must never be added. Exact paths, never a prefix.
 */
export const TEST_ACCOUNT_DRY_RUN_POSTS = ["/api/outstation/submit", "/api/outstation/sync-offline"] as const;

/**
 * POST routes that write ONLY the test account's own diagnostic record, filed under ITS login and
 * flagged `is_test` — never under the employee it mirrors. `/api/errors/screen` is the picture of an
 * error or a block the test account met (owner, 23 Oct 2026): `screenOwnerFor` in
 * src/lib/error-monitor/user-error-screens.ts files it under the test login with `hr_id` empty, which
 * is exactly how the System Audit files a test account's errors. Exact paths, never a prefix.
 */
export const TEST_ACCOUNT_OWN_DIAGNOSTIC_POSTS = ["/api/errors/screen"] as const;

export function isTestAccount(access: Pick<AccessContext, "testPersona"> | null | undefined): boolean {
  return Boolean(access?.testPersona);
}

/** Whether a request with this method and path may run for a test account. */
export function testAccountMayRun(method: string | null | undefined, pathname: string | null | undefined): boolean {
  if (READ_METHODS.has(String(method ?? "GET").toUpperCase())) return true;
  const path = String(pathname ?? "");
  if ((TEST_ACCOUNT_READONLY_POSTS as readonly string[]).includes(path)) return true;
  if (String(method ?? "").toUpperCase() === "POST" && (TEST_ACCOUNT_DRY_RUN_POSTS as readonly string[]).includes(path)) return true;
  if (String(method ?? "").toUpperCase() === "POST" && (TEST_ACCOUNT_OWN_DIAGNOSTIC_POSTS as readonly string[]).includes(path)) return true;
  return TEST_ACCOUNT_WRITABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://phoenix.local").pathname;
  } catch {
    return "";
  }
}

/** Throws the refusal when a test account sends a write outside the lists above. */
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
