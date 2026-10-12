// Owner-only LIVE authorization for the isolated MCP reader (infra/phoenix-mcp).
//
// POST { subject, nonce } -> { nonce, identity } | { nonce, identity: null }
//
// Off unless PHOENIX_MCP_SOURCE_ENABLED is exactly "true". Authenticated by its own bearer secret —
// there is deliberately NO development bypass and NO fallback to CRON_SECRET: an unset secret refuses
// everyone. Every input is read from the database on every call (src/lib/mcp-source/live-authorization.ts),
// and any source error answers 503, which the reader treats as "unavailable" and never as "no denials".

import { NextResponse } from "next/server";

import { loadPermissionMatrixUncached } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { requiredTokenAuthorized } from "@/lib/security/cron-auth";
import { createSupabaseLiveSources, loadLiveIdentity } from "@/lib/mcp-source/live-authorization";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const headers = { "cache-control": "no-store, max-age=0", pragma: "no-cache" };
const refuse = (status: number, error: string) => NextResponse.json({ error }, { status, headers });

export async function POST(request: Request) {
  if (process.env.PHOENIX_MCP_SOURCE_ENABLED !== "true") return refuse(404, "not_found");
  const secret = process.env.PHOENIX_MCP_SOURCE_AUTHORIZATION_KEY ?? "";
  const owner = process.env.PHOENIX_MCP_OWNER_SUBJECT ?? "";
  if (secret.length < 32 || !UUID.test(owner)) return refuse(503, "unavailable");
  // The secret was checked above, so this never throws; it is the repo's one bearer comparison.
  if (!requiredTokenAuthorized(request, secret, "mcp_source_unconfigured", "MCP source is not configured.")) return refuse(401, "unauthorized");

  let body: { subject?: unknown; nonce?: unknown };
  try {
    const text = await request.text();
    if (text.length > 1024) return refuse(413, "too_large");
    body = JSON.parse(text);
  } catch {
    return refuse(400, "bad_request");
  }
  const subject = typeof body.subject === "string" ? body.subject : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (!UUID.test(subject) || !UUID.test(nonce)) return refuse(400, "bad_request");
  // Single-owner by construction: any other subject is refused before a database read.
  if (subject.toLowerCase() !== owner.toLowerCase()) return refuse(403, "forbidden");

  try {
    const identity = await loadLiveIdentity(subject, createSupabaseLiveSources(getSupabaseAdmin(), loadPermissionMatrixUncached));
    return NextResponse.json({ nonce, identity }, { status: 200, headers });
  } catch (error) {
    logError("MCP source live authorization could not be decided", { labels: { event: "mcp_source_authorize_failed" }, error });
    return refuse(503, "unavailable");
  }
}
