/**
 * The "Allow" / "Cancel" button on /connector/authorize. A same-origin POST from the signed-in
 * person's own browser (CSRF-protected like every other mutation), never reachable by ChatGPT.
 *
 * Allow: re-validates the authorize request, checks the person is the owner or the CEO on a real
 * session (not a test account, not View as Seat), reads their live session_version, mints the
 * one-time code and answers the ChatGPT address to send the browser back to. The page navigates
 * there itself, because the site's CSP (`form-action 'self'`) blocks a form redirecting off-site.
 */
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { resolveAccessContext } from "@/lib/auth/server";
import { connectorOAuth, NO_STORE, oauthErrorResponse } from "@/lib/chatgpt-connector/http";
import { readLiveAccount } from "@/lib/chatgpt-connector/identity";
import { isConnectorRole, OAuthError } from "@/lib/chatgpt-connector/oauth";
import { afterResponse } from "@/lib/http/after-response";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTHORIZE_KEYS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

export async function POST(request: Request) {
  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;
  try {
    const access = await resolveAccessContext(request);
    if (!access.loginId || access.source !== "session") throw new OAuthError("login_required", "Sign in to Phoenix first.", 401);
    if (access.testPersona || access.seatView) throw new OAuthError("access_denied", "Leave the test account or View as Seat before connecting ChatGPT.", 403);
    if (!isConnectorRole(access.role)) throw new OAuthError("access_denied", "Only the owner and the CEO can connect ChatGPT.", 403);

    const body = (await request.json().catch(() => null)) as { decision?: unknown; params?: Record<string, unknown> } | null;
    const params: Record<string, string | undefined> = {};
    for (const key of AUTHORIZE_KEYS) {
      const value = body?.params?.[key];
      if (typeof value === "string" && value.length <= 2_048) params[key] = value;
    }
    const oauth = connectorOAuth();
    const validated = await oauth.validateAuthorizeRequest(params);

    if (body?.decision !== "allow") {
      return NextResponse.json({ redirectTo: oauth.deny(validated) }, { headers: NO_STORE });
    }

    const account = await readLiveAccount(access.loginId);
    if (!account) throw new OAuthError("access_denied", "The Phoenix account could not be found.", 403);
    const subject = {
      loginId: access.loginId,
      // The record's own spelling ("B-10"), not the session's canonical key ("b-10").
      hrId: account.hr_id ?? access.hrId ?? null,
      role: access.role,
      sessionVersion: Number(account.session_version ?? 0),
    };
    const redirectTo = await oauth.approve(validated, subject);
    const loginId = access.loginId;
    await afterResponse("chatgpt_connector_approved_audit", () =>
      writeAuditLog({
        actorLoginId: loginId,
        entityType: "chatgpt_connector",
        entityId: "connected",
        summary: `ChatGPT was allowed into Phoenix as ${subject.role}`,
        // The registrant-typed name proves nothing; the client id and the address the one-time code was sent to
        // are what say WHICH connection this was, and what to list in PHOENIX_CHATGPT_CLIENT_IDS or revoke.
        newValues: { clientName: validated.clientName, clientId: validated.clientId, redirectUri: validated.redirectUri, role: subject.role },
      }),
    );
    return NextResponse.json({ redirectTo }, { headers: NO_STORE });
  } catch (error) {
    return oauthErrorResponse(error, "chatgpt_connector_approve_failed");
  }
}
