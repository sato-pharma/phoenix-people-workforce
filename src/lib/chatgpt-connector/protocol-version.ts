/**
 * ChatGPT speaks a newer Model Context Protocol revision than the SDK knows.
 *
 * Measured on production, 17 Nov 2026 14:03 Cairo, the owner's first connection: ChatGPT signed in
 * cleanly, then sent its next request with `MCP-Protocol-Version: 2026-07-28`. The SDK (1.32.2, the
 * newest published) knows revisions up to 2025-11-25 and answers any later one with HTTP 400 "Bad
 * Request: Unsupported protocol version" — so ChatGPT was connected and could not list a single tool.
 *
 * The messages Phoenix answers (initialize, tools/list, tools/call) are the same in every revision the
 * SDK lists, and the server already tells the client which revision it speaks in its initialize answer.
 * So a version header the SDK does not know is read as the newest one it does, instead of refusing the
 * whole call. A version it knows is left exactly as sent.
 */
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

const HEADER = "mcp-protocol-version";

/** The request unchanged, or a copy whose unknown protocol version header reads the newest one the SDK knows. */
export async function withKnownProtocolVersion(request: Request): Promise<Request> {
  const sent = request.headers.get(HEADER);
  if (sent === null || SUPPORTED_PROTOCOL_VERSIONS.includes(sent)) return request;
  const headers = new Headers(request.headers);
  headers.set(HEADER, LATEST_PROTOCOL_VERSION);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  return new Request(request.url, { method: request.method, headers, body });
}
