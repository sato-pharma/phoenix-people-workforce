import { createAccessContext, type AccessContext } from "./permissions.ts";

export {
  createSessionToken,
  getCookieValue,
  phoenixSessionCookieName,
  sessionIdleTimeoutSecondsForRole,
  verifySessionToken,
  type SessionPayload,
} from "./session-token.ts";
import { verifySessionToken } from "./session-token.ts";

export function accessContextFromSessionToken(token: string | null | undefined): AccessContext | null {
  const payload = verifySessionToken(token);
  if (!payload) return null;

  return createAccessContext({
    hrId: payload.hrId,
    loginId: payload.loginId,
    role: payload.role,
    source: "session",
  });
}
