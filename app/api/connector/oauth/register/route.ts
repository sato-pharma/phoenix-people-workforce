/**
 * RFC 7591 dynamic client registration for the ChatGPT connector. Public by design (ChatGPT
 * registers itself), so it accepts ONLY ChatGPT's own return addresses, public clients only, and is
 * limited to 20 registrations an hour per address. A registration opens nothing on its own: the
 * owner or the CEO must still sign in to Phoenix and press Allow.
 */
import { connectorOAuth, limitConnectorDoor, oauthErrorResponse, oauthJson } from "@/lib/chatgpt-connector/http";
import { OAuthError } from "@/lib/chatgpt-connector/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await limitConnectorDoor(request, "register", 20, 3_600_000);
    const text = await request.text();
    if (text.length > 16_384) throw new OAuthError("invalid_client_metadata", "The registration is too large.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError("invalid_client_metadata", "The registration is not valid JSON.");
    }
    return oauthJson(await connectorOAuth().register(body), 201);
  } catch (error) {
    return oauthErrorResponse(error, "chatgpt_connector_register_failed");
  }
}
