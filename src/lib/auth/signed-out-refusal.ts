/**
 * A permission refusal whose caller is not signed in at all — the session ended, or there never was one.
 *
 * `assertPermission` throws this for the guest context (`source === "guest"`), which is what
 * `resolveAccessContext` quietly hands back when the session cookie is missing, expired or rejected.
 * Its message still begins "Forbidden:" and it is still a plain `Error` to every route, so the ~550
 * route handlers that key their 403 on that prefix (`isForbiddenError`) answer exactly as before.
 *
 * What it adds is a way for a module's ONE failure handler to tell "your sign-in ended" apart from
 * "you are not allowed" without touching each route — `phoenixCrmFailure` answers it 401, which the
 * Phoenix CRM client already turns into "You are signed out. Sign in again". Before it, a district
 * manager whose session reached its absolute expiry mid-plan (24 Oct 2026, 02:35:58 Cairo) had his
 * next half-day save refused as a permissions problem, 24 seconds later, and signed in again 6
 * seconds after that.
 *
 * It CANNOT widen access: it is only ever thrown where the request is already being refused.
 */
export class SignedOutRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignedOutRefusal";
  }
}

export function isSignedOutRefusal(error: unknown): error is SignedOutRefusal {
  return error instanceof SignedOutRefusal;
}
