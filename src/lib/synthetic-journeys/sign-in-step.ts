/**
 * The sign-in step of the smoke suite, as the Synthetic Journeys page records it.
 *
 * Every other check runs through `runJourney` and reports its own code, page and role. The sign-in
 * step is a setup step (tests/synthetic/helpers/auth.setup.ts) that signs the Super Admin test account
 * in once for all of them; it never goes through `runJourney`, so its result carried the test
 * runner's internal code — "24f9ee9347290e4420b0-02d86117bff6d4aae124" — and no page. Its page and role
 * were filled in here when a report is saved; from 14 November 2026 its code is too, so its failed
 * records read "/login · sign-in" in the details panel instead of a 41-character hash.
 *
 * Kept free of imports so the tests can read it without a database.
 */

export const SIGN_IN_STEP_NAME = "authenticate as synthetic admin";
export const SIGN_IN_STEP_ID = "sign-in";
export const SIGN_IN_STEP_ROUTE = "/login";
export const SIGN_IN_STEP_ROLE = "Super Admin";

interface NamedResult {
  journeyId: string;
  journeyName: string;
  route: string;
  role: string;
}

/** Gives the sign-in step its own code, page and role. Every other check is returned untouched. */
export function normalizeSignInStep<T extends NamedResult>(result: T): T {
  if (result.journeyName !== SIGN_IN_STEP_NAME) return result;
  return { ...result, journeyId: SIGN_IN_STEP_ID, route: SIGN_IN_STEP_ROUTE, role: SIGN_IN_STEP_ROLE };
}
