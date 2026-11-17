/**
 * RFC 7009 token revocation for the ChatGPT connector. Always answers 200 (the standard says an
 * unknown token is not an error); a known token ends its whole family — access and refresh.
 */
import { connectorOAuth, limitConnectorDoor, oauthErrorResponse, oauthJson, readOAuthForm } from "@/lib/chatgpt-connector/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await limitConnectorDoor(request, "revoke", 60, 60_000);
    await connectorOAuth().revoke(await readOAuthForm(request));
    return oauthJson({});
  } catch (error) {
    return oauthErrorResponse(error, "chatgpt_connector_revoke_failed");
  }
}
