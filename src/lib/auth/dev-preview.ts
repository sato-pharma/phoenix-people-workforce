import { randomUUID } from "crypto";

import {
  createSessionToken,
  verifySessionToken,
} from "./session-token.ts";
import {
  createAccessContext,
  parseRoleStrict,
  type AccessContext,
  type PhoenixRole,
} from "./permissions.ts";

export const phoenixDevPreviewCookieName = "phoenix_dev_preview";
const devPreviewSessionSeconds = 8 * 60 * 60;
const devPreviewSessionPrefix = "dev-preview:";

export function createDevPreviewSessionToken(input: {
  hrId: string | null;
  loginId: string;
  role: PhoenixRole;
}) {
  return createSessionToken({
    hrId: input.hrId,
    loginId: input.loginId,
    maxAgeSeconds: devPreviewSessionSeconds,
    role: input.role,
    sessionId: `${devPreviewSessionPrefix}${randomUUID()}`,
    sessionVersion: 0,
  });
}

export function devPreviewCookieMaxAgeSeconds() {
  return devPreviewSessionSeconds;
}

export function accessContextFromDevPreviewToken(
  token: string | null | undefined,
): AccessContext | null {
  const payload = verifySessionToken(token);
  if (!payload || !payload.sid.startsWith(devPreviewSessionPrefix) || payload.ver !== 0) {
    return null;
  }

  return createAccessContext({
    hrId: payload.hrId,
    loginId: payload.loginId,
    role: parseRoleStrict(payload.role),
    source: "dev-header",
  });
}
