/**
 * RFC 8414 authorization-server metadata for the ChatGPT connector's sign-in. Answered at
 * /.well-known/oauth-authorization-server (and any path-suffixed spelling a client tries). Public,
 * no data: it lists the endpoints, PKCE S256 and the one read-only scope.
 */
import { oauthJson } from "@/lib/chatgpt-connector/http";
import { authorizationServerMetadata } from "@/lib/chatgpt-connector/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return oauthJson(authorizationServerMetadata());
}
