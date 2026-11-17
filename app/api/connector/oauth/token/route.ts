/**
 * The ChatGPT connector's token endpoint (RFC 6749): a one-time code + PKCE verifier for the first
 * token pair, or a refresh token for the next one (each refresh token is good once; a replay revokes
 * the whole family). Every exchange re-checks the account live. 60 requests a minute per address.
 */
import { connectorOAuth, limitConnectorDoor, oauthErrorResponse, oauthJson, readOAuthForm } from "@/lib/chatgpt-connector/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await limitConnectorDoor(request, "token", 60, 60_000);
    return oauthJson(await connectorOAuth().token(await readOAuthForm(request)));
  } catch (error) {
    return oauthErrorResponse(error, "chatgpt_connector_token_failed");
  }
}
