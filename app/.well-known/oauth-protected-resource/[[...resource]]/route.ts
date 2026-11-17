/**
 * RFC 9728 protected-resource metadata for the ChatGPT connector's /api/mcp. Answered at both
 * /.well-known/oauth-protected-resource and /.well-known/oauth-protected-resource/api/mcp, because
 * clients try the path-suffixed spelling first. Public, no data: it only names the sign-in server.
 */
import { oauthJson } from "@/lib/chatgpt-connector/http";
import { protectedResourceMetadata } from "@/lib/chatgpt-connector/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ resource?: string[] }> }) {
  const { resource } = await context.params;
  const suffix = (resource ?? []).join("/");
  if (suffix && suffix !== "api/mcp") return oauthJson({ error: "not_found" }, 404);
  return oauthJson(protectedResourceMetadata());
}
